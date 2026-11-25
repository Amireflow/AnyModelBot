export type AgencyErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INVALID_TRANSITION"
  | "CONSENT_REQUIRED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_ALREADY_DECIDED"
  | "APPROVAL_PAYLOAD_MISMATCH"
  | "ORGANIZATION_SUSPENDED"
  | "WHATSAPP_NOT_CONFIGURED"
  | "WHATSAPP_PROVIDER_ERROR"
  | "WHATSAPP_SUBMISSION_UNKNOWN"
  | "EMAIL_NOT_CONFIGURED"
  | "EMAIL_PROVIDER_ERROR";

export class AgencyError extends Error {
  constructor(
    readonly code: AgencyErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgencyError";
  }
}
