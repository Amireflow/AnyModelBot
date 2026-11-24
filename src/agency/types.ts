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

export type WhatsAppOutboxStatus = "queued" | "sending" | "accepted" | "failed" | "submission_unknown" | "cancelled";
export type WhatsAppProviderStatus = "" | "sent" | "delivered" | "read" | "failed";

export interface WhatsAppWebhookProcessResult {
  accepted: number;
  duplicates: number;
  statusEvents: number;
  inboundMessages: number;
  optOuts: number;
  unmatchedOptOuts: number;
}

export interface WhatsAppOutboxMessage {
  id: string;
  organizationId: string;
  contactId: string;
  channel: "whatsapp";
  purpose: string;
  recipient: string;
  templateName: string;
  language: string;
  templateComponents: Record<string, unknown>[];
  approvalId: string;
  approvalPayloadHash: string;
  consentId: string;
  status: WhatsAppOutboxStatus;
  providerMessageId: string;
  failureCode: string;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
  submittedAt: number;
  providerStatus: WhatsAppProviderStatus;
  providerStatusAt: number;
  providerErrorCode: string;
}

export interface QueueWhatsAppTemplateInput {
  approvalId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
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


export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export interface CompanySearchFilters {
  query?: string; industry?: string; countryCode?: string; city?: string;
  status?: Company["status"]; limit?: number; offset?: number;
}
export interface ContactSearchFilters {
  companyId?: string; query?: string; status?: Contact["status"]; limit?: number; offset?: number;
}
export interface LeadSearchFilters {
  companyId?: string; stage?: LeadStage; query?: string; limit?: number; offset?: number;
}
export type ResearchDomain = "company" | "industry" | "financial" | "news";
export interface ResearchAssessment {
  modelVersion: string;
  score: number;
  status: "insufficient" | "developing" | "review_ready";
  evidenceCount: number;
  coveredDomains: ResearchDomain[];
  missingDomains: ResearchDomain[];
  coverage: Record<ResearchDomain, number>;
  distinctSourceHosts: number;
  averageConfidence: number;
  freshEvidenceCount: number;
  breakdown: { coverage: number; sourceDiversity: number; confidence: number; freshness: number };
  reasons: string[];
  recommendations: string[];
  assessedAt: number;
}

export interface QualificationProfile {
  organizationId: string;
  targetIndustries: string[];
  targetCountries: string[];
  excludedIndustries: string[];
  requiredEvidenceDomains: ResearchDomain[];
  requireWebsite: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateQualificationProfileInput {
  targetIndustries?: string[];
  targetCountries?: string[];
  excludedIndustries?: string[];
  requiredEvidenceDomains?: ResearchDomain[];
  requireWebsite?: boolean;
}

export type QualificationStatus = "unconfigured" | "insufficient_data" | "strong_fit" | "review" | "weak_fit";
export type QualificationCriterionId =
  | "target_industry" | "target_country" | "excluded_industry" | "website"
  | "evidence_company" | "evidence_industry" | "evidence_financial" | "evidence_news";

export interface QualificationCriterion {
  id: QualificationCriterionId;
  result: "met" | "not_met" | "unknown";
  weight: number;
  points: number;
  expected: string[];
  observed: string;
}

export interface CompanyQualificationAssessment {
  modelVersion: string;
  companyId: string;
  status: QualificationStatus;
  score: number | null;
  coverage: number;
  configuredWeight: number;
  evaluatedWeight: number;
  criteria: QualificationCriterion[];
  blockingReasons: QualificationCriterionId[];
  assessedAt: number;
}

export interface AgencyDashboard {
  companyCount: number; contactCount: number; leadCount: number;
  openLeadCount: number; wonLeadCount: number; stageCounts: Record<LeadStage, number>;
}

export type CommercialChannel = "whatsapp" | "email" | "web_form" | "social" | "phone" | "other";
export type ConversationStatus = "open" | "awaiting_reply" | "handoff_human" | "opted_out" | "closed";
export type MessageDirection = "inbound" | "outbound" | "internal_note";
export type CommercialSignal = "general" | "interested" | "objection" | "pricing_question" | "opt_out" | "needs_human";

export interface CommercialConversation {
  id: string;
  organizationId: string;
  leadId: string;
  contactId: string;
  channel: CommercialChannel;
  subject: string;
  status: ConversationStatus;
  nextFollowUpAt: number;
  handoffReason: string;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMessage {
  id: string;
  organizationId: string;
  conversationId: string;
  direction: MessageDirection;
  body: string;
  signal: CommercialSignal;
  authorId: string;
  createdAt: number;
}

export interface CreateConversationInput {
  leadId: string;
  contactId?: string;
  channel: CommercialChannel;
  subject: string;
  nextFollowUpAt?: number;
}

export interface AddConversationMessageInput {
  direction: MessageDirection;
  body: string;
  signal?: CommercialSignal;
  nextFollowUpAt?: number;
}

export type SolutionType =
  | "vitrine" | "ecommerce" | "web_app" | "mobile_app"
  | "business_platform" | "internal_tool" | "automation" | "maintenance";

export interface NeedsQualification {
  organizationId: string;
  leadId: string;
  problemStatement: string;
  targetUsers: string;
  solutionType: SolutionType;
  mustHaveFeatures: string[];
  niceToHaveFeatures: string[];
  constraints: string[];
  desiredTimeline: string;
  budgetMin: number;
  budgetMax: number;
  assumptions: string[];
  unknowns: string[];
  risks: string[];
  recommendedSolution: string;
  clientConfirmed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertNeedsQualificationInput {
  problemStatement: string;
  targetUsers?: string;
  solutionType: SolutionType;
  mustHaveFeatures?: string[];
  niceToHaveFeatures?: string[];
  constraints?: string[];
  desiredTimeline?: string;
  budgetMin?: number;
  budgetMax?: number;
  assumptions?: string[];
  unknowns?: string[];
  risks?: string[];
  recommendedSolution?: string;
  clientConfirmed?: boolean;
}

export interface ServiceCatalogItem {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  category: SolutionType;
  description: string;
  defaultScope: string;
  exclusions: string[];
  estimatedDays: number;
  priceMin: number;
  priceBase: number;
  priceMax: number;
  estimatedCost: number;
  paymentTerms: string;
  maintenanceTerms: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCatalogItemInput {
  code: string;
  name: string;
  category: SolutionType;
  description: string;
  defaultScope?: string;
  exclusions?: string[];
  estimatedDays: number;
  priceMin: number;
  priceBase: number;
  priceMax: number;
  estimatedCost: number;
  paymentTerms?: string;
  maintenanceTerms?: string;
  active?: boolean;
}

export interface UpdateCatalogItemInput {
  name?: string;
  category?: SolutionType;
  description?: string;
  defaultScope?: string;
  exclusions?: string[];
  estimatedDays?: number;
  priceMin?: number;
  priceBase?: number;
  priceMax?: number;
  estimatedCost?: number;
  paymentTerms?: string;
  maintenanceTerms?: string;
  active?: boolean;
}

export interface CommercialRules {
  organizationId: string;
  minMarginPct: number;
  maxAutonomousDiscountPct: number;
  defaultDepositPct: number;
  requireOwnerApprovalAboveAmount: number;
  paymentTermsDefault: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateCommercialRulesInput {
  minMarginPct?: number;
  maxAutonomousDiscountPct?: number;
  defaultDepositPct?: number;
  requireOwnerApprovalAboveAmount?: number;
  paymentTermsDefault?: string;
}

export type QuoteTier = "essential" | "standard" | "advanced" | "custom";
export type QuoteStatus = "draft" | "pending_approval" | "approved" | "sent" | "accepted" | "rejected" | "expired";

export interface QuoteLineItem {
  label: string;
  description?: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  estimatedDays: number;
  optional?: boolean;
}

export interface QuoteTotals {
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  netTotal: number;
  estimatedCost: number;
  grossMargin: number;
  marginPct: number;
  totalDays: number;
  rangeLow: number;
  rangeHigh: number;
}

export type NegotiationViolation =
  | "DISCOUNT_EXCEEDS_AUTONOMOUS_LIMIT"
  | "BELOW_MIN_MARGIN"
  | "BELOW_PRICE_FLOOR"
  | "EXCEEDS_OWNER_THRESHOLD";

export type NegotiationAction =
  | "reduce_scope"
  | "phase_delivery"
  | "adjust_payment_schedule"
  | "request_owner_approval";

export interface NegotiationEvaluation {
  requestedDiscountPct: number;
  priceFloor: number;
  resultingTotal: number;
  resultingMargin: number;
  resultingMarginPct: number;
  allowedAutonomously: boolean;
  requiresOwnerApproval: boolean;
  violations: NegotiationViolation[];
  recommendedActions: NegotiationAction[];
}

export interface TieredProposalOption {
  tier: "essential" | "standard" | "advanced";
  title: string;
  scopeSummary: string;
  deliverables: string[];
  exclusions: string[];
  estimatedDays: number;
  price: number;
  estimatedCost: number;
  marginPct: number;
}

export interface Quote {
  id: string;
  organizationId: string;
  leadId: string;
  version: number;
  title: string;
  tier: QuoteTier;
  currency: string;
  lines: QuoteLineItem[];
  exclusions: string[];
  paymentTerms: string;
  deliveryDays: number;
  discountPct: number;
  subtotal: number;
  discountAmount: number;
  netTotal: number;
  estimatedCost: number;
  grossMargin: number;
  marginPct: number;
  rangeLow: number;
  rangeHigh: number;
  status: QuoteStatus;
  approvalId: string;
  validUntil: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateQuoteInput {
  leadId: string;
  title: string;
  tier?: QuoteTier;
  lines: QuoteLineItem[];
  exclusions?: string[];
  paymentTerms?: string;
  discountPct?: number;
  uncertaintyPct?: number;
  validUntil?: number;
}

export type ContractStatus = "draft" | "pending_approval" | "approved" | "sent" | "signed" | "cancelled";
export type DepositStatus = "unpaid" | "paid";

export interface Contract {
  id: string;
  organizationId: string;
  leadId: string;
  quoteId: string;
  title: string;
  scopeSummary: string;
  deliverables: string[];
  paymentTerms: string;
  totalAmount: number;
  depositAmount: number;
  depositStatus: DepositStatus;
  depositReference: string;
  currency: string;
  status: ContractStatus;
  approvalId: string;
  signedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateContractInput {
  quoteId: string;
  title?: string;
  scopeSummary?: string;
  deliverables?: string[];
  paymentTerms?: string;
  depositAmount?: number;
}
