import crypto from "node:crypto";
import { AgencyError } from "./errors.js";

export interface SendEmailInput {
  organizationId: string;
  recipient: string;
  subject: string;
  bodyText: string;
}

export interface EmailSendResult {
  providerMessageId: string;
}

export interface EmailSender {
  isConfigured(organizationId?: string): Promise<boolean> | boolean;
  sendEmail(input: SendEmailInput): Promise<EmailSendResult>;
}

export class EmailProviderError extends AgencyError {
  constructor(
    message: string,
    readonly providerCode = "EMAIL_PROVIDER_ERROR",
  ) {
    super("EMAIL_PROVIDER_ERROR", message, { providerCode });
    this.name = "EmailProviderError";
  }
}

export interface EnvEmailConfig {
  webhookUrl?: string;
  webhookSecret?: string;
  resendApiKey?: string;
  fromAddress?: string;
}

/**
 * Governed outbound email transport supporting Resend REST API or a configured HTTP relay webhook.
 */
export class EnvEmailSender implements EmailSender {
  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly resendApiKey: string;
  private readonly fromAddress: string;

  constructor(
    config: EnvEmailConfig = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.webhookUrl = (config.webhookUrl ?? "").trim();
    this.webhookSecret = (config.webhookSecret ?? "").trim();
    this.resendApiKey = (config.resendApiKey ?? "").trim();
    this.fromAddress = (config.fromAddress ?? "").trim();
  }

  isConfigured(): boolean {
    return Boolean(this.webhookUrl || (this.resendApiKey && this.fromAddress));
  }

  status(): { configured: boolean; provider: string; from: string } {
    const configured = this.isConfigured();
    const provider = this.resendApiKey && this.fromAddress ? "resend" : this.webhookUrl ? "webhook" : "none";
    return { configured, provider, from: this.fromAddress };
  }

  async sendEmail(input: SendEmailInput): Promise<EmailSendResult> {
    if (!this.isConfigured()) {
      throw new AgencyError(
        "EMAIL_NOT_CONFIGURED",
        "Outbound email transport is not configured (set AGENCY_EMAIL_RESEND_API_KEY + AGENCY_EMAIL_FROM or AGENCY_EMAIL_WEBHOOK_URL).",
      );
    }

    if (this.resendApiKey && this.fromAddress) {
      const res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: [input.recipient],
          subject: input.subject,
          text: input.bodyText,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok) {
        throw new EmailProviderError(body.message || `Resend HTTP ${res.status}`, `RESEND_${res.status}`);
      }
      return { providerMessageId: body.id || `resend_${crypto.randomUUID()}` };
    }

    const res = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.webhookSecret ? { authorization: `Bearer ${this.webhookSecret}` } : {}),
      },
      body: JSON.stringify({
        organizationId: input.organizationId,
        from: this.fromAddress || undefined,
        to: input.recipient,
        subject: input.subject,
        text: input.bodyText,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string; error?: string };
    if (!res.ok) {
      throw new EmailProviderError(body.error || `Email webhook HTTP ${res.status}`, `WEBHOOK_${res.status}`);
    }
    return { providerMessageId: body.id || body.messageId || `email_${crypto.randomUUID()}` };
  }
}
