import crypto, { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { registerSecret } from "../log.js";
import { AgencyError } from "./errors.js";
import type { WhatsAppSecretBox } from "./whatsapp-secrets.js";

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
  provider?: "resend" | "webhook";
  webhookUrl?: string;
  webhookSecret?: string;
  resendApiKey?: string;
  fromAddress?: string;
  replyTo?: string;
}

export interface EmailSecretConfig {
  organizationId: string;
  provider: "resend" | "webhook";
  resendApiKey?: string;
  fromAddress?: string;
  replyTo?: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

interface EmailSecretFileShape {
  version: 1;
  algorithm: "electron-safe-storage" | "local-aes-256-gcm";
  ciphertext: string;
}

function requiredEmailStr(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new TypeError(`${name} has an invalid length`);
  }
  return normalized;
}

function optionalEmailStr(value: unknown, name: string, min: number, max: number): string | undefined {
  if (value == null || value === "") return undefined;
  return requiredEmailStr(value, name, min, max);
}

export function normalizeEmailSecretConfig(value: unknown, expectedOrganizationId?: string): EmailSecretConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Email credentials must be an object");
  }
  const source = value as Record<string, unknown>;
  const allowed = ["organizationId", "provider", "resendApiKey", "fromAddress", "replyTo", "webhookUrl", "webhookSecret"];
  if (Object.keys(source).some((key) => !allowed.includes(key))) {
    throw new TypeError("Unsupported email credential field");
  }
  const organizationId = requiredEmailStr(source.organizationId, "organizationId", 1, 160);
  if (expectedOrganizationId && organizationId !== expectedOrganizationId) {
    throw new TypeError("Email credentials must be bound to the requested organization");
  }
  const providerRaw = String(source.provider ?? (source.webhookUrl ? "webhook" : "resend")).trim().toLowerCase();
  if (providerRaw !== "resend" && providerRaw !== "webhook") {
    throw new TypeError("Email provider must be resend or webhook");
  }
  const config: EmailSecretConfig = {
    organizationId,
    provider: providerRaw,
    resendApiKey: optionalEmailStr(source.resendApiKey, "resendApiKey", 8, 512),
    fromAddress: optionalEmailStr(source.fromAddress, "fromAddress", 3, 254),
    replyTo: optionalEmailStr(source.replyTo, "replyTo", 3, 254),
    webhookUrl: optionalEmailStr(source.webhookUrl, "webhookUrl", 8, 500),
    webhookSecret: optionalEmailStr(source.webhookSecret, "webhookSecret", 8, 512),
  };
  if (config.provider === "resend" && (!config.resendApiKey || !config.fromAddress)) {
    throw new TypeError("Resend provider requires resendApiKey and fromAddress");
  }
  if (config.provider === "webhook") {
    if (!config.webhookUrl) throw new TypeError("Webhook provider requires webhookUrl");
    let parsed: URL;
    try { parsed = new URL(config.webhookUrl); }
    catch { throw new TypeError("Invalid webhookUrl"); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new TypeError("webhookUrl must use http or https");
    }
  }
  return config;
}

export class EmailSecretsFile {
  constructor(readonly file: string, private readonly box: WhatsAppSecretBox) {}

  static at(dataDir: string, box: WhatsAppSecretBox): EmailSecretsFile {
    return new EmailSecretsFile(path.join(dataDir, "email-secrets.json"), box);
  }

  async availability(): Promise<{ available: boolean; backend: string; reason?: string }> {
    return this.box.status();
  }

  status(): { storage: "electron-safe-storage" | "local-aes-256-gcm"; backend: string; hasStoredSecret: boolean } {
    const storage = this.box.algorithm ?? "electron-safe-storage";
    const backend = storage === "local-aes-256-gcm" ? "AES-256-GCM (local vault)" : "OS secure storage";
    return { storage, backend, hasStoredSecret: fs.existsSync(this.file) };
  }

  async get(): Promise<EmailSecretConfig | undefined> {
    if (!fs.existsSync(this.file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<EmailSecretFileShape>;
    const expectedAlg = this.box.algorithm ?? "electron-safe-storage";
    if (raw.version !== 1 || raw.algorithm !== expectedAlg || typeof raw.ciphertext !== "string") {
      throw new Error("Email secure credential file has an unsupported format");
    }
    const status = await this.box.status();
    if (!status.available) throw new Error(status.reason || "Secure storage is unavailable");
    const decrypted = await this.box.decrypt(Buffer.from(raw.ciphertext, "base64"));
    const parsed = JSON.parse(decrypted.plaintext) as unknown;
    const config = normalizeEmailSecretConfig(parsed);
    this.register(config);
    return config;
  }

  async set(value: unknown, expectedOrganizationId?: string): Promise<void> {
    const config = normalizeEmailSecretConfig(value, expectedOrganizationId);
    await this.write(config);
    this.register(config);
  }

  clear(): void {
    if (fs.existsSync(this.file)) fs.rmSync(this.file, { force: true });
  }

  private register(config: EmailSecretConfig): void {
    if (config.resendApiKey) registerSecret(config.resendApiKey);
    if (config.webhookSecret) registerSecret(config.webhookSecret);
  }

  private async write(config: EmailSecretConfig): Promise<void> {
    const status = await this.box.status();
    if (!status.available) throw new Error(status.reason || "Secure storage is unavailable; email secrets were not saved");
    const ciphertext = await this.box.encrypt(JSON.stringify(config));
    const shape: EmailSecretFileShape = {
      version: 1,
      algorithm: this.box.algorithm ?? "electron-safe-storage",
      ciphertext: ciphertext.toString("base64"),
    };
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(shape) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }
}

/**
 * Governed outbound email transport supporting Resend REST API or a configured HTTP relay webhook.
 */
export class EnvEmailSender implements EmailSender {
  private providerOverride?: "resend" | "webhook";
  private webhookUrl = "";
  private webhookSecret = "";
  private resendApiKey = "";
  private fromAddress = "";
  private replyTo = "";

  constructor(
    config: EnvEmailConfig = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.setConfig(config);
  }

  setConfig(config: EnvEmailConfig = {}): void {
    this.providerOverride = config.provider;
    this.webhookUrl = (config.webhookUrl ?? "").trim();
    this.webhookSecret = (config.webhookSecret ?? "").trim();
    this.resendApiKey = (config.resendApiKey ?? "").trim();
    this.fromAddress = (config.fromAddress ?? "").trim();
    this.replyTo = (config.replyTo ?? "").trim();
  }

  private activeProvider(): "resend" | "webhook" | "none" {
    if (this.providerOverride === "resend" && this.resendApiKey && this.fromAddress) return "resend";
    if (this.providerOverride === "webhook" && this.webhookUrl) return "webhook";
    if (this.resendApiKey && this.fromAddress) return "resend";
    if (this.webhookUrl) return "webhook";
    return "none";
  }

  isConfigured(): boolean {
    return this.activeProvider() !== "none";
  }

  status(): {
    configured: boolean;
    provider: string;
    from: string;
    replyTo: string;
    webhookUrl: string;
    hasApiKey: boolean;
    hasWebhookSecret: boolean;
  } {
    const provider = this.activeProvider();
    return {
      configured: provider !== "none",
      provider,
      from: this.fromAddress,
      replyTo: this.replyTo,
      webhookUrl: this.webhookUrl,
      hasApiKey: Boolean(this.resendApiKey),
      hasWebhookSecret: Boolean(this.webhookSecret),
    };
  }

  async sendEmail(input: SendEmailInput): Promise<EmailSendResult> {
    const provider = this.activeProvider();
    if (provider === "none") {
      throw new AgencyError(
        "EMAIL_NOT_CONFIGURED",
        "Outbound email transport is not configured (set AGENCY_EMAIL_RESEND_API_KEY + AGENCY_EMAIL_FROM or configure Email in CRM).",
      );
    }

    if (provider === "resend") {
      const res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: [input.recipient],
          ...(this.replyTo ? { reply_to: this.replyTo } : {}),
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
        replyTo: this.replyTo || undefined,
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
