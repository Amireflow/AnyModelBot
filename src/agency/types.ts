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

export interface UpdateCompanyInput {
  name?: string;
  website?: string;
  industry?: string;
  countryCode?: string;
  city?: string;
  status?: "active" | "archived";
}

export interface CreateContactInput {
  companyId: string;
  displayName: string;
  role?: string;
  email?: string;
  phone?: string;
  preferredChannel?: string;
}

export interface UpdateContactInput {
  displayName?: string;
  role?: string;
  email?: string;
  phone?: string;
  preferredChannel?: string;
  status?: "active" | "archived";
}

export interface CreateLeadInput {
  companyId: string;
  contactId?: string;
  source?: string;
  notes?: string;
}

export interface UpdateLeadInput {
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

export interface UpdateQuoteInput {
  title?: string;
  tier?: QuoteTier;
  lines?: QuoteLineItem[];
  exclusions?: string[];
  paymentTerms?: string;
  discountPct?: number;
  uncertaintyPct?: number;
  validUntil?: number;
}

export type EmailOutboxStatus = "queued" | "sending" | "sent" | "failed" | "cancelled";

export interface EmailOutboxMessage {
  id: string;
  organizationId: string;
  contactId: string;
  channel: "email";
  purpose: string;
  recipient: string;
  subject: string;
  bodyText: string;
  approvalId: string;
  approvalPayloadHash: string;
  consentId: string;
  status: EmailOutboxStatus;
  providerMessageId: string;
  failureCode: string;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
  submittedAt: number;
}

export interface QueueEmailInput {
  approvalId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface ProspectCandidate {
  name: string;
  website: string;
  domain: string;
  snippet: string;
  sourceUrl: string;
  backend: string;
  duplicateCompanyId?: string;
}

export interface WebsiteAuditResult {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  usesHttps: boolean;
  responseTimeMs: number;
  title: string;
  metaDescription: string;
  hasViewportMeta: boolean;
  generatorMeta: string;
  detectedEmails: string[];
  detectedPhones: string[];
  socialLinks: string[];
  issues: string[];
  observedAt: number;
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

export type ProjectStatus =
  | "handoff_pending"
  | "scoping"
  | "in_progress"
  | "qa_review"
  | "ready_for_delivery"
  | "delivered"
  | "accepted"
  | "maintenance"
  | "archived";

export type ProjectLotStatus = "pending" | "in_progress" | "in_qa" | "verified" | "done" | "blocked";
export type ScopeChangeStatus = "proposed" | "approval_requested" | "approved" | "rejected" | "applied";
export type QaCategory = "functional" | "technical" | "ui_ux" | "security";
export type QaCheckStatus = "pending" | "passed" | "failed" | "blocked";
export type DeliveryStatus = "prepared" | "approval_requested" | "deployed" | "accepted" | "rejected";
export type FollowUpType = "satisfaction" | "maintenance" | "upsell" | "support" | "case_study";
export type FollowUpStatus = "scheduled" | "contacted" | "completed" | "dismissed";
export type AgencyMissionStatus = "planned" | "running" | "blocked" | "completed" | "failed";

export type AgencyAgentRole =
  | "prospecting"
  | "qualification"
  | "commercial"
  | "estimator"
  | "project_manager"
  | "architect"
  | "developer"
  | "ui_ux"
  | "qa_functional"
  | "qa_technical"
  | "qa_ui_ux"
  | "qa_security"
  | "retention";

export interface Project {
  id: string;
  organizationId: string;
  leadId: string;
  contractId: string;
  title: string;
  status: ProjectStatus;
  workspacePath: string;
  localPath: string;
  technicalSpecs: string;
  targetStack: string[];
  budgetAmount: number;
  currency: string;
  estimatedDays: number;
  handoffSummary: string;
  handoffAt: number;
  deliveredAt: number | null;
  acceptedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectLot {
  id: string;
  organizationId: string;
  projectId: string;
  lotOrder: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  ownerRole: AgencyAgentRole;
  status: ProjectLotStatus;
  estimatedHours: number;
  actualHours: number;
  evidenceSummary: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScopeChange {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  description: string;
  budgetDelta: number;
  daysDelta: number;
  status: ScopeChangeStatus;
  approvalId: string | null;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface QaCheck {
  id: string;
  organizationId: string;
  projectId: string;
  lotId: string | null;
  category: QaCategory;
  title: string;
  status: QaCheckStatus;
  evidence: string;
  findings: string;
  checkedBy: string;
  checkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface QaGateEvaluation {
  readyForDelivery: boolean;
  totalLots: number;
  verifiedLots: number;
  totalChecks: number;
  passedCategories: QaCategory[];
  missingCategories: QaCategory[];
  failedChecks: number;
  blockedChecks: number;
  missingEvidenceChecks: number;
  blockers: string[];
}

export interface ProjectDelivery {
  id: string;
  organizationId: string;
  projectId: string;
  version: number;
  status: DeliveryStatus;
  environmentUrl: string;
  releaseNotes: string;
  qaSummary: string;
  approvalId: string | null;
  clientFeedback: string;
  deployedAt: number | null;
  acceptedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ClientFollowUp {
  id: string;
  organizationId: string;
  projectId: string;
  leadId: string;
  type: FollowUpType;
  status: FollowUpStatus;
  dueAt: number;
  notes: string;
  outcome: string;
  createdBy: string;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentProfile {
  role: AgencyAgentRole;
  name: string;
  mission: string;
  canWriteCode: boolean;
  canApproveExternal: boolean;
  independentFromBuild: boolean;
  defaultTools: string[];
}

export interface DetectedDevTool {
  id: string;
  name: string;
  command: string;
  category: "ide" | "cli_agent" | "runtime" | "vcs";
  available: boolean;
  version: string;
}

export interface AgencyMission {
  id: string;
  organizationId: string;
  projectId: string | null;
  leadId: string | null;
  agentRole: AgencyAgentRole;
  title: string;
  objective: string;
  status: AgencyMissionStatus;
  preferredTool: string;
  brief: string;
  outputSummary: string;
  evidencePaths: string[];
  startedAt: number | null;
  completedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgencyMetrics {
  organizationId: string;
  leadsTotal: number;
  leadsQualified: number;
  quotesSent: number;
  quotesAccepted: number;
  contractsSigned: number;
  projectsTotal: number;
  projectsDelivered: number;
  projectsAccepted: number;
  quoteAcceptanceRate: number;
  qaFirstPassRate: number;
  signedRevenue: number;
  pipelineValue: number;
  collectedDeposits: number;
  outstandingBalance: number;
  avgDealSize: number;
  leadToWinRate: number;
  avgMarginPct: number;
  pendingApprovalsCount: number;
  pendingFollowUps: number;
  openMissions: number;
}

export interface CreateProjectInput {
  contractId: string;
  title?: string;
  workspacePath?: string;
  localPath?: string;
  technicalSpecs?: string;
  targetStack?: string[];
  estimatedDays?: number;
  handoffSummary?: string;
}

export interface CreateDirectProjectInput {
  title: string;
  clientName?: string;
  companyId?: string;
  technicalSpecs?: string;
  targetStack?: string[];
  budgetAmount?: number;
  estimatedDays?: number;
  workspacePath?: string;
  localPath?: string;
}

export interface UpdateProjectWorkspaceInput {
  localPath: string;
}

export interface CreateProjectLotInput {
  lotOrder?: number;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  dependencies?: string[];
  ownerRole?: AgencyAgentRole;
  estimatedHours?: number;
}

export interface UpdateProjectLotInput {
  status?: ProjectLotStatus;
  actualHours?: number;
  evidenceSummary?: string;
  ownerRole?: AgencyAgentRole;
}

export interface ProposeScopeChangeInput {
  title: string;
  description?: string;
  budgetDelta?: number;
  daysDelta?: number;
}

export interface RecordQaCheckInput {
  lotId?: string;
  category: QaCategory;
  title: string;
  status: QaCheckStatus;
  evidence?: string;
  findings?: string;
}

export interface PrepareDeliveryInput {
  environmentUrl?: string;
  releaseNotes?: string;
}

export interface ScheduleFollowUpInput {
  leadId?: string;
  type: FollowUpType;
  dueAt: number;
  notes?: string;
}

export interface CreateMissionInput {
  projectId?: string;
  leadId?: string;
  agentRole: AgencyAgentRole;
  title: string;
  objective?: string;
  preferredTool?: string;
}

export type AgentAutonomyMode = "draft_only" | "supervised" | "autonomous_internal";

export interface AgentConfig {
  organizationId: string;
  role: AgencyAgentRole;
  enabled: boolean;
  displayName: string;
  model: string;
  autonomyMode: AgentAutonomyMode;
  systemPrompt: string;
  rules: string[];
  skills: string[];
  allowedTools: string[];
  maxSteps: number;
  updatedAt: number;
}

export interface UpdateAgentConfigInput {
  enabled?: boolean;
  displayName?: string;
  model?: string;
  autonomyMode?: AgentAutonomyMode;
  systemPrompt?: string;
  rules?: string[];
  skills?: string[];
  allowedTools?: string[];
  maxSteps?: number;
}

export type InvoiceStatus = "draft" | "issued" | "paid" | "cancelled";

export interface Invoice {
  id: string;
  organizationId: string;
  contractId: string;
  invoiceNumber: string;
  milestoneLabel: string;
  percentage: number;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  dueDate: number;
  paidAt: number;
  paymentReference: string;
  createdAt: number;
  updatedAt: number;
}

export interface InvoiceMilestoneInput {
  label: string;
  percentage: number;
  dueInDays?: number;
}

export interface StudioSnapshotEntry {
  commitHash: string;
  timestamp: number;
  message: string;
}

export interface ConfiguredAgentProfile extends AgentProfile {
  config: AgentConfig;
  customized: boolean;
}

export type AgencyDeletableEntityType =
  | "company"
  | "contact"
  | "lead"
  | "evidence"
  | "quote"
  | "catalog_item"
  | "mission"
  | "followup";

export interface DeleteImpactCounts {
  contacts: number;
  leads: number;
  evidence: number;
  conversations: number;
  messages: number;
  quotes: number;
  needs: number;
}

export interface DeleteImpactPreview {
  entityType: AgencyDeletableEntityType;
  entityId: string;
  label: string;
  canDelete: boolean;
  requiresNameConfirmation: boolean;
  confirmationTarget: string;
  blockers: string[];
  willDelete: DeleteImpactCounts;
  recommendArchive: boolean;
}

export interface DeleteEntityOptions {
  confirm?: boolean;
  confirmName?: string;
  cascade?: boolean;
  reason?: string;
}

export interface DeleteEntityResult {
  entityType: AgencyDeletableEntityType;
  entityId: string;
  label: string;
  deleted: DeleteImpactCounts;
}



