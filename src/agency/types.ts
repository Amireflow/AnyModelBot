export type AgencyRole = "owner" | "admin" | "member" | "client" | "auditor";
export type OrganizationStatus = "active" | "suspended";
export type LeadStage =
  | "new"
  | "researching"
  | "qualified"
  | "contact_pending"
  | "contacted"
  | "engaged"
  | "opportunity"
  | "proposal"
  | "won"
  | "lost"
  | "archived";
export type ConsentStatus = "granted" | "withdrawn";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";
export type ApprovalAction =
  | "send_message"
  | "send_quote"
  | "send_contract"
  | "sign_contract"
  | "spend_money"
  | "grant_access"
  | "delete_data"
  | "deploy_production"
  | "change_scope"
  | "other_external_action";

export interface Organization {
  id: string;
  name: string;
  countryCode: string;
  currency: string;
  status: OrganizationStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Membership {
  organizationId: string;
  userId: string;
  role: AgencyRole;
  createdAt: number;
}

export interface Company {
  id: string;
  organizationId: string;
  name: string;
  normalizedName: string;
  website: string;
  industry: string;
  countryCode: string;
  city: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface Contact {
  id: string;
  organizationId: string;
  companyId: string;
  displayName: string;
  role: string;
  email: string;
  phone: string;
  preferredChannel: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface Lead {
  id: string;
  organizationId: string;
  companyId: string;
  contactId: string;
  source: string;
  notes: string;
  stage: LeadStage;
  createdAt: number;
  updatedAt: number;
}

export interface Evidence {
  id: string;
  organizationId: string;
  companyId: string;
  leadId: string;
  evidenceType: string;
  sourceUrl: string;
  summary: string;
  contentHash: string;
  confidence: number;
  observedAt: number;
  collectedAt: number;
}

export interface ConsentRecord {
  id: string;
  organizationId: string;
  contactId: string;
  channel: string;
  purpose: string;
  status: ConsentStatus;
  source: string;
  proof: string;
  textVersion: string;
  expiresAt: number;
  createdAt: number;
}

export interface Approval {
  id: string;
  organizationId: string;
  projectId: string;
  requestedBy: string;
  action: ApprovalAction;
  resourceType: string;
  resourceId: string;
  reason: string;
  payloadJson: string;
  payloadHash: string;
  status: ApprovalStatus;
  expiresAt: number;
  decidedBy: string;
  decisionReason: string;
  createdAt: number;
  decidedAt: number;
}

export interface AuditEvent {
  id: string;
  organizationId: string;
  sequence: number;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  payloadJson: string;
  previousHash: string;
  hash: string;
  createdAt: number;
}

export interface CreateOrganizationInput {
  name: string;
  countryCode?: string;
  currency?: string;
}

export interface CreateCompanyInput {
  name: string;
  website?: string;
  industry?: string;
  countryCode?: string;
  city?: string;
}

export interface CreateContactInput {
  companyId: string;
  displayName: string;
  role?: string;
  email?: string;
  phone?: string;
  preferredChannel?: string;
}

export interface CreateLeadInput {
  companyId: string;
  contactId?: string;
  source?: string;
  notes?: string;
}

export interface AddEvidenceInput {
  companyId: string;
  leadId?: string;
  evidenceType: string;
  sourceUrl: string;
  summary: string;
  contentHash?: string;
  confidence?: number;
  observedAt?: number;
}

export interface RecordConsentInput {
  contactId: string;
  channel: string;
  purpose: string;
  status: ConsentStatus;
  source: string;
  proof: string;
  textVersion?: string;
  expiresAt?: number;
}

export interface RequestApprovalInput {
  projectId?: string;
  action: ApprovalAction;
  resourceType: string;
  resourceId: string;
  reason: string;
  payload: Record<string, unknown>;
  expiresAt?: number;
}

export interface AuditVerification {
  valid: boolean;
  eventsChecked: number;
  failedSequence?: number;
}
