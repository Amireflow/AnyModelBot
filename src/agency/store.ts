import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Approval, ApprovalAction, ApprovalStatus, AuditEvent, Company, ConsentRecord, Contact,
  Evidence, Lead, LeadStage, Membership, Organization, OrganizationStatus, AgencyRole,
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
function consentOf(r: Row): ConsentRecord {
  return { id:text(r,"id"), organizationId:text(r,"organization_id"), contactId:text(r,"contact_id"), channel:text(r,"channel"), purpose:text(r,"purpose"), status:text(r,"status") as ConsentRecord["status"], source:text(r,"source"), proof:text(r,"proof"), textVersion:text(r,"text_version"), expiresAt:number(r,"expires_at"), createdAt:number(r,"created_at") };
}
function approvalOf(r: Row): Approval {
  return { id:text(r,"id"), organizationId:text(r,"organization_id"), projectId:text(r,"project_id"), requestedBy:text(r,"requested_by"), action:text(r,"action") as ApprovalAction, resourceType:text(r,"resource_type"), resourceId:text(r,"resource_id"), reason:text(r,"reason"), payloadJson:text(r,"payload_json"), payloadHash:text(r,"payload_hash"), status:text(r,"status") as ApprovalStatus, expiresAt:number(r,"expires_at"), decidedBy:text(r,"decided_by"), decisionReason:text(r,"decision_reason"), createdAt:number(r,"created_at"), decidedAt:number(r,"decided_at") };
}
function auditOf(r: Row): AuditEvent {
  return { id:text(r,"id"), organizationId:text(r,"organization_id"), sequence:number(r,"sequence"), actorId:text(r,"actor_id"), action:text(r,"action"), entityType:text(r,"entity_type"), entityId:text(r,"entity_id"), payloadJson:text(r,"payload_json"), previousHash:text(r,"previous_hash"), hash:text(r,"hash"), createdAt:number(r,"created_at") };
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

  findCompanyDuplicate(orgId: string, normalized: string, website: string): Company | undefined {
    const row=this.db.prepare("SELECT * FROM agency_companies WHERE organization_id=? AND status='active' AND ((? <> '' AND website=? ) OR normalized_name=?) ORDER BY created_at LIMIT 1")
      .get(orgId,website,website,normalized) as Row|undefined;
    return row ? companyOf(row) : undefined;
  }
  insertCompany(v: Company): Company {
    this.db.prepare("INSERT INTO agency_companies(id,organization_id,name,normalized_name,website,industry,country_code,city,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(v.id,v.organizationId,v.name,v.normalizedName,v.website,v.industry,v.countryCode,v.city,v.status,v.createdAt,v.updatedAt);
    return v;
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
  getContact(orgId: string, id: string): Contact | undefined {
    const row=this.db.prepare("SELECT * FROM agency_contacts WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? contactOf(row) : undefined;
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

  insertApproval(v: Approval): Approval {
    this.db.prepare("INSERT INTO agency_approvals(id,organization_id,project_id,requested_by,action,resource_type,resource_id,reason,payload_json,payload_hash,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(v.id,v.organizationId,v.projectId,v.requestedBy,v.action,v.resourceType,v.resourceId,v.reason,v.payloadJson,v.payloadHash,v.status,v.expiresAt,v.createdAt);
    return v;
  }
  getApproval(orgId: string, id: string): Approval | undefined {
    const row=this.db.prepare("SELECT * FROM agency_approvals WHERE organization_id=? AND id=?").get(orgId,id) as Row|undefined;
    return row ? approvalOf(row) : undefined;
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
}

export function stablePayloadHash(payload: unknown): { json: string; hash: string } {
  const json=canonical(payload);
  return { json, hash:hash(json) };
}
