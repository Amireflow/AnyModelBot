import { AgencyError } from "./errors.js";

export function requiredText(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== "string") throw new AgencyError("VALIDATION_ERROR", `${field} must be text`);
  const result = value.trim();
  if (!result) throw new AgencyError("VALIDATION_ERROR", `${field} is required`);
  if (result.length > maxLength) throw new AgencyError("VALIDATION_ERROR", `${field} is too long`, { maxLength });
  return result;
}

export function optionalText(value: unknown, field: string, maxLength = 500): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new AgencyError("VALIDATION_ERROR", `${field} must be text`);
  const result = value.trim();
  if (result.length > maxLength) throw new AgencyError("VALIDATION_ERROR", `${field} is too long`, { maxLength });
  return result;
}

export function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

export function countryCode(value: unknown): string {
  const code = optionalText(value, "countryCode", 2).toUpperCase();
  if (code && !/^[A-Z]{2}$/.test(code)) throw new AgencyError("VALIDATION_ERROR", "countryCode must be an ISO 3166-1 alpha-2 code");
  return code;
}

export function currencyCode(value: unknown): string {
  const code = optionalText(value, "currency", 3).toUpperCase();
  if (code && !/^[A-Z]{3}$/.test(code)) throw new AgencyError("VALIDATION_ERROR", "currency must be a three-letter currency code");
  return code || "XOF";
}

export function websiteUrl(value: unknown): string {
  const raw = optionalText(value, "website", 2048);
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AgencyError("VALIDATION_ERROR", "website must be a valid absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AgencyError("VALIDATION_ERROR", "website must use HTTP or HTTPS");
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new AgencyError("VALIDATION_ERROR", "website URL is not allowed");
  }
  return parsed.toString();
}

export function emailAddress(value: unknown): string {
  const email = optionalText(value, "email", 320).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AgencyError("VALIDATION_ERROR", "email is not valid");
  }
  return email;
}

export function confidenceValue(value: unknown): number {
  if (value == null) return 0.5;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new AgencyError("VALIDATION_ERROR", "confidence must be between 0 and 1");
  }
  return value;
}

export function positiveTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AgencyError("VALIDATION_ERROR", `${field} must be a positive timestamp`);
  }
  return value;
}
