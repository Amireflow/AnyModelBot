import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AgencyAgentRole, AgencyMission, AgencyMissionStatus, AgencyRole,
  Approval, ApprovalAction, ApprovalStatus, AuditEvent, ClientFollowUp,
  CommercialChannel, CommercialConversation, CommercialRules, CommercialSignal,
  Company, ConsentRecord, Contact, Contract, ContractStatus, ConversationMessage,
  ConversationStatus, DeliveryStatus, DepositStatus, EmailOutboxMessage, EmailOutboxStatus,
  Evidence, FollowUpStatus, FollowUpType, Lead, LeadStage, Membership, MessageDirection,
  NeedsQualification, Organization, OrganizationStatus, Project, ProjectDelivery, ProjectLot,
  ProjectLotStatus, ProjectStatus, QaCategory, QaCheck, QaCheckStatus,
  QualificationProfile, Quote, QuoteLineItem, QuoteStatus, QuoteTier,
  ResearchDomain, ScopeChange, ScopeChangeStatus, ServiceCatalogItem, SolutionType,
} from "./types.js";

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agency_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'XOF',
  status TEXT NOT NULL CHECK(status IN ('active','suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_memberships (
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','client','auditor')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS agency_companies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('active','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_companies_org_name ON agency_companies(organization_id, normalized_name);

CREATE TABLE IF NOT EXISTS agency_contacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  company_id TEXT NOT NULL REFERENCES agency_companies(id),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  preferred_channel TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('active','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_contacts_org_company ON agency_contacts(organization_id, company_id);

CREATE TABLE IF NOT EXISTS agency_leads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  company_id TEXT NOT NULL REFERENCES agency_companies(id),
  contact_id TEXT REFERENCES agency_contacts(id),
  source TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL CHECK(stage IN ('new','researching','qualified','contact_pending','contacted','engaged','opportunity','proposal','won','lost','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_leads_org_stage ON agency_leads(organization_id, stage, updated_at);

CREATE TABLE IF NOT EXISTS agency_evidence (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  company_id TEXT NOT NULL REFERENCES agency_companies(id),
  lead_id TEXT REFERENCES agency_leads(id),
  evidence_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  summary TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  observed_at INTEGER NOT NULL,
  collected_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_evidence_org_company ON agency_evidence(organization_id, company_id, collected_at);
CREATE INDEX IF NOT EXISTS agency_evidence_org_company_hash ON agency_evidence(organization_id, company_id, content_hash);

CREATE TABLE IF NOT EXISTS agency_qualification_profiles (
  organization_id TEXT PRIMARY KEY REFERENCES agency_organizations(id),
  target_industries_json TEXT NOT NULL DEFAULT '[]',
  target_countries_json TEXT NOT NULL DEFAULT '[]',
  excluded_industries_json TEXT NOT NULL DEFAULT '[]',
  required_evidence_domains_json TEXT NOT NULL DEFAULT '[]',
  require_website INTEGER NOT NULL DEFAULT 0 CHECK(require_website IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_consents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  contact_id TEXT NOT NULL REFERENCES agency_contacts(id),
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('granted','withdrawn')),
  source TEXT NOT NULL,
  proof TEXT NOT NULL,
  text_version TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_consents_lookup ON agency_consents(organization_id, contact_id, channel, purpose);

CREATE TABLE IF NOT EXISTS agency_approvals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  project_id TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','cancelled')),
  expires_at INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT NOT NULL DEFAULT '',
  decision_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  decided_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agency_approvals_org_status ON agency_approvals(organization_id, status, created_at);

CREATE TABLE IF NOT EXISTS agency_whatsapp_outbox (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  contact_id TEXT NOT NULL REFERENCES agency_contacts(id),
  channel TEXT NOT NULL CHECK(channel='whatsapp'),
  purpose TEXT NOT NULL,
  recipient TEXT NOT NULL,
  template_name TEXT NOT NULL,
  language TEXT NOT NULL,
  template_components_json TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES agency_approvals(id),
  approval_payload_hash TEXT NOT NULL,
  consent_id TEXT NOT NULL REFERENCES agency_consents(id),
  status TEXT NOT NULL CHECK(status IN ('queued','sending','accepted','failed','submission_unknown','cancelled')),
  provider_message_id TEXT NOT NULL DEFAULT '',
  failure_code TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL DEFAULT 0,
  provider_status TEXT NOT NULL DEFAULT '',
  provider_status_at INTEGER NOT NULL DEFAULT 0,
  provider_error_code TEXT NOT NULL DEFAULT '',
  UNIQUE(organization_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS agency_whatsapp_outbox_org_status
  ON agency_whatsapp_outbox(organization_id,status,created_at);

CREATE TABLE IF NOT EXISTS agency_whatsapp_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  event_key TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('status','inbound_message')),
  provider_status TEXT NOT NULL DEFAULT '',
  provider_error_code TEXT NOT NULL DEFAULT '',
  event_at INTEGER NOT NULL,
  contact_id TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  UNIQUE(organization_id,event_key)
);
CREATE INDEX IF NOT EXISTS agency_whatsapp_webhook_provider
  ON agency_whatsapp_webhook_events(organization_id,provider_message_id,event_type);
CREATE TRIGGER IF NOT EXISTS agency_whatsapp_webhook_no_update
BEFORE UPDATE ON agency_whatsapp_webhook_events
BEGIN SELECT RAISE(ABORT, 'agency WhatsApp webhook events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS agency_whatsapp_webhook_no_delete
BEFORE DELETE ON agency_whatsapp_webhook_events
BEGIN SELECT RAISE(ABORT, 'agency WhatsApp webhook events are immutable'); END;

CREATE TABLE IF NOT EXISTS agency_audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_audit_org_sequence ON agency_audit_events(organization_id, sequence);
CREATE TRIGGER IF NOT EXISTS agency_audit_no_update
BEFORE UPDATE ON agency_audit_events
BEGIN SELECT RAISE(ABORT, 'agency audit events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS agency_audit_no_delete
BEFORE DELETE ON agency_audit_events
BEGIN SELECT RAISE(ABORT, 'agency audit events are immutable'); END;

CREATE TABLE IF NOT EXISTS agency_idempotency (
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(organization_id, scope, idempotency_key)
);

-- Defense in depth: referenced records must belong to the same organization.
CREATE TRIGGER IF NOT EXISTS agency_contacts_tenant_guard_insert
BEFORE INSERT ON agency_contacts
WHEN NOT EXISTS (SELECT 1 FROM agency_companies WHERE id=NEW.company_id AND organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'agency contact organization mismatch'); END;
CREATE TRIGGER IF NOT EXISTS agency_contacts_tenant_guard_update
BEFORE UPDATE OF organization_id,company_id ON agency_contacts
WHEN NOT EXISTS (SELECT 1 FROM agency_companies WHERE id=NEW.company_id AND organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'agency contact organization mismatch'); END;
CREATE TRIGGER IF NOT EXISTS agency_leads_tenant_guard_insert
BEFORE INSERT ON agency_leads
WHEN NOT EXISTS (SELECT 1 FROM agency_companies WHERE id=NEW.company_id AND organization_id=NEW.organization_id)
  OR (NEW.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agency_contacts WHERE id=NEW.contact_id AND organization_id=NEW.organization_id AND company_id=NEW.company_id
  ))
BEGIN SELECT RAISE(ABORT, 'agency lead organization mismatch'); END;
CREATE TRIGGER IF NOT EXISTS agency_leads_tenant_guard_update
BEFORE UPDATE OF organization_id,company_id,contact_id ON agency_leads
WHEN NOT EXISTS (SELECT 1 FROM agency_companies WHERE id=NEW.company_id AND organization_id=NEW.organization_id)
  OR (NEW.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agency_contacts WHERE id=NEW.contact_id AND organization_id=NEW.organization_id AND company_id=NEW.company_id
  ))
BEGIN SELECT RAISE(ABORT, 'agency lead organization mismatch'); END;
CREATE TRIGGER IF NOT EXISTS agency_evidence_tenant_guard_insert
BEFORE INSERT ON agency_evidence
WHEN NOT EXISTS (SELECT 1 FROM agency_companies WHERE id=NEW.company_id AND organization_id=NEW.organization_id)
  OR (NEW.lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agency_leads WHERE id=NEW.lead_id AND organization_id=NEW.organization_id AND company_id=NEW.company_id
  ))
BEGIN SELECT RAISE(ABORT, 'agency evidence organization mismatch'); END;
CREATE TRIGGER IF NOT EXISTS agency_evidence_tenant_guard_update
BEFORE UPDATE OF organization_id,company_id,lead_id ON agency_evidence
WHEN NOT EXISTS (SELECT 1 FROM agency_companies WHERE id=NEW.company_id AND organization_id=NEW.organization_id)
  OR (NEW.lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agency_leads WHERE id=NEW.lead_id AND organization_id=NEW.organization_id AND company_id=NEW.company_id
  ))
BEGIN SELECT RAISE(ABORT, 'agency evidence organization mismatch'); END;
CREATE TRIGGER IF NOT EXISTS agency_consents_tenant_guard_insert
BEFORE INSERT ON agency_consents
WHEN NOT EXISTS (SELECT 1 FROM agency_contacts WHERE id=NEW.contact_id AND organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'agency consent organization mismatch'); END;
CREATE TRIGGER IF NOT EXISTS agency_consents_tenant_guard_update
BEFORE UPDATE OF organization_id,contact_id ON agency_consents
WHEN NOT EXISTS (SELECT 1 FROM agency_contacts WHERE id=NEW.contact_id AND organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'agency consent organization mismatch'); END;
CREATE TRIGGER IF NOT EXISTS agency_consents_no_update
BEFORE UPDATE ON agency_consents
BEGIN SELECT RAISE(ABORT, 'agency consent records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS agency_consents_no_delete
BEFORE DELETE ON agency_consents
BEGIN SELECT RAISE(ABORT, 'agency consent records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS agency_whatsapp_outbox_tenant_guard_insert
BEFORE INSERT ON agency_whatsapp_outbox
WHEN NOT EXISTS (SELECT 1 FROM agency_contacts WHERE id=NEW.contact_id AND organization_id=NEW.organization_id)
  OR NOT EXISTS (
    SELECT 1 FROM agency_consents
    WHERE id=NEW.consent_id AND organization_id=NEW.organization_id AND contact_id=NEW.contact_id
      AND channel=NEW.channel AND purpose=NEW.purpose AND status='granted'
      AND source<>'' AND length(proof)>=8 AND text_version<>''
      AND (expires_at=0 OR expires_at>NEW.created_at)
      AND NOT EXISTS (
        SELECT 1 FROM agency_consents newer
        WHERE newer.organization_id=agency_consents.organization_id
          AND newer.contact_id=agency_consents.contact_id
          AND newer.channel=agency_consents.channel AND newer.purpose=agency_consents.purpose
          AND newer.rowid>agency_consents.rowid
      )
  )
  OR NOT EXISTS (
    SELECT 1 FROM agency_approvals
    WHERE id=NEW.approval_id AND organization_id=NEW.organization_id
      AND action='send_message' AND resource_type='whatsapp_template' AND resource_id=NEW.contact_id
      AND status='approved' AND payload_hash=NEW.approval_payload_hash
      AND (expires_at=0 OR expires_at>NEW.created_at)
  )
BEGIN SELECT RAISE(ABORT, 'agency WhatsApp outbox invariant failed'); END;
CREATE TRIGGER IF NOT EXISTS agency_whatsapp_outbox_no_delete
BEFORE DELETE ON agency_whatsapp_outbox
BEGIN SELECT RAISE(ABORT, 'agency WhatsApp outbox records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS agency_whatsapp_outbox_payload_immutable
BEFORE UPDATE OF organization_id,contact_id,channel,purpose,recipient,template_name,language,
  template_components_json,approval_id,approval_payload_hash,consent_id,idempotency_key,created_at
ON agency_whatsapp_outbox
BEGIN SELECT RAISE(ABORT, 'agency WhatsApp message payload is immutable'); END;

CREATE TABLE IF NOT EXISTS agency_conversations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  lead_id TEXT NOT NULL REFERENCES agency_leads(id),
  contact_id TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL CHECK(channel IN ('whatsapp','email','web_form','social','phone','other')),
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','awaiting_reply','handoff_human','opted_out','closed')),
  next_follow_up_at INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT NOT NULL DEFAULT '',
  last_message_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_conversations_org_lead ON agency_conversations(organization_id, lead_id, updated_at);
CREATE TRIGGER IF NOT EXISTS agency_conversations_tenant_guard_insert
BEFORE INSERT ON agency_conversations
WHEN NOT EXISTS (SELECT 1 FROM agency_leads WHERE id=NEW.lead_id AND organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'agency conversation organization mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_conversation_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  conversation_id TEXT NOT NULL REFERENCES agency_conversations(id),
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound','internal_note')),
  body TEXT NOT NULL,
  signal TEXT NOT NULL DEFAULT 'general',
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_conversation_messages_conv ON agency_conversation_messages(organization_id, conversation_id, created_at);
CREATE TRIGGER IF NOT EXISTS agency_conversation_messages_tenant_guard
BEFORE INSERT ON agency_conversation_messages
WHEN NOT EXISTS (SELECT 1 FROM agency_conversations WHERE id=NEW.conversation_id AND organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'agency conversation message organization mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_needs_qualifications (
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  lead_id TEXT NOT NULL REFERENCES agency_leads(id),
  problem_statement TEXT NOT NULL,
  target_users TEXT NOT NULL DEFAULT '',
  solution_type TEXT NOT NULL CHECK(solution_type IN ('vitrine','ecommerce','web_app','mobile_app','business_platform','internal_tool','automation','maintenance')),
  must_have_json TEXT NOT NULL DEFAULT '[]',
  nice_to_have_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  desired_timeline TEXT NOT NULL DEFAULT '',
  budget_min REAL NOT NULL DEFAULT 0,
  budget_max REAL NOT NULL DEFAULT 0,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  unknowns_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  recommended_solution TEXT NOT NULL DEFAULT '',
  client_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(client_confirmed IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(organization_id, lead_id)
);
CREATE TRIGGER IF NOT EXISTS agency_needs_tenant_guard
BEFORE INSERT ON agency_needs_qualifications
WHEN NOT EXISTS (SELECT 1 FROM agency_leads WHERE id=NEW.lead_id AND organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'agency needs qualification organization mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_service_catalog (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('vitrine','ecommerce','web_app','mobile_app','business_platform','internal_tool','automation','maintenance')),
  description TEXT NOT NULL,
  default_scope TEXT NOT NULL DEFAULT '',
  exclusions_json TEXT NOT NULL DEFAULT '[]',
  estimated_days REAL NOT NULL,
  price_min REAL NOT NULL,
  price_base REAL NOT NULL,
  price_max REAL NOT NULL,
  estimated_cost REAL NOT NULL,
  payment_terms TEXT NOT NULL DEFAULT '',
  maintenance_terms TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(organization_id, code)
);
CREATE INDEX IF NOT EXISTS agency_service_catalog_org ON agency_service_catalog(organization_id, active, name);

CREATE TABLE IF NOT EXISTS agency_commercial_rules (
  organization_id TEXT PRIMARY KEY REFERENCES agency_organizations(id),
  min_margin_pct REAL NOT NULL DEFAULT 30,
  max_autonomous_discount_pct REAL NOT NULL DEFAULT 10,
  default_deposit_pct REAL NOT NULL DEFAULT 30,
  require_owner_approval_above_amount REAL NOT NULL DEFAULT 0,
  payment_terms_default TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_quotes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  lead_id TEXT NOT NULL REFERENCES agency_leads(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('essential','standard','advanced','custom')),
  currency TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  exclusions_json TEXT NOT NULL DEFAULT '[]',
  payment_terms TEXT NOT NULL DEFAULT '',
  delivery_days REAL NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL,
  discount_amount REAL NOT NULL,
  net_total REAL NOT NULL,
  estimated_cost REAL NOT NULL,
  gross_margin REAL NOT NULL,
  margin_pct REAL NOT NULL,
  range_low REAL NOT NULL,
  range_high REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','pending_approval','approved','sent','accepted','rejected','expired')),
  approval_id TEXT NOT NULL DEFAULT '',
  valid_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(organization_id, lead_id, version)
);
CREATE INDEX IF NOT EXISTS agency_quotes_org_lead ON agency_quotes(organization_id, lead_id, version DESC);
CREATE TRIGGER IF NOT EXISTS agency_quotes_tenant_guard
BEFORE INSERT ON agency_quotes
WHEN NOT EXISTS (SELECT 1 FROM agency_leads WHERE id=NEW.lead_id AND organization_id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT, 'agency quote organization mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_contracts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  lead_id TEXT NOT NULL REFERENCES agency_leads(id),
  quote_id TEXT NOT NULL REFERENCES agency_quotes(id),
  title TEXT NOT NULL,
  scope_summary TEXT NOT NULL,
  deliverables_json TEXT NOT NULL DEFAULT '[]',
  payment_terms TEXT NOT NULL DEFAULT '',
  total_amount REAL NOT NULL,
  deposit_amount REAL NOT NULL DEFAULT 0,
  deposit_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(deposit_status IN ('unpaid','paid')),
  deposit_reference TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','pending_approval','approved','sent','signed','cancelled')),
  approval_id TEXT NOT NULL DEFAULT '',
  signed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_contracts_org_lead ON agency_contracts(organization_id, lead_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS agency_contracts_tenant_guard
BEFORE INSERT ON agency_contracts
WHEN NOT EXISTS (
  SELECT 1 FROM agency_quotes WHERE id=NEW.quote_id AND organization_id=NEW.organization_id AND lead_id=NEW.lead_id
)
BEGIN SELECT RAISE(ABORT, 'agency contract organization mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  lead_id TEXT NOT NULL REFERENCES agency_leads(id),
  contract_id TEXT NOT NULL REFERENCES agency_contracts(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('handoff_pending','scoping','in_progress','qa_review','ready_for_delivery','delivered','accepted','maintenance','archived')),
  workspace_path TEXT NOT NULL,
  technical_specs TEXT NOT NULL DEFAULT '',
  target_stack_json TEXT NOT NULL DEFAULT '[]',
  budget_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'XOF',
  estimated_days INTEGER NOT NULL DEFAULT 1,
  handoff_summary TEXT NOT NULL DEFAULT '',
  handoff_at INTEGER NOT NULL,
  delivered_at INTEGER,
  accepted_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_projects_org_status ON agency_projects(organization_id, status, updated_at);
CREATE TRIGGER IF NOT EXISTS agency_projects_tenant_guard
BEFORE INSERT ON agency_projects
WHEN NOT EXISTS (
  SELECT 1 FROM agency_contracts WHERE id=NEW.contract_id AND organization_id=NEW.organization_id AND lead_id=NEW.lead_id
)
BEGIN SELECT RAISE(ABORT, 'agency project contract mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_project_lots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  project_id TEXT NOT NULL REFERENCES agency_projects(id),
  lot_order INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  owner_role TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','in_qa','verified','done','blocked')),
  estimated_hours REAL NOT NULL DEFAULT 0,
  actual_hours REAL NOT NULL DEFAULT 0,
  evidence_summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_project_lots_proj ON agency_project_lots(organization_id, project_id, lot_order);
CREATE TRIGGER IF NOT EXISTS agency_project_lots_tenant_guard
BEFORE INSERT ON agency_project_lots
WHEN NOT EXISTS (
  SELECT 1 FROM agency_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id
)
BEGIN SELECT RAISE(ABORT, 'agency lot project mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_scope_changes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  project_id TEXT NOT NULL REFERENCES agency_projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  budget_delta REAL NOT NULL DEFAULT 0,
  days_delta INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('proposed','approval_requested','approved','rejected','applied')),
  approval_id TEXT,
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_scope_changes_proj ON agency_scope_changes(organization_id, project_id, created_at);
CREATE TRIGGER IF NOT EXISTS agency_scope_changes_tenant_guard
BEFORE INSERT ON agency_scope_changes
WHEN NOT EXISTS (
  SELECT 1 FROM agency_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id
)
BEGIN SELECT RAISE(ABORT, 'agency scope change project mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_qa_checks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  project_id TEXT NOT NULL REFERENCES agency_projects(id),
  lot_id TEXT,
  category TEXT NOT NULL CHECK(category IN ('functional','technical','ui_ux','security')),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','passed','failed','blocked')),
  evidence TEXT NOT NULL DEFAULT '',
  findings TEXT NOT NULL DEFAULT '',
  checked_by TEXT NOT NULL,
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_qa_checks_proj ON agency_qa_checks(organization_id, project_id, category, created_at);
CREATE TRIGGER IF NOT EXISTS agency_qa_checks_tenant_guard
BEFORE INSERT ON agency_qa_checks
WHEN NOT EXISTS (
  SELECT 1 FROM agency_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id
)
BEGIN SELECT RAISE(ABORT, 'agency qa check project mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  project_id TEXT NOT NULL REFERENCES agency_projects(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','approval_requested','deployed','accepted','rejected')),
  environment_url TEXT NOT NULL DEFAULT '',
  release_notes TEXT NOT NULL DEFAULT '',
  qa_summary TEXT NOT NULL DEFAULT '',
  approval_id TEXT,
  client_feedback TEXT NOT NULL DEFAULT '',
  deployed_at INTEGER,
  accepted_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_deliveries_proj ON agency_deliveries(organization_id, project_id, version);
CREATE TRIGGER IF NOT EXISTS agency_deliveries_tenant_guard
BEFORE INSERT ON agency_deliveries
WHEN NOT EXISTS (
  SELECT 1 FROM agency_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id
)
BEGIN SELECT RAISE(ABORT, 'agency delivery project mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_followups (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  project_id TEXT NOT NULL REFERENCES agency_projects(id),
  lead_id TEXT NOT NULL REFERENCES agency_leads(id),
  type TEXT NOT NULL CHECK(type IN ('satisfaction','maintenance','upsell','support','case_study')),
  status TEXT NOT NULL CHECK(status IN ('scheduled','contacted','completed','dismissed')),
  due_at INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_followups_org_due ON agency_followups(organization_id, status, due_at);
CREATE TRIGGER IF NOT EXISTS agency_followups_tenant_guard
BEFORE INSERT ON agency_followups
WHEN NOT EXISTS (
  SELECT 1 FROM agency_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id AND lead_id=NEW.lead_id
)
BEGIN SELECT RAISE(ABORT, 'agency followup project mismatch'); END;

CREATE TABLE IF NOT EXISTS agency_missions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  project_id TEXT,
  lead_id TEXT,
  agent_role TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('planned','running','blocked','completed','failed')),
  preferred_tool TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '',
  output_summary TEXT NOT NULL DEFAULT '',
  evidence_paths_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER,
  completed_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_missions_org_status ON agency_missions(organization_id, status, updated_at);

CREATE TABLE IF NOT EXISTS agency_email_outbox (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES agency_organizations(id),
  contact_id TEXT NOT NULL REFERENCES agency_contacts(id),
  channel TEXT NOT NULL CHECK(channel='email'),
  purpose TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES agency_approvals(id),
  approval_payload_hash TEXT NOT NULL,
  consent_id TEXT NOT NULL REFERENCES agency_consents(id),
  status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','failed','cancelled')),
  provider_message_id TEXT NOT NULL DEFAULT '',
  failure_code TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS agency_email_outbox_org_status ON agency_email_outbox(organization_id, status, created_at);
CREATE TRIGGER IF NOT EXISTS agency_email_outbox_tenant_guard_insert
BEFORE INSERT ON agency_email_outbox
WHEN NOT EXISTS (SELECT 1 FROM agency_contacts WHERE id=NEW.contact_id AND organization_id=NEW.organization_id)
  OR NOT EXISTS (
    SELECT 1 FROM agency_consents
    WHERE id=NEW.consent_id AND organization_id=NEW.organization_id AND contact_id=NEW.contact_id
      AND channel=NEW.channel AND purpose=NEW.purpose AND status='granted'
      AND source<>'' AND length(proof)>=8 AND text_version<>''
      AND (expires_at=0 OR expires_at>NEW.created_at)
      AND NOT EXISTS (
        SELECT 1 FROM agency_consents newer
        WHERE newer.organization_id=agency_consents.organization_id
          AND newer.contact_id=agency_consents.contact_id
          AND newer.channel=agency_consents.channel AND newer.purpose=agency_consents.purpose
          AND newer.rowid>agency_consents.rowid
      )
  )
  OR NOT EXISTS (
    SELECT 1 FROM agency_approvals
    WHERE id=NEW.approval_id AND organization_id=NEW.organization_id
      AND action='send_message' AND resource_type='email_message' AND resource_id=NEW.contact_id
      AND status='approved' AND payload_hash=NEW.approval_payload_hash
      AND (expires_at=0 OR expires_at>NEW.created_at)
  )
BEGIN SELECT RAISE(ABORT, 'agency email outbox invariant failed'); END;
CREATE TRIGGER IF NOT EXISTS agency_email_outbox_no_delete
BEFORE DELETE ON agency_email_outbox
BEGIN SELECT RAISE(ABORT, 'agency email outbox records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS agency_email_outbox_payload_immutable
BEFORE UPDATE OF organization_id,contact_id,channel,purpose,recipient,subject,body_text,
  approval_id,approval_payload_hash,consent_id,idempotency_key,created_at
ON agency_email_outbox
BEGIN SELECT RAISE(ABORT, 'agency email message payload is immutable'); END;
`;

function text(row: Row, key: string): string { return String(row[key] ?? ""); }
function number(row: Row, key: string): number { return Number(row[key] ?? 0); }
function jsonObject(value: string): Record<string, unknown> {
  try {
    const result = JSON.parse(value);
    return result && typeof result === "object" && !Array.isArray(result) ? result : {};
  } catch {
    return {};
  }
}
function canonical(value: unknown): string {
  const ancestors=new Set<object>();
  let visited=0;
  const encode=(current: unknown,depth: number): string => {
    visited++;
    if (visited>10_000 || depth>32) throw new TypeError("payload exceeds canonicalization limits");
    if (current===null) return "null";
    if (typeof current==="string" || typeof current==="boolean") return JSON.stringify(current);
    if (typeof current==="number") {
      if (!Number.isFinite(current)) throw new TypeError("non-finite number is not JSON-safe");
      return JSON.stringify(current);
    }
    if (typeof current!=="object") throw new TypeError("value is not JSON-safe");
    if (ancestors.has(current)) throw new TypeError("cyclic values are not JSON-safe");
    const proto=Object.getPrototypeOf(current);
    if (!Array.isArray(current) && proto!==Object.prototype && proto!==null) throw new TypeError("only plain objects are JSON-safe");
    ancestors.add(current);
    let result: string;
    if (Array.isArray(current)) result=`[${current.map(item=>encode(item,depth+1)).join(",")}]`;
    else {
      const object=current as Record<string,unknown>;
      result=`{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${encode(object[key],depth+1)}`).join(",")}}`;
    }
    ancestors.delete(current);
    return result;
  };
  return encode(value,0);
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function organizationOf(r: Row): Organization {
  return { id: text(r,"id"), name: text(r,"name"), countryCode: text(r,"country_code"), currency: text(r,"currency"), status: text(r,"status") as OrganizationStatus, createdAt: number(r,"created_at"), updatedAt: number(r,"updated_at") };
}
function membershipOf(r: Row): Membership {
  return { organizationId: text(r,"organization_id"), userId: text(r,"user_id"), role: text(r,"role") as AgencyRole, createdAt: number(r,"created_at") };
}
function companyOf(r: Row): Company {
  return { id:text(r,"id"), organizationId:text(r,"organization_id"), name:text(r,"name"), normalizedName:text(r,"normalized_name"), website:text(r,"website"), industry:text(r,"industry"), countryCode:text(r,"country_code"), city:text(r,"city"), status:text(r,"status") as Company["status"], createdAt:number(r,"created_at"), updatedAt:number(r,"updated_at") };
}
function contactOf(r: Row): Contact {
  return { id:text(r,"id"), organizationId:text(r,"organization_id"), companyId:text(r,"company_id"), displayName:text(r,"display_name"), role:text(r,"role"), email:text(r,"email"), phone:text(r,"phone"), preferredChannel:text(r,"preferred_channel"), status:text(r,"status") as Contact["status"], createdAt:number(r,"created_at"), updatedAt:number(r,"updated_at") };
}
function leadOf(r: Row): Lead {
  return { id:text(r,"id"), organizationId:text(r,"organization_id"), companyId:text(r,"company_id"), contactId:text(r,"contact_id"), source:text(r,"source"), notes:text(r,"notes"), stage:text(r,"stage") as LeadStage, createdAt:number(r,"created_at"), updatedAt:number(r,"updated_at") };
}
function evidenceOf(r: Row): Evidence {
  return { id:text(r,"id"), organizationId:text(r,"organization_id"), companyId:text(r,"company_id"), leadId:text(r,"lead_id"), evidenceType:text(r,"evidence_type"), sourceUrl:text(r,"source_url"), summary:text(r,"summary"), contentHash:text(r,"content_hash"), confidence:Number(r.confidence), observedAt:number(r,"observed_at"), collectedAt:number(r,"collected_at") };
}
function jsonStringArray(value: string): string[] {
  try {
    const result=JSON.parse(value);
    return Array.isArray(result) ? result.filter((item): item is string => typeof item==="string") : [];
  } catch { return []; }
}
function qualificationProfileOf(r: Row): QualificationProfile {
  return {
    organizationId:text(r,"organization_id"),
    targetIndustries:jsonStringArray(text(r,"target_industries_json")),
    targetCountries:jsonStringArray(text(r,"target_countries_json")),
    excludedIndustries:jsonStringArray(text(r,"excluded_industries_json")),
    requiredEvidenceDomains:jsonStringArray(text(r,"required_evidence_domains_json")) as ResearchDomain[],
    requireWebsite:number(r,"require_website")===1,
    createdAt:number(r,"created_at"),
    updatedAt:number(r,"updated_at"),
  };
}
function consentOf(r: Row): ConsentRecord {
  return { id:text(r,"id"), organizationId:text(r,"organization_id"), contactId:text(r,"contact_id"), channel:text(r,"channel"), purpose:text(r,"purpose"), status:text(r,"status") as ConsentRecord["status"], source:text(r,"source"), proof:text(r,"proof"), textVersion:text(r,"text_version"), expiresAt:number(r,"expires_at"), createdAt:number(r,"created_at") };
}
function jsonArray(value: string): Record<string, unknown>[] {
  try {
    const result = JSON.parse(value);
    return Array.isArray(result) ? result.filter((item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item)) : [];
  } catch { return []; }
}
function whatsappOutboxOf(r: Row): import("./types.js").WhatsAppOutboxMessage {
  return {
    id:text(r,"id"), organizationId:text(r,"organization_id"), contactId:text(r,"contact_id"),
    channel:"whatsapp", purpose:text(r,"purpose"), recipient:text(r,"recipient"),
    templateName:text(r,"template_name"), language:text(r,"language"),
    templateComponents:jsonArray(text(r,"template_components_json")),
    approvalId:text(r,"approval_id"), approvalPayloadHash:text(r,"approval_payload_hash"),
    consentId:text(r,"consent_id"),
    status:text(r,"status") as import("./types.js").WhatsAppOutboxStatus,
    providerMessageId:text(r,"provider_message_id"), failureCode:text(r,"failure_code"),
    idempotencyKey:text(r,"idempotency_key"), createdAt:number(r,"created_at"),
    updatedAt:number(r,"updated_at"), submittedAt:number(r,"submitted_at"),
    providerStatus:text(r,"provider_status") as import("./types.js").WhatsAppProviderStatus,
    providerStatusAt:number(r,"provider_status_at"), providerErrorCode:text(r,"provider_error_code"),
  };
}
function approvalOf(r: Row): Approval {
  return { id:text(r,"id"), organizationId:text(r,"organization_id"), projectId:text(r,"project_id"), requestedBy:text(r,"requested_by"), action:text(r,"action") as ApprovalAction, resourceType:text(r,"resource_type"), resourceId:text(r,"resource_id"), reason:text(r,"reason"), payloadJson:text(r,"payload_json"), payloadHash:text(r,"payload_hash"), status:text(r,"status") as ApprovalStatus, expiresAt:number(r,"expires_at"), decidedBy:text(r,"decided_by"), decisionReason:text(r,"decision_reason"), createdAt:number(r,"created_at"), decidedAt:number(r,"decided_at") };
}
function auditOf(r: Row): AuditEvent {
  return { id:text(r,"id"), organizationId:text(r,"organization_id"), sequence:number(r,"sequence"), actorId:text(r,"actor_id"), action:text(r,"action"), entityType:text(r,"entity_type"), entityId:text(r,"entity_id"), payloadJson:text(r,"payload_json"), previousHash:text(r,"previous_hash"), hash:text(r,"hash"), createdAt:number(r,"created_at") };
}
function conversationOf(r: Row): CommercialConversation {
  return {
    id:text(r,"id"), organizationId:text(r,"organization_id"), leadId:text(r,"lead_id"),
    contactId:text(r,"contact_id"), channel:text(r,"channel") as CommercialChannel,
    subject:text(r,"subject"), status:text(r,"status") as ConversationStatus,
    nextFollowUpAt:number(r,"next_follow_up_at"), handoffReason:text(r,"handoff_reason"),
    lastMessageAt:number(r,"last_message_at"), createdAt:number(r,"created_at"), updatedAt:number(r,"updated_at"),
  };
}
function conversationMessageOf(r: Row): ConversationMessage {
  return {
    id:text(r,"id"), organizationId:text(r,"organization_id"), conversationId:text(r,"conversation_id"),
    direction:text(r,"direction") as MessageDirection, body:text(r,"body"),
    signal:text(r,"signal") as CommercialSignal, authorId:text(r,"author_id"), createdAt:number(r,"created_at"),
  };
}
function needsQualificationOf(r: Row): NeedsQualification {
  return {
    organizationId:text(r,"organization_id"), leadId:text(r,"lead_id"),
    problemStatement:text(r,"problem_statement"), targetUsers:text(r,"target_users"),
    solutionType:text(r,"solution_type") as SolutionType,
    mustHaveFeatures:jsonStringArray(text(r,"must_have_json")),
    niceToHaveFeatures:jsonStringArray(text(r,"nice_to_have_json")),
    constraints:jsonStringArray(text(r,"constraints_json")),
    desiredTimeline:text(r,"desired_timeline"),
    budgetMin:Number(r.budget_min ?? 0), budgetMax:Number(r.budget_max ?? 0),
    assumptions:jsonStringArray(text(r,"assumptions_json")),
    unknowns:jsonStringArray(text(r,"unknowns_json")),
    risks:jsonStringArray(text(r,"risks_json")),
    recommendedSolution:text(r,"recommended_solution"),
    clientConfirmed:number(r,"client_confirmed")===1,
    createdAt:number(r,"created_at"), updatedAt:number(r,"updated_at"),
  };
}
function catalogItemOf(r: Row): ServiceCatalogItem {
  return {
    id:text(r,"id"), organizationId:text(r,"organization_id"), code:text(r,"code"),
    name:text(r,"name"), category:text(r,"category") as SolutionType,
    description:text(r,"description"), defaultScope:text(r,"default_scope"),
    exclusions:jsonStringArray(text(r,"exclusions_json")),
    estimatedDays:Number(r.estimated_days ?? 0), priceMin:Number(r.price_min ?? 0),
    priceBase:Number(r.price_base ?? 0), priceMax:Number(r.price_max ?? 0),
    estimatedCost:Number(r.estimated_cost ?? 0), paymentTerms:text(r,"payment_terms"),
    maintenanceTerms:text(r,"maintenance_terms"), active:number(r,"active")===1,
    createdAt:number(r,"created_at"), updatedAt:number(r,"updated_at"),
  };
}
function commercialRulesOf(r: Row): CommercialRules {
  return {
    organizationId:text(r,"organization_id"),
    minMarginPct:Number(r.min_margin_pct ?? 30),
    maxAutonomousDiscountPct:Number(r.max_autonomous_discount_pct ?? 10),
    defaultDepositPct:Number(r.default_deposit_pct ?? 30),
    requireOwnerApprovalAboveAmount:Number(r.require_owner_approval_above_amount ?? 0),
    paymentTermsDefault:text(r,"payment_terms_default"),
    createdAt:number(r,"created_at"), updatedAt:number(r,"updated_at"),
  };
}
function quoteOf(r: Row): Quote {
  return {
    id:text(r,"id"), organizationId:text(r,"organization_id"), leadId:text(r,"lead_id"),
    version:number(r,"version"), title:text(r,"title"), tier:text(r,"tier") as QuoteTier,
    currency:text(r,"currency"), lines:jsonArray(text(r,"lines_json")) as unknown as QuoteLineItem[],
    exclusions:jsonStringArray(text(r,"exclusions_json")), paymentTerms:text(r,"payment_terms"),
    deliveryDays:Number(r.delivery_days ?? 0), discountPct:Number(r.discount_pct ?? 0),
    subtotal:Number(r.subtotal ?? 0), discountAmount:Number(r.discount_amount ?? 0),
    netTotal:Number(r.net_total ?? 0), estimatedCost:Number(r.estimated_cost ?? 0),
    grossMargin:Number(r.gross_margin ?? 0), marginPct:Number(r.margin_pct ?? 0),
    rangeLow:Number(r.range_low ?? 0), rangeHigh:Number(r.range_high ?? 0),
    status:text(r,"status") as QuoteStatus, approvalId:text(r,"approval_id"),
    validUntil:number(r,"valid_until"), createdAt:number(r,"created_at"), updatedAt:number(r,"updated_at"),
  };
}
function contractOf(r: Row): Contract {
  return {
    id:text(r,"id"), organizationId:text(r,"organization_id"), leadId:text(r,"lead_id"),
    quoteId:text(r,"quote_id"), title:text(r,"title"), scopeSummary:text(r,"scope_summary"),
    deliverables:jsonStringArray(text(r,"deliverables_json")), paymentTerms:text(r,"payment_terms"),
    totalAmount:Number(r.total_amount ?? 0), depositAmount:Number(r.deposit_amount ?? 0),
    depositStatus:text(r,"deposit_status") as DepositStatus, depositReference:text(r,"deposit_reference"),
    currency:text(r,"currency"), status:text(r,"status") as ContractStatus,
    approvalId:text(r,"approval_id"), signedAt:number(r,"signed_at"),
    createdAt:number(r,"created_at"), updatedAt:number(r,"updated_at"),
  };
}
function nullableNumber(row: Row, key: string): number | null {
  return row[key] == null ? null : Number(row[key]);
}
function projectOf(r: Row): Project {
  return {
    id: text(r, "id"),
    organizationId: text(r, "organization_id"),
    leadId: text(r, "lead_id"),
    contractId: text(r, "contract_id"),
    title: text(r, "title"),
    status: text(r, "status") as ProjectStatus,
    workspacePath: text(r, "workspace_path"),
    technicalSpecs: text(r, "technical_specs"),
    targetStack: jsonStringArray(text(r, "target_stack_json")),
    budgetAmount: number(r, "budget_amount"),
    currency: text(r, "currency"),
    estimatedDays: number(r, "estimated_days"),
    handoffSummary: text(r, "handoff_summary"),
    handoffAt: number(r, "handoff_at"),
    deliveredAt: nullableNumber(r, "delivered_at"),
    acceptedAt: nullableNumber(r, "accepted_at"),
    createdBy: text(r, "created_by"),
    createdAt: number(r, "created_at"),
    updatedAt: number(r, "updated_at"),
  };
}
function projectLotOf(r: Row): ProjectLot {
  return {
    id: text(r, "id"),
    organizationId: text(r, "organization_id"),
    projectId: text(r, "project_id"),
    lotOrder: number(r, "lot_order"),
    title: text(r, "title"),
    description: text(r, "description"),
    acceptanceCriteria: jsonStringArray(text(r, "acceptance_criteria_json")),
    dependencies: jsonStringArray(text(r, "dependencies_json")),
    ownerRole: text(r, "owner_role") as AgencyAgentRole,
    status: text(r, "status") as ProjectLotStatus,
    estimatedHours: number(r, "estimated_hours"),
    actualHours: number(r, "actual_hours"),
    evidenceSummary: text(r, "evidence_summary"),
    createdAt: number(r, "created_at"),
    updatedAt: number(r, "updated_at"),
  };
}
function scopeChangeOf(r: Row): ScopeChange {
  return {
    id: text(r, "id"),
    organizationId: text(r, "organization_id"),
    projectId: text(r, "project_id"),
    title: text(r, "title"),
    description: text(r, "description"),
    budgetDelta: number(r, "budget_delta"),
    daysDelta: number(r, "days_delta"),
    status: text(r, "status") as ScopeChangeStatus,
    approvalId: r.approval_id == null ? null : String(r.approval_id),
    requestedBy: text(r, "requested_by"),
    decidedBy: r.decided_by == null ? null : String(r.decided_by),
    decidedAt: nullableNumber(r, "decided_at"),
    createdAt: number(r, "created_at"),
    updatedAt: number(r, "updated_at"),
  };
}
function qaCheckOf(r: Row): QaCheck {
  return {
    id: text(r, "id"),
    organizationId: text(r, "organization_id"),
    projectId: text(r, "project_id"),
    lotId: r.lot_id == null ? null : String(r.lot_id),
    category: text(r, "category") as QaCategory,
    title: text(r, "title"),
    status: text(r, "status") as QaCheckStatus,
    evidence: text(r, "evidence"),
    findings: text(r, "findings"),
    checkedBy: text(r, "checked_by"),
    checkedAt: nullableNumber(r, "checked_at"),
    createdAt: number(r, "created_at"),
    updatedAt: number(r, "updated_at"),
  };
}
function projectDeliveryOf(r: Row): ProjectDelivery {
  return {
    id: text(r, "id"),
    organizationId: text(r, "organization_id"),
    projectId: text(r, "project_id"),
    version: number(r, "version"),
    status: text(r, "status") as DeliveryStatus,
    environmentUrl: text(r, "environment_url"),
    releaseNotes: text(r, "release_notes"),
    qaSummary: text(r, "qa_summary"),
    approvalId: r.approval_id == null ? null : String(r.approval_id),
    clientFeedback: text(r, "client_feedback"),
    deployedAt: nullableNumber(r, "deployed_at"),
    acceptedAt: nullableNumber(r, "accepted_at"),
    createdBy: text(r, "created_by"),
    createdAt: number(r, "created_at"),
    updatedAt: number(r, "updated_at"),
  };
}
function clientFollowUpOf(r: Row): ClientFollowUp {
  return {
    id: text(r, "id"),
    organizationId: text(r, "organization_id"),
    projectId: text(r, "project_id"),
    leadId: text(r, "lead_id"),
    type: text(r, "type") as FollowUpType,
    status: text(r, "status") as FollowUpStatus,
    dueAt: number(r, "due_at"),
    notes: text(r, "notes"),
    outcome: text(r, "outcome"),
    createdBy: text(r, "created_by"),
    completedAt: nullableNumber(r, "completed_at"),
    createdAt: number(r, "created_at"),
    updatedAt: number(r, "updated_at"),
  };
}
function agencyMissionOf(r: Row): AgencyMission {
  return {
    id: text(r, "id"),
    organizationId: text(r, "organization_id"),
    projectId: r.project_id == null ? null : String(r.project_id),
    leadId: r.lead_id == null ? null : String(r.lead_id),
    agentRole: text(r, "agent_role") as AgencyAgentRole,
    title: text(r, "title"),
    objective: text(r, "objective"),
    status: text(r, "status") as AgencyMissionStatus,
    preferredTool: text(r, "preferred_tool"),
    brief: text(r, "brief"),
    outputSummary: text(r, "output_summary"),
    evidencePaths: jsonStringArray(text(r, "evidence_paths_json")),
    startedAt: nullableNumber(r, "started_at"),
    completedAt: nullableNumber(r, "completed_at"),
    createdBy: text(r, "created_by"),
    createdAt: number(r, "created_at"),
    updatedAt: number(r, "updated_at"),
  };
}

function emailOutboxOf(r: Row): EmailOutboxMessage {
  return {
    id: text(r, "id"),
    organizationId: text(r, "organization_id"),
    contactId: text(r, "contact_id"),
    channel: "email",
    purpose: text(r, "purpose"),
    recipient: text(r, "recipient"),
    subject: text(r, "subject"),
    bodyText: text(r, "body_text"),
    approvalId: text(r, "approval_id"),
    approvalPayloadHash: text(r, "approval_payload_hash"),
    consentId: text(r, "consent_id"),
    status: text(r, "status") as EmailOutboxStatus,
    providerMessageId: text(r, "provider_message_id"),
    failureCode: text(r, "failure_code"),
    idempotencyKey: text(r, "idempotency_key"),
    createdAt: number(r, "created_at"),
    updatedAt: number(r, "updated_at"),
    submittedAt: number(r, "submitted_at"),
  };
}

export class AgencyStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (file !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
      try { fs.chmodSync(file, 0o600); } catch { /* platform may not support POSIX modes */ }
    }
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT OR IGNORE INTO agency_schema_migrations(version, applied_at) VALUES(1, ?)").run(Date.now());
    // v2 installs the idempotent tenant-integrity triggers on existing v1 databases.
    this.db.prepare("INSERT OR IGNORE INTO agency_schema_migrations(version, applied_at) VALUES(2, ?)").run(Date.now());
    // v3 introduces organization-scoped ideal-customer profiles.
    this.db.prepare("INSERT OR IGNORE INTO agency_schema_migrations(version, applied_at) VALUES(3, ?)").run(Date.now());
    // v4 adds an approval-bound, tenant-isolated WhatsApp Cloud API outbox.
    this.db.prepare("INSERT OR IGNORE INTO agency_schema_migrations(version, applied_at) VALUES(4, ?)").run(Date.now());
    // v5 adds delivery status columns and durable, deduplicated Meta webhook events.
    const columns=this.db.prepare("PRAGMA table_info(agency_whatsapp_outbox)").all() as Row[];
    const existingColumns=new Set(columns.map(row=>text(row,"name")));
    if (!existingColumns.has("provider_status")) this.db.exec("ALTER TABLE agency_whatsapp_outbox ADD COLUMN provider_status TEXT NOT NULL DEFAULT ''");
    if (!existingColumns.has("provider_status_at")) this.db.exec("ALTER TABLE agency_whatsapp_outbox ADD COLUMN provider_status_at INTEGER NOT NULL DEFAULT 0");
    if (!existingColumns.has("provider_error_code")) this.db.exec("ALTER TABLE agency_whatsapp_outbox ADD COLUMN provider_error_code TEXT NOT NULL DEFAULT ''");
    this.db.prepare("INSERT OR IGNORE INTO agency_schema_migrations(version, applied_at) VALUES(5, ?)").run(Date.now());
    // v6 adds commercial loop tables (conversations, needs qualification, catalog, rules, quotes, contracts).
    this.db.prepare("INSERT OR IGNORE INTO agency_schema_migrations(version, applied_at) VALUES(6, ?)").run(Date.now());
    // v7 adds contract-to-production handoff, project lots, scope changes, QA checks, deliveries, follow-ups, and multi-agent missions.
    this.db.prepare("INSERT OR IGNORE INTO agency_schema_migrations(version, applied_at) VALUES(7, ?)").run(Date.now());
    // v8 adds governed outbound email outbox.
    this.db.prepare("INSERT OR IGNORE INTO agency_schema_migrations(version, applied_at) VALUES(8, ?)").run(Date.now());
  }

  close(): void { this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  createOrganization(input: { id: string; name: string; countryCode: string; currency: string; ownerId: string; now: number }): Organization {
    this.db.prepare("INSERT INTO agency_organizations(id,name,country_code,currency,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(input.id,input.name,input.countryCode,input.currency,"active",input.now,input.now);
    this.db.prepare("INSERT INTO agency_memberships(organization_id,user_id,role,created_at) VALUES(?,?,?,?)")
      .run(input.id,input.ownerId,"owner",input.now);
    return this.getOrganization(input.id)!;
  }

  getOrganization(id: string): Organization | undefined {
    const row=this.db.prepare("SELECT * FROM agency_organizations WHERE id=?").get(id) as Row|undefined;
    return row ? organizationOf(row) : undefined;
  }
  listOrganizationsForMember(userId: string): Organization[] {
    return (this.db.prepare(
      "SELECT o.* FROM agency_organizations o INNER JOIN agency_memberships m ON m.organization_id=o.id WHERE m.user_id=? ORDER BY o.created_at ASC, o.id ASC",
    ).all(userId) as Row[]).map(organizationOf);
  }
  setOrganizationStatus(id: string, status: OrganizationStatus, now: number): void {
    this.db.prepare("UPDATE agency_organizations SET status=?,updated_at=? WHERE id=?").run(status,now,id);
  }
  addMembership(input: { organizationId: string; userId: string; role: AgencyRole; now: number }): Membership {
    this.db.prepare("INSERT INTO agency_memberships(organization_id,user_id,role,created_at) VALUES(?,?,?,?)")
      .run(input.organizationId,input.userId,input.role,input.now);
    return this.getMembership(input.organizationId,input.userId)!;
  }
  getMembership(orgId: string, userId: string): Membership | undefined {
    const row=this.db.prepare("SELECT * FROM agency_memberships WHERE organization_id=? AND user_id=?").get(orgId,userId) as Row|undefined;
    return row ? membershipOf(row) : undefined;
  }

  findCompanyDuplicate(orgId: string, normalized: string, website: string, excludeId = ""): Company | undefined {
    const row=this.db.prepare("SELECT * FROM agency_companies WHERE organization_id=? AND status='active' AND id<>? AND ((? <> '' AND website=? ) OR (? <> '' AND normalized_name=?)) ORDER BY created_at LIMIT 1")
      .get(orgId,excludeId,website,website,normalized,normalized) as Row|undefined;
    return row ? companyOf(row) : undefined;
  }
  findCompanyDuplicates(orgId: string, normalized: string, website: string): Company[] {
    if (!normalized && !website) return [];
    const rows=this.db.prepare("SELECT * FROM agency_companies WHERE organization_id=? AND ((? <> '' AND website=?) OR (? <> '' AND normalized_name=?)) ORDER BY updated_at DESC LIMIT 20")
      .all(orgId,website,website,normalized,normalized) as Row[];
    return rows.map(companyOf);
  }
  insertCompany(v: Company): Company {
    this.db.prepare("INSERT INTO agency_companies(id,organization_id,name,normalized_name,website,industry,country_code,city,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(v.id,v.organizationId,v.name,v.normalizedName,v.website,v.industry,v.countryCode,v.city,v.status,v.createdAt,v.updatedAt);
    return v;
  }
  updateCompany(v: Company): Company {
    this.db.prepare("UPDATE agency_companies SET name=?,normalized_name=?,website=?,industry=?,country_code=?,city=?,status=?,updated_at=? WHERE organization_id=? AND id=?")
      .run(v.name,v.normalizedName,v.website,v.industry,v.countryCode,v.city,v.status,v.updatedAt,v.organizationId,v.id);
    return this.getCompany(v.organizationId,v.id)!;
  }
  getCompany(orgId: string, id: string): Company | undefined {
    const row=this.db.prepare("SELECT * FROM agency_companies WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? companyOf(row) : undefined;
  }
  searchCompanies(orgId: string, filters: {
    query?: string; industry?: string; countryCode?: string; city?: string; status?: Company["status"]; limit: number; offset: number;
  }): { items: Company[]; total: number } {
    const clauses=["organization_id=?"], args: string[]=[orgId];
    if (filters.query) {
      clauses.push("(instr(lower(name),lower(?))>0 OR instr(lower(website),lower(?))>0 OR instr(lower(industry),lower(?))>0 OR instr(lower(city),lower(?))>0)");
      args.push(filters.query,filters.query,filters.query,filters.query);
    }
    if (filters.industry) { clauses.push("instr(lower(industry),lower(?))>0"); args.push(filters.industry); }
    if (filters.countryCode) { clauses.push("country_code=?"); args.push(filters.countryCode); }
    if (filters.city) { clauses.push("instr(lower(city),lower(?))>0"); args.push(filters.city); }
    if (filters.status) { clauses.push("status=?"); args.push(filters.status); }
    const where=clauses.join(" AND ");
    const totalRow=this.db.prepare(`SELECT COUNT(*) AS count FROM agency_companies WHERE ${where}`).get(...args) as Row;
    const rows=this.db.prepare(`SELECT * FROM agency_companies WHERE ${where} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...args,filters.limit,filters.offset) as Row[];
    return {items:rows.map(companyOf),total:number(totalRow,"count")};
  }

  insertContact(v: Contact): Contact {
    this.db.prepare("INSERT INTO agency_contacts(id,organization_id,company_id,display_name,role,email,phone,preferred_channel,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(v.id,v.organizationId,v.companyId,v.displayName,v.role,v.email,v.phone,v.preferredChannel,v.status,v.createdAt,v.updatedAt);
    return v;
  }
  updateContact(v: Contact): Contact {
    this.db.prepare("UPDATE agency_contacts SET display_name=?,role=?,email=?,phone=?,preferred_channel=?,status=?,updated_at=? WHERE organization_id=? AND id=?")
      .run(v.displayName,v.role,v.email,v.phone,v.preferredChannel,v.status,v.updatedAt,v.organizationId,v.id);
    return this.getContact(v.organizationId,v.id)!;
  }
  getContact(orgId: string, id: string): Contact | undefined {
    const row=this.db.prepare("SELECT * FROM agency_contacts WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? contactOf(row) : undefined;
  }
  findContactsByPhone(orgId: string, digits: string): Contact[] {
    if (!/^\d{8,15}$/.test(digits)) return [];
    const rows=this.db.prepare(`
      SELECT * FROM agency_contacts
      WHERE organization_id=? AND status='active'
        AND replace(replace(replace(replace(replace(replace(replace(phone,'+',''),' ',''),'-',''),'(',''),')',''),'.',''),'/','')=?
      ORDER BY id ASC LIMIT 2
    `).all(orgId,digits) as Row[];
    return rows.map(contactOf);
  }
  searchContacts(orgId: string, filters: {
    companyId?: string; query?: string; status?: Contact["status"]; limit: number; offset: number;
  }): { items: Contact[]; total: number } {
    const clauses=["organization_id=?"], args: string[]=[orgId];
    if (filters.companyId) { clauses.push("company_id=?"); args.push(filters.companyId); }
    if (filters.query) {
      clauses.push("(instr(lower(display_name),lower(?))>0 OR instr(lower(role),lower(?))>0 OR instr(lower(email),lower(?))>0 OR instr(lower(phone),lower(?))>0)");
      args.push(filters.query,filters.query,filters.query,filters.query);
    }
    if (filters.status) { clauses.push("status=?"); args.push(filters.status); }
    const where=clauses.join(" AND ");
    const totalRow=this.db.prepare(`SELECT COUNT(*) AS count FROM agency_contacts WHERE ${where}`).get(...args) as Row;
    const rows=this.db.prepare(`SELECT * FROM agency_contacts WHERE ${where} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...args,filters.limit,filters.offset) as Row[];
    return {items:rows.map(contactOf),total:number(totalRow,"count")};
  }

  insertLead(v: Lead): Lead {
    this.db.prepare("INSERT INTO agency_leads(id,organization_id,company_id,contact_id,source,notes,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(v.id,v.organizationId,v.companyId,v.contactId || null,v.source,v.notes,v.stage,v.createdAt,v.updatedAt);
    return v;
  }
  getLead(orgId: string, id: string): Lead | undefined {
    const row=this.db.prepare("SELECT * FROM agency_leads WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? leadOf(row) : undefined;
  }
  searchLeads(orgId: string, filters: {
    companyId?: string; stage?: LeadStage; query?: string; limit: number; offset: number;
  }): { items: Lead[]; total: number } {
    const clauses=["l.organization_id=?"], args: string[]=[orgId];
    if (filters.companyId) { clauses.push("l.company_id=?"); args.push(filters.companyId); }
    if (filters.stage) { clauses.push("l.stage=?"); args.push(filters.stage); }
    if (filters.query) {
      clauses.push("(instr(lower(l.source),lower(?))>0 OR instr(lower(l.notes),lower(?))>0 OR instr(lower(c.name),lower(?))>0 OR instr(lower(COALESCE(ct.display_name,'')),lower(?))>0)");
      args.push(filters.query,filters.query,filters.query,filters.query);
    }
    const where=clauses.join(" AND ");
    const joins=" FROM agency_leads l INNER JOIN agency_companies c ON c.id=l.company_id AND c.organization_id=l.organization_id LEFT JOIN agency_contacts ct ON ct.id=l.contact_id AND ct.organization_id=l.organization_id AND ct.company_id=l.company_id";
    const totalRow=this.db.prepare(`SELECT COUNT(*) AS count${joins} WHERE ${where}`).get(...args) as Row;
    const rows=this.db.prepare(`SELECT l.*${joins} WHERE ${where} ORDER BY l.updated_at DESC, l.id ASC LIMIT ? OFFSET ?`)
      .all(...args,filters.limit,filters.offset) as Row[];
    return {items:rows.map(leadOf),total:number(totalRow,"count")};
  }
  updateLeadStage(orgId: string, id: string, stage: LeadStage, now: number): Lead | undefined {
    this.db.prepare("UPDATE agency_leads SET stage=?,updated_at=? WHERE organization_id=? AND id=?").run(stage,now,orgId,id);
    return this.getLead(orgId,id);
  }
  updateLead(v: Lead): Lead {
    this.db.prepare("UPDATE agency_leads SET contact_id=?,source=?,notes=?,updated_at=? WHERE organization_id=? AND id=?")
      .run(v.contactId || null,v.source,v.notes,v.updatedAt,v.organizationId,v.id);
    return this.getLead(v.organizationId,v.id)!;
  }

  findEvidenceByHash(orgId: string, companyId: string, contentHash: string): Evidence | undefined {
    const row=this.db.prepare("SELECT * FROM agency_evidence WHERE organization_id=? AND company_id=? AND content_hash=? LIMIT 1")
      .get(orgId,companyId,contentHash) as Row|undefined;
    return row ? evidenceOf(row) : undefined;
  }
  insertEvidence(v: Evidence): Evidence {
    this.db.prepare("INSERT INTO agency_evidence(id,organization_id,company_id,lead_id,evidence_type,source_url,summary,content_hash,confidence,observed_at,collected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(v.id,v.organizationId,v.companyId,v.leadId || null,v.evidenceType,v.sourceUrl,v.summary,v.contentHash,v.confidence,v.observedAt,v.collectedAt);
    return v;
  }
  listEvidence(orgId: string, companyId: string): Evidence[] {
    return (this.db.prepare("SELECT * FROM agency_evidence WHERE organization_id=? AND company_id=? ORDER BY collected_at DESC").all(orgId,companyId) as Row[]).map(evidenceOf);
  }

  getQualificationProfile(orgId: string): QualificationProfile | undefined {
    const row=this.db.prepare("SELECT * FROM agency_qualification_profiles WHERE organization_id=?").get(orgId) as Row|undefined;
    return row ? qualificationProfileOf(row) : undefined;
  }
  saveQualificationProfile(v: QualificationProfile): QualificationProfile {
    this.db.prepare(`
      INSERT INTO agency_qualification_profiles(
        organization_id,target_industries_json,target_countries_json,excluded_industries_json,
        required_evidence_domains_json,require_website,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(organization_id) DO UPDATE SET
        target_industries_json=excluded.target_industries_json,
        target_countries_json=excluded.target_countries_json,
        excluded_industries_json=excluded.excluded_industries_json,
        required_evidence_domains_json=excluded.required_evidence_domains_json,
        require_website=excluded.require_website,
        updated_at=excluded.updated_at
    `).run(
      v.organizationId,JSON.stringify(v.targetIndustries),JSON.stringify(v.targetCountries),
      JSON.stringify(v.excludedIndustries),JSON.stringify(v.requiredEvidenceDomains),
      v.requireWebsite?1:0,v.createdAt,v.updatedAt,
    );
    return this.getQualificationProfile(v.organizationId)!;
  }

  insertConsent(v: ConsentRecord): ConsentRecord {
    this.db.prepare("INSERT INTO agency_consents(id,organization_id,contact_id,channel,purpose,status,source,proof,text_version,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(v.id,v.organizationId,v.contactId,v.channel,v.purpose,v.status,v.source,v.proof,v.textVersion,v.expiresAt,v.createdAt);
    return v;
  }
  latestConsent(orgId: string, contactId: string, channel: string, purpose: string): ConsentRecord | undefined {
    const row=this.db.prepare("SELECT * FROM agency_consents WHERE organization_id=? AND contact_id=? AND channel=? AND purpose=? ORDER BY rowid DESC LIMIT 1")
      .get(orgId,contactId,channel,purpose) as Row|undefined;
    return row ? consentOf(row) : undefined;
  }

  listConsents(orgId: string, contactId: string, channel?: string, purpose?: string): ConsentRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM agency_consents
      WHERE organization_id=? AND contact_id=?
        AND (?='' OR channel=?) AND (?='' OR purpose=?)
      ORDER BY created_at DESC, rowid DESC LIMIT 200
    `).all(orgId,contactId,channel ?? "",channel ?? "",purpose ?? "",purpose ?? "") as Row[];
    return rows.map(consentOf);
  }

  insertWhatsAppOutbox(v: import("./types.js").WhatsAppOutboxMessage): import("./types.js").WhatsAppOutboxMessage {
    this.db.prepare(`
      INSERT INTO agency_whatsapp_outbox(
        id,organization_id,contact_id,channel,purpose,recipient,template_name,language,
        template_components_json,approval_id,approval_payload_hash,consent_id,status,
        provider_message_id,failure_code,idempotency_key,created_at,updated_at,submitted_at,
        provider_status,provider_status_at,provider_error_code
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(v.id,v.organizationId,v.contactId,v.channel,v.purpose,v.recipient,v.templateName,v.language,
      JSON.stringify(v.templateComponents),v.approvalId,v.approvalPayloadHash,v.consentId,v.status,
      v.providerMessageId,v.failureCode,v.idempotencyKey,v.createdAt,v.updatedAt,v.submittedAt,
      v.providerStatus,v.providerStatusAt,v.providerErrorCode);
    return v;
  }
  getWhatsAppOutbox(orgId: string, id: string): import("./types.js").WhatsAppOutboxMessage | undefined {
    const row=this.db.prepare("SELECT * FROM agency_whatsapp_outbox WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? whatsappOutboxOf(row) : undefined;
  }
  findWhatsAppOutboxByIdempotency(orgId: string, key: string): import("./types.js").WhatsAppOutboxMessage | undefined {
    const row=this.db.prepare("SELECT * FROM agency_whatsapp_outbox WHERE organization_id=? AND idempotency_key=?").get(orgId,key) as Row|undefined;
    return row ? whatsappOutboxOf(row) : undefined;
  }
  listWhatsAppOutbox(orgId: string, limit = 100): import("./types.js").WhatsAppOutboxMessage[] {
    const rows=this.db.prepare("SELECT * FROM agency_whatsapp_outbox WHERE organization_id=? ORDER BY created_at DESC LIMIT ?").all(orgId,limit) as Row[];
    return rows.map(whatsappOutboxOf);
  }
  updateWhatsAppOutbox(
    orgId: string, id: string, expectedStatus: import("./types.js").WhatsAppOutboxStatus,
    status: import("./types.js").WhatsAppOutboxStatus, now: number,
    providerMessageId = "", failureCode = "", submittedAt = 0,
  ): boolean {
    const result=this.db.prepare(`
      UPDATE agency_whatsapp_outbox
      SET status=?,provider_message_id=?,failure_code=?,updated_at=?,submitted_at=?
      WHERE organization_id=? AND id=? AND status=?
    `).run(status,providerMessageId,failureCode,now,submittedAt,orgId,id,expectedStatus);
    return Number(result.changes) === 1;
  }

  getWhatsAppOutboxByProviderId(orgId: string, providerMessageId: string): import("./types.js").WhatsAppOutboxMessage | undefined {
    const row=this.db.prepare("SELECT * FROM agency_whatsapp_outbox WHERE organization_id=? AND provider_message_id=? LIMIT 1")
      .get(orgId,providerMessageId) as Row|undefined;
    return row ? whatsappOutboxOf(row) : undefined;
  }
  listWhatsAppWebhookStatusEvents(orgId: string, providerMessageId: string): {status:"sent"|"delivered"|"read"|"failed";eventAt:number;errorCode:string}[] {
    const rows=this.db.prepare(`
      SELECT provider_status,provider_error_code,event_at FROM agency_whatsapp_webhook_events
      WHERE organization_id=? AND provider_message_id=? AND event_type='status'
        AND provider_status IN ('sent','delivered','read','failed')
      ORDER BY event_at ASC,id ASC
    `).all(orgId,providerMessageId) as Row[];
    return rows.map(row=>({status:text(row,"provider_status") as "sent"|"delivered"|"read"|"failed",
      eventAt:number(row,"event_at"),errorCode:text(row,"provider_error_code")}));
  }
  updateWhatsAppProviderStatus(
    orgId: string, id: string, status: "sent"|"delivered"|"read"|"failed",
    eventAt: number, errorCode: string, now: number,
  ): boolean {
    const current=this.getWhatsAppOutbox(orgId,id);
    if (!current) return false;
    const rank: Record<string,number>={"":0,sent:1,delivered:2,read:3,failed:4};
    if (current.providerStatus==="read" || current.providerStatus==="failed") return false;
    if (rank[status]<=rank[current.providerStatus] || eventAt<current.providerStatusAt) return false;
    const result=this.db.prepare(`
      UPDATE agency_whatsapp_outbox
      SET provider_status=?,provider_status_at=?,provider_error_code=?,updated_at=?
      WHERE organization_id=? AND id=? AND provider_status_at<=?
    `).run(status,eventAt,errorCode,now,orgId,id,eventAt);
    return Number(result.changes)===1;
  }
  insertWhatsAppWebhookEvent(input: {
    organizationId:string;eventKey:string;providerMessageId:string;
    eventType:"status"|"inbound_message";providerStatus:string;errorCode:string;
    eventAt:number;contactId:string;receivedAt:number;
  }): boolean {
    const result=this.db.prepare(`
      INSERT INTO agency_whatsapp_webhook_events(
        organization_id,event_key,provider_message_id,event_type,provider_status,provider_error_code,event_at,contact_id,received_at
      ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,event_key) DO NOTHING
    `).run(input.organizationId,input.eventKey,input.providerMessageId,input.eventType,input.providerStatus,input.errorCode,
      input.eventAt,input.contactId,input.receivedAt);
    return Number(result.changes)===1;
  }
  countWhatsAppWebhookEvents(orgId: string): number {
    const row=this.db.prepare("SELECT COUNT(*) AS count FROM agency_whatsapp_webhook_events WHERE organization_id=?").get(orgId) as Row;
    return number(row,"count");
  }

  insertApproval(v: Approval): Approval {
    this.db.prepare("INSERT INTO agency_approvals(id,organization_id,project_id,requested_by,action,resource_type,resource_id,reason,payload_json,payload_hash,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(v.id,v.organizationId,v.projectId,v.requestedBy,v.action,v.resourceType,v.resourceId,v.reason,v.payloadJson,v.payloadHash,v.status,v.expiresAt,v.createdAt);
    return v;
  }
  getApproval(orgId: string, id: string): Approval | undefined {
    const row=this.db.prepare("SELECT * FROM agency_approvals WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? approvalOf(row) : undefined;
  }
  listApprovals(orgId: string, limit = 100): Approval[] {
    const rows=this.db.prepare(
      "SELECT * FROM agency_approvals WHERE organization_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(orgId,limit) as Row[];
    return rows.map(approvalOf);
  }
  decideApproval(orgId: string, id: string, status: Exclude<ApprovalStatus,"pending">, actorId: string, reason: string, now: number): boolean {
    const result=this.db.prepare("UPDATE agency_approvals SET status=?,decided_by=?,decision_reason=?,decided_at=? WHERE organization_id=? AND id=? AND status='pending'")
      .run(status,actorId,reason,now,orgId,id);
    return Number(result.changes) === 1;
  }

  appendAudit(input: { id?: string; organizationId: string; actorId: string; action: string; entityType: string; entityId: string; payload: unknown; now: number }): AuditEvent {
    const previous=this.db.prepare("SELECT hash FROM agency_audit_events WHERE organization_id=? ORDER BY sequence DESC LIMIT 1")
      .get(input.organizationId) as Row|undefined;
    const previousHash=text(previous ?? {},"hash");
    const payloadJson=canonical(input.payload);
    const eventBase={id:input.id ?? randomUUID(),organizationId:input.organizationId,actorId:input.actorId,action:input.action,entityType:input.entityType,entityId:input.entityId,payloadJson,previousHash,createdAt:input.now};
    const eventHash=hash(canonical(eventBase));
    const result=this.db.prepare("INSERT INTO agency_audit_events(id,organization_id,actor_id,action,entity_type,entity_id,payload_json,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(eventBase.id,eventBase.organizationId,eventBase.actorId,eventBase.action,eventBase.entityType,eventBase.entityId,eventBase.payloadJson,eventBase.previousHash,eventHash,eventBase.createdAt);
    return { ...eventBase, sequence:Number(result.lastInsertRowid), hash:eventHash };
  }
  listAudit(orgId: string, limit = 100): AuditEvent[] {
    return (this.db.prepare("SELECT * FROM (SELECT * FROM agency_audit_events WHERE organization_id=? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC")
      .all(orgId,limit) as Row[]).map(auditOf);
  }
  listAuditFiltered(orgId: string, filters: { action?: string; entityType?: string; limit: number }): AuditEvent[] {
    const clauses=["organization_id=?"], args: string[]=[orgId];
    if (filters.action) { clauses.push("instr(lower(action),lower(?))>0"); args.push(filters.action); }
    if (filters.entityType) { clauses.push("entity_type=?"); args.push(filters.entityType); }
    return (this.db.prepare(`SELECT * FROM agency_audit_events WHERE ${clauses.join(" AND ")} ORDER BY sequence DESC LIMIT ?`)
      .all(...args,filters.limit) as Row[]).map(auditOf);
  }
  listEntityAudit(orgId: string, filters: { entityType?: string; entityId?: string; limit: number }): AuditEvent[] {
    const clauses=["organization_id=?"], args: string[]=[orgId];
    if (filters.entityType) { clauses.push("entity_type=?"); args.push(filters.entityType); }
    if (filters.entityId) { clauses.push("entity_id=?"); args.push(filters.entityId); }
    return (this.db.prepare(`SELECT * FROM agency_audit_events WHERE ${clauses.join(" AND ")} ORDER BY sequence DESC LIMIT ?`)
      .all(...args,filters.limit) as Row[]).map(auditOf);
  }
  dashboard(orgId: string): {
    companyCount: number; contactCount: number; leadCount: number; openLeadCount: number; wonLeadCount: number;
    stageCounts: Record<LeadStage, number>;
  } {
    const count=(table: string) => {
      const row=this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE organization_id=?`).get(orgId) as Row;
      return number(row,"count");
    };
    const stageRows=this.db.prepare("SELECT stage,COUNT(*) AS count FROM agency_leads WHERE organization_id=? GROUP BY stage").all(orgId) as Row[];
    const stages: LeadStage[]=["new","researching","qualified","contact_pending","contacted","engaged","opportunity","proposal","won","lost","archived"];
    const stageCounts=Object.fromEntries(stages.map(stage=>[stage,0])) as Record<LeadStage,number>;
    for (const row of stageRows) stageCounts[text(row,"stage") as LeadStage]=number(row,"count");
    const leadCount=count("agency_leads");
    return {companyCount:count("agency_companies"),contactCount:count("agency_contacts"),leadCount,
      openLeadCount:leadCount-stageCounts.won-stageCounts.lost-stageCounts.archived,wonLeadCount:stageCounts.won,stageCounts};
  }
  verifyAuditChain(orgId: string): { valid: boolean; eventsChecked: number; failedSequence?: number } {
    const rows=this.db.prepare("SELECT * FROM agency_audit_events WHERE organization_id=? ORDER BY sequence ASC").all(orgId) as Row[];
    let previousHash="";
    for (const row of rows) {
      const event=auditOf(row);
      const eventBase={id:event.id,organizationId:event.organizationId,actorId:event.actorId,action:event.action,entityType:event.entityType,entityId:event.entityId,payloadJson:event.payloadJson,previousHash:event.previousHash,createdAt:event.createdAt};
      if (event.previousHash !== previousHash || hash(canonical(eventBase)) !== event.hash) {
        return { valid:false, eventsChecked:rows.indexOf(row), failedSequence:event.sequence };
      }
      previousHash=event.hash;
    }
    return { valid:true, eventsChecked:rows.length };
  }

  insertConversation(v: CommercialConversation): CommercialConversation {
    this.db.prepare(`
      INSERT INTO agency_conversations(
        id,organization_id,lead_id,contact_id,channel,subject,status,next_follow_up_at,handoff_reason,last_message_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(v.id,v.organizationId,v.leadId,v.contactId,v.channel,v.subject,v.status,v.nextFollowUpAt,v.handoffReason,v.lastMessageAt,v.createdAt,v.updatedAt);
    return v;
  }
  getConversation(orgId: string, id: string): CommercialConversation | undefined {
    const row=this.db.prepare("SELECT * FROM agency_conversations WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? conversationOf(row) : undefined;
  }
  listConversations(orgId: string, leadId?: string, limit = 100): CommercialConversation[] {
    const rows=leadId
      ? this.db.prepare("SELECT * FROM agency_conversations WHERE organization_id=? AND lead_id=? ORDER BY updated_at DESC, id ASC LIMIT ?").all(orgId,leadId,limit) as Row[]
      : this.db.prepare("SELECT * FROM agency_conversations WHERE organization_id=? ORDER BY updated_at DESC, id ASC LIMIT ?").all(orgId,limit) as Row[];
    return rows.map(conversationOf);
  }
  updateConversationState(orgId: string, id: string, status: ConversationStatus, nextFollowUpAt: number, handoffReason: string, lastMessageAt: number, now: number): CommercialConversation | undefined {
    this.db.prepare(`
      UPDATE agency_conversations
      SET status=?,next_follow_up_at=?,handoff_reason=?,last_message_at=?,updated_at=?
      WHERE organization_id=? AND id=?
    `).run(status,nextFollowUpAt,handoffReason,lastMessageAt,now,orgId,id);
    return this.getConversation(orgId,id);
  }
  insertConversationMessage(v: ConversationMessage): ConversationMessage {
    this.db.prepare(`
      INSERT INTO agency_conversation_messages(id,organization_id,conversation_id,direction,body,signal,author_id,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(v.id,v.organizationId,v.conversationId,v.direction,v.body,v.signal,v.authorId,v.createdAt);
    return v;
  }
  listConversationMessages(orgId: string, conversationId: string, limit = 200): ConversationMessage[] {
    const rows=this.db.prepare(
      "SELECT * FROM agency_conversation_messages WHERE organization_id=? AND conversation_id=? ORDER BY created_at ASC, rowid ASC LIMIT ?",
    ).all(orgId,conversationId,limit) as Row[];
    return rows.map(conversationMessageOf);
  }

  upsertNeedsQualification(v: NeedsQualification): NeedsQualification {
    this.db.prepare(`
      INSERT INTO agency_needs_qualifications(
        organization_id,lead_id,problem_statement,target_users,solution_type,must_have_json,nice_to_have_json,
        constraints_json,desired_timeline,budget_min,budget_max,assumptions_json,unknowns_json,risks_json,
        recommended_solution,client_confirmed,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(organization_id,lead_id) DO UPDATE SET
        problem_statement=excluded.problem_statement,target_users=excluded.target_users,solution_type=excluded.solution_type,
        must_have_json=excluded.must_have_json,nice_to_have_json=excluded.nice_to_have_json,constraints_json=excluded.constraints_json,
        desired_timeline=excluded.desired_timeline,budget_min=excluded.budget_min,budget_max=excluded.budget_max,
        assumptions_json=excluded.assumptions_json,unknowns_json=excluded.unknowns_json,risks_json=excluded.risks_json,
        recommended_solution=excluded.recommended_solution,client_confirmed=excluded.client_confirmed,updated_at=excluded.updated_at
    `).run(
      v.organizationId,v.leadId,v.problemStatement,v.targetUsers,v.solutionType,
      JSON.stringify(v.mustHaveFeatures),JSON.stringify(v.niceToHaveFeatures),JSON.stringify(v.constraints),
      v.desiredTimeline,v.budgetMin,v.budgetMax,
      JSON.stringify(v.assumptions),JSON.stringify(v.unknowns),JSON.stringify(v.risks),
      v.recommendedSolution,v.clientConfirmed ? 1 : 0,v.createdAt,v.updatedAt,
    );
    return this.getNeedsQualification(v.organizationId,v.leadId)!;
  }
  getNeedsQualification(orgId: string, leadId: string): NeedsQualification | undefined {
    const row=this.db.prepare("SELECT * FROM agency_needs_qualifications WHERE organization_id=? AND lead_id=?").get(orgId,leadId) as Row|undefined;
    return row ? needsQualificationOf(row) : undefined;
  }
  listNeedsQualifications(orgId: string, limit = 100): NeedsQualification[] {
    const rows=this.db.prepare("SELECT * FROM agency_needs_qualifications WHERE organization_id=? ORDER BY updated_at DESC LIMIT ?").all(orgId,limit) as Row[];
    return rows.map(needsQualificationOf);
  }

  insertCatalogItem(v: ServiceCatalogItem): ServiceCatalogItem {
    this.db.prepare(`
      INSERT INTO agency_service_catalog(
        id,organization_id,code,name,category,description,default_scope,exclusions_json,
        estimated_days,price_min,price_base,price_max,estimated_cost,payment_terms,maintenance_terms,active,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      v.id,v.organizationId,v.code,v.name,v.category,v.description,v.defaultScope,JSON.stringify(v.exclusions),
      v.estimatedDays,v.priceMin,v.priceBase,v.priceMax,v.estimatedCost,v.paymentTerms,v.maintenanceTerms,
      v.active ? 1 : 0,v.createdAt,v.updatedAt,
    );
    return v;
  }
  getCatalogItem(orgId: string, id: string): ServiceCatalogItem | undefined {
    const row=this.db.prepare("SELECT * FROM agency_service_catalog WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? catalogItemOf(row) : undefined;
  }
  getCatalogItemByCode(orgId: string, code: string): ServiceCatalogItem | undefined {
    const row=this.db.prepare("SELECT * FROM agency_service_catalog WHERE organization_id=? AND code=?").get(orgId,code) as Row|undefined;
    return row ? catalogItemOf(row) : undefined;
  }
  listCatalogItems(orgId: string, activeOnly = false, limit = 100): ServiceCatalogItem[] {
    const rows=activeOnly
      ? this.db.prepare("SELECT * FROM agency_service_catalog WHERE organization_id=? AND active=1 ORDER BY name ASC LIMIT ?").all(orgId,limit) as Row[]
      : this.db.prepare("SELECT * FROM agency_service_catalog WHERE organization_id=? ORDER BY active DESC, name ASC LIMIT ?").all(orgId,limit) as Row[];
    return rows.map(catalogItemOf);
  }
  updateCatalogItem(v: ServiceCatalogItem): ServiceCatalogItem {
    this.db.prepare(`
      UPDATE agency_service_catalog
      SET name=?,category=?,description=?,default_scope=?,exclusions_json=?,estimated_days=?,
          price_min=?,price_base=?,price_max=?,estimated_cost=?,payment_terms=?,maintenance_terms=?,active=?,updated_at=?
      WHERE organization_id=? AND id=?
    `).run(
      v.name,v.category,v.description,v.defaultScope,JSON.stringify(v.exclusions),v.estimatedDays,
      v.priceMin,v.priceBase,v.priceMax,v.estimatedCost,v.paymentTerms,v.maintenanceTerms,v.active ? 1 : 0,v.updatedAt,
      v.organizationId,v.id,
    );
    return this.getCatalogItem(v.organizationId,v.id)!;
  }

  getCommercialRules(orgId: string): CommercialRules | undefined {
    const row=this.db.prepare("SELECT * FROM agency_commercial_rules WHERE organization_id=?").get(orgId) as Row|undefined;
    return row ? commercialRulesOf(row) : undefined;
  }
  upsertCommercialRules(v: CommercialRules): CommercialRules {
    this.db.prepare(`
      INSERT INTO agency_commercial_rules(
        organization_id,min_margin_pct,max_autonomous_discount_pct,default_deposit_pct,
        require_owner_approval_above_amount,payment_terms_default,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(organization_id) DO UPDATE SET
        min_margin_pct=excluded.min_margin_pct,max_autonomous_discount_pct=excluded.max_autonomous_discount_pct,
        default_deposit_pct=excluded.default_deposit_pct,require_owner_approval_above_amount=excluded.require_owner_approval_above_amount,
        payment_terms_default=excluded.payment_terms_default,updated_at=excluded.updated_at
    `).run(
      v.organizationId,v.minMarginPct,v.maxAutonomousDiscountPct,v.defaultDepositPct,
      v.requireOwnerApprovalAboveAmount,v.paymentTermsDefault,v.createdAt,v.updatedAt,
    );
    return this.getCommercialRules(v.organizationId)!;
  }

  nextQuoteVersion(orgId: string, leadId: string): number {
    const row=this.db.prepare("SELECT COALESCE(MAX(version), 0) AS max_ver FROM agency_quotes WHERE organization_id=? AND lead_id=?").get(orgId,leadId) as Row;
    return number(row,"max_ver") + 1;
  }
  insertQuote(v: Quote): Quote {
    this.db.prepare(`
      INSERT INTO agency_quotes(
        id,organization_id,lead_id,version,title,tier,currency,lines_json,exclusions_json,payment_terms,
        delivery_days,discount_pct,subtotal,discount_amount,net_total,estimated_cost,gross_margin,margin_pct,
        range_low,range_high,status,approval_id,valid_until,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      v.id,v.organizationId,v.leadId,v.version,v.title,v.tier,v.currency,JSON.stringify(v.lines),JSON.stringify(v.exclusions),
      v.paymentTerms,v.deliveryDays,v.discountPct,v.subtotal,v.discountAmount,v.netTotal,v.estimatedCost,v.grossMargin,
      v.marginPct,v.rangeLow,v.rangeHigh,v.status,v.approvalId,v.validUntil,v.createdAt,v.updatedAt,
    );
    return v;
  }
  getQuote(orgId: string, id: string): Quote | undefined {
    const row=this.db.prepare("SELECT * FROM agency_quotes WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? quoteOf(row) : undefined;
  }
  listQuotes(orgId: string, leadId?: string, limit = 100): Quote[] {
    const rows=leadId
      ? this.db.prepare("SELECT * FROM agency_quotes WHERE organization_id=? AND lead_id=? ORDER BY version DESC LIMIT ?").all(orgId,leadId,limit) as Row[]
      : this.db.prepare("SELECT * FROM agency_quotes WHERE organization_id=? ORDER BY updated_at DESC, version DESC LIMIT ?").all(orgId,limit) as Row[];
    return rows.map(quoteOf);
  }
  updateQuoteStatus(orgId: string, id: string, status: QuoteStatus, approvalId: string, now: number): Quote | undefined {
    this.db.prepare("UPDATE agency_quotes SET status=?,approval_id=?,updated_at=? WHERE organization_id=? AND id=?").run(status,approvalId,now,orgId,id);
    return this.getQuote(orgId,id);
  }
  updateQuoteDraft(v: Quote): Quote {
    this.db.prepare(`
      UPDATE agency_quotes
      SET title=?,tier=?,lines_json=?,exclusions_json=?,payment_terms=?,delivery_days=?,discount_pct=?,
          subtotal=?,discount_amount=?,net_total=?,estimated_cost=?,gross_margin=?,margin_pct=?,
          range_low=?,range_high=?,valid_until=?,updated_at=?
      WHERE organization_id=? AND id=? AND status='draft'
    `).run(
      v.title,v.tier,JSON.stringify(v.lines),JSON.stringify(v.exclusions),v.paymentTerms,v.deliveryDays,
      v.discountPct,v.subtotal,v.discountAmount,v.netTotal,v.estimatedCost,v.grossMargin,v.marginPct,
      v.rangeLow,v.rangeHigh,v.validUntil,v.updatedAt,v.organizationId,v.id,
    );
    return this.getQuote(v.organizationId,v.id)!;
  }

  insertContract(v: Contract): Contract {
    this.db.prepare(`
      INSERT INTO agency_contracts(
        id,organization_id,lead_id,quote_id,title,scope_summary,deliverables_json,payment_terms,
        total_amount,deposit_amount,deposit_status,deposit_reference,currency,status,approval_id,signed_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      v.id,v.organizationId,v.leadId,v.quoteId,v.title,v.scopeSummary,JSON.stringify(v.deliverables),v.paymentTerms,
      v.totalAmount,v.depositAmount,v.depositStatus,v.depositReference,v.currency,v.status,v.approvalId,v.signedAt,v.createdAt,v.updatedAt,
    );
    return v;
  }
  getContract(orgId: string, id: string): Contract | undefined {
    const row=this.db.prepare("SELECT * FROM agency_contracts WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? contractOf(row) : undefined;
  }
  listContracts(orgId: string, leadId?: string, limit = 100): Contract[] {
    const rows=leadId
      ? this.db.prepare("SELECT * FROM agency_contracts WHERE organization_id=? AND lead_id=? ORDER BY created_at DESC LIMIT ?").all(orgId,leadId,limit) as Row[]
      : this.db.prepare("SELECT * FROM agency_contracts WHERE organization_id=? ORDER BY updated_at DESC, created_at DESC LIMIT ?").all(orgId,limit) as Row[];
    return rows.map(contractOf);
  }
  updateContractStatus(orgId: string, id: string, status: ContractStatus, approvalId: string, signedAt: number, now: number): Contract | undefined {
    this.db.prepare("UPDATE agency_contracts SET status=?,approval_id=?,signed_at=?,updated_at=? WHERE organization_id=? AND id=?").run(status,approvalId,signedAt,now,orgId,id);
    return this.getContract(orgId,id);
  }
  updateContractDeposit(orgId: string, id: string, depositStatus: DepositStatus, depositReference: string, now: number): Contract | undefined {
    this.db.prepare("UPDATE agency_contracts SET deposit_status=?,deposit_reference=?,updated_at=? WHERE organization_id=? AND id=?").run(depositStatus,depositReference,now,orgId,id);
    return this.getContract(orgId,id);
  }

  insertProject(p: Project): void {
    this.db.prepare(
      `INSERT INTO agency_projects(
        id,organization_id,lead_id,contract_id,title,status,workspace_path,technical_specs,
        target_stack_json,budget_amount,currency,estimated_days,handoff_summary,handoff_at,
        delivered_at,accepted_at,created_by,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      p.id, p.organizationId, p.leadId, p.contractId, p.title, p.status, p.workspacePath, p.technicalSpecs,
      JSON.stringify(p.targetStack), p.budgetAmount, p.currency, p.estimatedDays, p.handoffSummary,
      p.handoffAt, p.deliveredAt, p.acceptedAt, p.createdBy, p.createdAt, p.updatedAt,
    );
  }

  getProject(orgId: string, id: string): Project | undefined {
    const r = this.db.prepare("SELECT * FROM agency_projects WHERE organization_id=? AND id=?").get(orgId, id) as Row | undefined;
    return r ? projectOf(r) : undefined;
  }

  getProjectByContract(orgId: string, contractId: string): Project | undefined {
    const r = this.db.prepare("SELECT * FROM agency_projects WHERE organization_id=? AND contract_id=?").get(orgId, contractId) as Row | undefined;
    return r ? projectOf(r) : undefined;
  }

  listProjects(orgId: string, status?: ProjectStatus): Project[] {
    if (status) {
      return (this.db.prepare("SELECT * FROM agency_projects WHERE organization_id=? AND status=? ORDER BY updated_at DESC, rowid DESC").all(orgId, status) as Row[]).map(projectOf);
    }
    return (this.db.prepare("SELECT * FROM agency_projects WHERE organization_id=? ORDER BY updated_at DESC, rowid DESC").all(orgId) as Row[]).map(projectOf);
  }

  updateProjectState(orgId: string, id: string, patch: {
    status?: ProjectStatus;
    budgetAmount?: number;
    estimatedDays?: number;
    technicalSpecs?: string;
    deliveredAt?: number | null;
    acceptedAt?: number | null;
    updatedAt: number;
  }): Project | undefined {
    const cur = this.getProject(orgId, id);
    if (!cur) return undefined;
    this.db.prepare(
      "UPDATE agency_projects SET status=?,budget_amount=?,estimated_days=?,technical_specs=?,delivered_at=?,accepted_at=?,updated_at=? WHERE organization_id=? AND id=?",
    ).run(
      patch.status ?? cur.status,
      patch.budgetAmount ?? cur.budgetAmount,
      patch.estimatedDays ?? cur.estimatedDays,
      patch.technicalSpecs ?? cur.technicalSpecs,
      patch.deliveredAt === undefined ? cur.deliveredAt : patch.deliveredAt,
      patch.acceptedAt === undefined ? cur.acceptedAt : patch.acceptedAt,
      patch.updatedAt,
      orgId,
      id,
    );
    return this.getProject(orgId, id);
  }

  insertProjectLot(l: ProjectLot): void {
    this.db.prepare(
      `INSERT INTO agency_project_lots(
        id,organization_id,project_id,lot_order,title,description,acceptance_criteria_json,
        dependencies_json,owner_role,status,estimated_hours,actual_hours,evidence_summary,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      l.id, l.organizationId, l.projectId, l.lotOrder, l.title, l.description,
      JSON.stringify(l.acceptanceCriteria), JSON.stringify(l.dependencies), l.ownerRole,
      l.status, l.estimatedHours, l.actualHours, l.evidenceSummary, l.createdAt, l.updatedAt,
    );
  }

  getProjectLot(orgId: string, id: string): ProjectLot | undefined {
    const r = this.db.prepare("SELECT * FROM agency_project_lots WHERE organization_id=? AND id=?").get(orgId, id) as Row | undefined;
    return r ? projectLotOf(r) : undefined;
  }

  listProjectLots(orgId: string, projectId: string): ProjectLot[] {
    return (this.db.prepare("SELECT * FROM agency_project_lots WHERE organization_id=? AND project_id=? ORDER BY lot_order ASC, created_at ASC").all(orgId, projectId) as Row[]).map(projectLotOf);
  }

  updateProjectLot(orgId: string, id: string, patch: {
    status?: ProjectLotStatus;
    actualHours?: number;
    evidenceSummary?: string;
    ownerRole?: AgencyAgentRole;
    updatedAt: number;
  }): ProjectLot | undefined {
    const cur = this.getProjectLot(orgId, id);
    if (!cur) return undefined;
    this.db.prepare(
      "UPDATE agency_project_lots SET status=?,actual_hours=?,evidence_summary=?,owner_role=?,updated_at=? WHERE organization_id=? AND id=?",
    ).run(
      patch.status ?? cur.status,
      patch.actualHours ?? cur.actualHours,
      patch.evidenceSummary ?? cur.evidenceSummary,
      patch.ownerRole ?? cur.ownerRole,
      patch.updatedAt,
      orgId,
      id,
    );
    return this.getProjectLot(orgId, id);
  }

  insertScopeChange(s: ScopeChange): void {
    this.db.prepare(
      `INSERT INTO agency_scope_changes(
        id,organization_id,project_id,title,description,budget_delta,days_delta,status,
        approval_id,requested_by,decided_by,decided_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      s.id, s.organizationId, s.projectId, s.title, s.description, s.budgetDelta, s.daysDelta,
      s.status, s.approvalId, s.requestedBy, s.decidedBy, s.decidedAt, s.createdAt, s.updatedAt,
    );
  }

  getScopeChange(orgId: string, id: string): ScopeChange | undefined {
    const r = this.db.prepare("SELECT * FROM agency_scope_changes WHERE organization_id=? AND id=?").get(orgId, id) as Row | undefined;
    return r ? scopeChangeOf(r) : undefined;
  }

  listScopeChanges(orgId: string, projectId: string): ScopeChange[] {
    return (this.db.prepare("SELECT * FROM agency_scope_changes WHERE organization_id=? AND project_id=? ORDER BY created_at DESC, rowid DESC").all(orgId, projectId) as Row[]).map(scopeChangeOf);
  }

  updateScopeChangeStatus(orgId: string, id: string, status: ScopeChangeStatus, approvalId: string | null, decidedBy: string | null, decidedAt: number | null, now: number): ScopeChange | undefined {
    this.db.prepare(
      "UPDATE agency_scope_changes SET status=?,approval_id=?,decided_by=?,decided_at=?,updated_at=? WHERE organization_id=? AND id=?",
    ).run(status, approvalId, decidedBy, decidedAt, now, orgId, id);
    return this.getScopeChange(orgId, id);
  }

  insertQaCheck(c: QaCheck): void {
    this.db.prepare(
      `INSERT INTO agency_qa_checks(
        id,organization_id,project_id,lot_id,category,title,status,evidence,findings,
        checked_by,checked_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      c.id, c.organizationId, c.projectId, c.lotId, c.category, c.title, c.status,
      c.evidence, c.findings, c.checkedBy, c.checkedAt, c.createdAt, c.updatedAt,
    );
  }

  listQaChecks(orgId: string, projectId?: string): QaCheck[] {
    if (projectId) {
      return (this.db.prepare("SELECT * FROM agency_qa_checks WHERE organization_id=? AND project_id=? ORDER BY created_at DESC, rowid DESC").all(orgId, projectId) as Row[]).map(qaCheckOf);
    }
    return (this.db.prepare("SELECT * FROM agency_qa_checks WHERE organization_id=? ORDER BY created_at DESC, rowid DESC").all(orgId) as Row[]).map(qaCheckOf);
  }

  insertDelivery(d: ProjectDelivery): void {
    this.db.prepare(
      `INSERT INTO agency_deliveries(
        id,organization_id,project_id,version,status,environment_url,release_notes,
        qa_summary,approval_id,client_feedback,deployed_at,accepted_at,created_by,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      d.id, d.organizationId, d.projectId, d.version, d.status, d.environmentUrl, d.releaseNotes,
      d.qaSummary, d.approvalId, d.clientFeedback, d.deployedAt, d.acceptedAt, d.createdBy, d.createdAt, d.updatedAt,
    );
  }

  getDelivery(orgId: string, id: string): ProjectDelivery | undefined {
    const r = this.db.prepare("SELECT * FROM agency_deliveries WHERE organization_id=? AND id=?").get(orgId, id) as Row | undefined;
    return r ? projectDeliveryOf(r) : undefined;
  }

  listDeliveries(orgId: string, projectId: string): ProjectDelivery[] {
    return (this.db.prepare("SELECT * FROM agency_deliveries WHERE organization_id=? AND project_id=? ORDER BY version DESC, rowid DESC").all(orgId, projectId) as Row[]).map(projectDeliveryOf);
  }

  updateDeliveryState(orgId: string, id: string, patch: {
    status?: DeliveryStatus;
    approvalId?: string | null;
    clientFeedback?: string;
    deployedAt?: number | null;
    acceptedAt?: number | null;
    updatedAt: number;
  }): ProjectDelivery | undefined {
    const cur = this.getDelivery(orgId, id);
    if (!cur) return undefined;
    this.db.prepare(
      "UPDATE agency_deliveries SET status=?,approval_id=?,client_feedback=?,deployed_at=?,accepted_at=?,updated_at=? WHERE organization_id=? AND id=?",
    ).run(
      patch.status ?? cur.status,
      patch.approvalId === undefined ? cur.approvalId : patch.approvalId,
      patch.clientFeedback ?? cur.clientFeedback,
      patch.deployedAt === undefined ? cur.deployedAt : patch.deployedAt,
      patch.acceptedAt === undefined ? cur.acceptedAt : patch.acceptedAt,
      patch.updatedAt,
      orgId,
      id,
    );
    return this.getDelivery(orgId, id);
  }

  insertFollowUp(f: ClientFollowUp): void {
    this.db.prepare(
      `INSERT INTO agency_followups(
        id,organization_id,project_id,lead_id,type,status,due_at,notes,outcome,created_by,completed_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      f.id, f.organizationId, f.projectId, f.leadId, f.type, f.status, f.dueAt,
      f.notes, f.outcome, f.createdBy, f.completedAt, f.createdAt, f.updatedAt,
    );
  }

  getFollowUp(orgId: string, id: string): ClientFollowUp | undefined {
    const r = this.db.prepare("SELECT * FROM agency_followups WHERE organization_id=? AND id=?").get(orgId, id) as Row | undefined;
    return r ? clientFollowUpOf(r) : undefined;
  }

  listFollowUps(orgId: string, projectId?: string): ClientFollowUp[] {
    if (projectId) {
      return (this.db.prepare("SELECT * FROM agency_followups WHERE organization_id=? AND project_id=? ORDER BY due_at ASC, rowid DESC").all(orgId, projectId) as Row[]).map(clientFollowUpOf);
    }
    return (this.db.prepare("SELECT * FROM agency_followups WHERE organization_id=? ORDER BY due_at ASC, rowid DESC").all(orgId) as Row[]).map(clientFollowUpOf);
  }

  updateFollowUp(orgId: string, id: string, status: FollowUpStatus, outcome: string, completedAt: number | null, now: number): ClientFollowUp | undefined {
    this.db.prepare(
      "UPDATE agency_followups SET status=?,outcome=?,completed_at=?,updated_at=? WHERE organization_id=? AND id=?",
    ).run(status, outcome, completedAt, now, orgId, id);
    return this.getFollowUp(orgId, id);
  }

  insertMission(m: AgencyMission): void {
    this.db.prepare(
      `INSERT INTO agency_missions(
        id,organization_id,project_id,lead_id,agent_role,title,objective,status,preferred_tool,
        brief,output_summary,evidence_paths_json,started_at,completed_at,created_by,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      m.id, m.organizationId, m.projectId, m.leadId, m.agentRole, m.title, m.objective,
      m.status, m.preferredTool, m.brief, m.outputSummary, JSON.stringify(m.evidencePaths),
      m.startedAt, m.completedAt, m.createdBy, m.createdAt, m.updatedAt,
    );
  }

  getMission(orgId: string, id: string): AgencyMission | undefined {
    const r = this.db.prepare("SELECT * FROM agency_missions WHERE organization_id=? AND id=?").get(orgId, id) as Row | undefined;
    return r ? agencyMissionOf(r) : undefined;
  }

  listMissions(orgId: string, projectId?: string): AgencyMission[] {
    if (projectId) {
      return (this.db.prepare("SELECT * FROM agency_missions WHERE organization_id=? AND project_id=? ORDER BY updated_at DESC, rowid DESC").all(orgId, projectId) as Row[]).map(agencyMissionOf);
    }
    return (this.db.prepare("SELECT * FROM agency_missions WHERE organization_id=? ORDER BY updated_at DESC, rowid DESC").all(orgId) as Row[]).map(agencyMissionOf);
  }

  updateMission(orgId: string, id: string, patch: {
    status: AgencyMissionStatus;
    outputSummary: string;
    evidencePaths: string[];
    startedAt: number | null;
    completedAt: number | null;
    updatedAt: number;
  }): AgencyMission | undefined {
    this.db.prepare(
      "UPDATE agency_missions SET status=?,output_summary=?,evidence_paths_json=?,started_at=?,completed_at=?,updated_at=? WHERE organization_id=? AND id=?",
    ).run(
      patch.status,
      patch.outputSummary,
      JSON.stringify(patch.evidencePaths),
      patch.startedAt,
      patch.completedAt,
      patch.updatedAt,
      orgId,
      id,
    );
    return this.getMission(orgId, id);
  }
  insertEmailOutbox(v: EmailOutboxMessage): EmailOutboxMessage {
    this.db.prepare(`
      INSERT INTO agency_email_outbox(
        id,organization_id,contact_id,channel,purpose,recipient,subject,body_text,
        approval_id,approval_payload_hash,consent_id,status,provider_message_id,failure_code,
        idempotency_key,created_at,updated_at,submitted_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      v.id,v.organizationId,v.contactId,v.channel,v.purpose,v.recipient,v.subject,v.bodyText,
      v.approvalId,v.approvalPayloadHash,v.consentId,v.status,v.providerMessageId,v.failureCode,
      v.idempotencyKey,v.createdAt,v.updatedAt,v.submittedAt,
    );
    return v;
  }
  getEmailOutbox(orgId: string, id: string): EmailOutboxMessage | undefined {
    const row=this.db.prepare("SELECT * FROM agency_email_outbox WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? emailOutboxOf(row) : undefined;
  }
  findEmailOutboxByIdempotency(orgId: string, key: string): EmailOutboxMessage | undefined {
    const row=this.db.prepare("SELECT * FROM agency_email_outbox WHERE organization_id=? AND idempotency_key=?").get(orgId,key) as Row|undefined;
    return row ? emailOutboxOf(row) : undefined;
  }
  listEmailOutbox(orgId: string, limit = 100): EmailOutboxMessage[] {
    const rows=this.db.prepare("SELECT * FROM agency_email_outbox WHERE organization_id=? ORDER BY created_at DESC LIMIT ?").all(orgId,limit) as Row[];
    return rows.map(emailOutboxOf);
  }
  updateEmailOutbox(
    orgId: string, id: string, expectedStatus: EmailOutboxStatus,
    status: EmailOutboxStatus, now: number,
    providerMessageId = "", failureCode = "", submittedAt = 0,
  ): boolean {
    const result=this.db.prepare(`
      UPDATE agency_email_outbox
      SET status=?,provider_message_id=?,failure_code=?,updated_at=?,submitted_at=?
      WHERE organization_id=? AND id=? AND status=?
    `).run(status,providerMessageId,failureCode,now,submittedAt,orgId,id,expectedStatus);
    return Number(result.changes) === 1;
  }
}

export function stablePayloadHash(payload: unknown): { json: string; hash: string } {
  const json=canonical(payload);
  return { json, hash:hash(json) };
}
