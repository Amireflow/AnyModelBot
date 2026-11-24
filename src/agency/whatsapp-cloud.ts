import { createHmac, timingSafeEqual } from "node:crypto";

export interface WhatsAppTemplateSendInput {
  organizationId: string;
  recipient: string;
  templateName: string;
  language: string;
  components: Record<string, unknown>[];
}

export interface WhatsAppTemplateSendResult {
  providerMessageId: string;
}

export interface WhatsAppTemplateSender {
  isConfigured(organizationId?: string): boolean | Promise<boolean>;
  sendTemplateMessage(input: WhatsAppTemplateSendInput): Promise<WhatsAppTemplateSendResult>;
}

export class WhatsAppProviderError extends Error {
  constructor(readonly code: string, readonly uncertain: boolean) {
    super("WhatsApp Cloud API request failed");
    this.name = "WhatsAppProviderError";
  }
}

export interface WhatsAppCloudApiConfig {
  organizationId?: string;
  accessToken?: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  apiVersion?: string;
  timeoutMs?: number;
}

/**
 * Official Meta WhatsApp Business Platform Cloud API adapter.
 * Tokens are supplied by the host process and are never persisted by this class.
 * A template must be found with APPROVED status before any send request is attempted.
 */
export class WhatsAppCloudApiClient implements WhatsAppTemplateSender {
  private organizationId = "";
  private accessToken = "";
  private phoneNumberId = "";
  private businessAccountId = "";
  private apiVersion = "v27.0";
  private readonly timeoutMs: number;

  constructor(config: WhatsAppCloudApiConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 20_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) {
      throw new TypeError("WhatsApp request timeout must be between 1000 and 120000 ms");
    }
    this.setCredentials(config);
  }

  setCredentials(config: WhatsAppCloudApiConfig = {}): void {
    const version = config.apiVersion?.trim() || "v27.0";
    if (!/^v\d+\.\d+$/.test(version)) throw new TypeError("Invalid WhatsApp Graph API version");
    this.organizationId = config.organizationId?.trim() ?? "";
    this.accessToken = config.accessToken?.trim() ?? "";
    this.phoneNumberId = config.phoneNumberId?.trim() ?? "";
    this.businessAccountId = config.businessAccountId?.trim() ?? "";
    this.apiVersion = version;
  }

  isConfigured(organizationId?: string): boolean {
    return !!this.organizationId && (!organizationId || this.organizationId===organizationId)
      && !!this.accessToken
      && /^\d{5,30}$/.test(this.phoneNumberId)
      && /^\d{5,30}$/.test(this.businessAccountId);
  }

  async sendTemplateMessage(input: WhatsAppTemplateSendInput): Promise<WhatsAppTemplateSendResult> {
    if (!this.isConfigured(input.organizationId)) throw new WhatsAppProviderError("WHATSAPP_NOT_CONFIGURED", false);
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
    };
    const templateUrl = new URL(`https://graph.facebook.com/${this.apiVersion}/${this.businessAccountId}/message_templates`);
    templateUrl.searchParams.set("name",input.templateName);
    templateUrl.searchParams.set("fields","name,language,status,id");

    let templateResponse: Response;
    try {
      templateResponse = await fetch(templateUrl, {
        method:"GET",headers,signal:AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // The lookup happens before sending, so a lookup failure has no ambiguous send result.
      throw new WhatsAppProviderError("TEMPLATE_LOOKUP_NETWORK_FAILURE", false);
    }
    let templatePayload: unknown;
    try { templatePayload = await templateResponse.json(); } catch { templatePayload = null; }
    if (!templateResponse.ok) {
      throw new WhatsAppProviderError(`TEMPLATE_LOOKUP_HTTP_${templateResponse.status}`,false);
    }
    const templateRoot = templatePayload && typeof templatePayload === "object"
      ? templatePayload as Record<string, unknown> : {};
    const templates = Array.isArray(templateRoot.data) ? templateRoot.data : [];
    const approved = templates.some((item) => {
      if (!item || typeof item !== "object") return false;
      const value=item as Record<string,unknown>;
      return value.name===input.templateName && value.language===input.language && value.status==="APPROVED";
    });
    if (!approved) throw new WhatsAppProviderError("TEMPLATE_NOT_APPROVED",false);

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.recipient.replace(/^\+/, ""),
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.language },
        components: input.components,
      },
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",headers,body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // A timeout or connection drop can happen after Meta has accepted the request.
      // Do not retry automatically: the provider outcome is ambiguous.
      throw new WhatsAppProviderError("NETWORK_OR_TIMEOUT", true);
    }

    let payload: unknown;
    try { payload = await response.json(); } catch { payload = null; }
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (!response.ok) {
      const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : {};
      const code = typeof error.code === "number" || typeof error.code === "string"
        ? String(error.code) : `HTTP_${response.status}`;
      throw new WhatsAppProviderError(`META_${code}`, response.status >= 500 || response.status === 429);
    }

    const messages = Array.isArray(root.messages) ? root.messages : [];
    const first = messages[0] && typeof messages[0] === "object"
      ? messages[0] as Record<string, unknown> : {};
    if (typeof first.id !== "string" || !first.id.trim()) {
      throw new WhatsAppProviderError("INVALID_PROVIDER_RESPONSE", true);
    }
    return { providerMessageId: first.id };
  }
}

/**
 * Meta signs webhook bodies with HMAC-SHA256 in X-Hub-Signature-256.
 * The caller must pass the exact raw request bytes, before JSON parsing.
 */
export function verifyMetaWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
