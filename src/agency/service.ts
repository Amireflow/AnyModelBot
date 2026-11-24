import { createHash, randomUUID } from "node:crypto";
import { AgencyError } from "./errors.js";
import { AgencyStore, stablePayloadHash } from "./store.js";
import { assertLeadTransition } from "./transitions.js";
import { assessResearchEvidence } from "./research-quality.js";
import type { CompanyResearchSource } from "./company-research-import.js";
import type {
  AddEvidenceInput, AgencyDashboard, Approval, ApprovalAction, AuditEvent, Company, CompanySearchFilters,
  Contact, ContactSearchFilters, CreateCompanyInput, CreateContactInput, CreateLeadInput,
  CreateOrganizationInput, Evidence, Lead, LeadSearchFilters, LeadStage, Organization,
  Page, RecordConsentInput, RequestApprovalInput, AgencyRole, ResearchAssessment,
} from "./types.js";
import {
  confidenceValue, countryCode, currencyCode, emailAddress, normalizedName, optionalText,
  positiveTimestamp, requiredText, websiteUrl,
} from "./validation.js";

export interface AgencyServiceOptions {
  now?: () => number;
  id?: () => string;
}

const WRITE_ROLES: AgencyRole[] = ["owner","admin","member"];
const CRITICAL_APPROVAL_ACTIONS: ApprovalAction[] = [
  "send_message","send_quote","send_contract","sign_contract","spend_money",
  "grant_access","delete_data","deploy_production","change_scope","other_external_action",
];

export class AgencyService {
  constructor(readonly store: AgencyStore, private readonly options: AgencyServiceOptions = {}) {}

  private now(): number { return (this.options.now ?? Date.now)(); }
  private id(): string { return (this.options.id ?? randomUUID)(); }

  private requireMember(organizationId: string, actorId: string, roles: AgencyRole[] = WRITE_ROLES): AgencyRole {
    const organization=this.store.getOrganization(organizationId);
    if (!organization) throw new AgencyError("NOT_FOUND","Organization not found");
    if (organization.status !== "active") throw new AgencyError("ORGANIZATION_SUSPENDED","Organization is suspended");
    const membership=this.store.getMembership(organizationId,actorId);
    if (!membership || !roles.includes(membership.role)) {
      throw new AgencyError("FORBIDDEN","You do not have permission for this organization");
    }
    return membership.role;
  }

  private audit(orgId: string, actorId: string, action: string, entityType: string, entityId: string, payload: unknown): AuditEvent {
    return this.store.appendAudit({ organizationId:orgId, actorId, action, entityType, entityId, payload, now:this.now() });
  }

  createOrganization(input: CreateOrganizationInput, ownerId: string): Organization {
    const name=requiredText(input.name,"name",160);
    const actor=requiredText(ownerId,"ownerId",160);
    const now=this.now();
    return this.store.transaction(() => {
      const organization=this.store.createOrganization({
        id:this.id(), name, countryCode:countryCode(input.countryCode),
        currency:currencyCode(input.currency), ownerId:actor, now,
      });
      this.audit(organization.id,actor,"organization.created","organization",organization.id,{
        name:organization.name,countryCode:organization.countryCode,currency:organization.currency,
      });
      return organization;
    });
  }

  addMember(organizationId: string, actorId: string, userId: string, role: Exclude<AgencyRole,"owner">): void {
    this.requireMember(organizationId,actorId,["owner"]);
    const target=requiredText(userId,"userId",160);
    if (role === "owner") throw new AgencyError("VALIDATION_ERROR","Use an explicit ownership-transfer workflow");
    this.store.transaction(() => {
      this.store.addMembership({organizationId,userId:target,role,now:this.now()});
      this.audit(organizationId,actorId,"membership.created","membership",target,{role});
    });
  }

  getOrganization(organizationId: string, actorId: string): Organization {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    return this.store.getOrganization(organizationId)!;
  }

  listOrganizations(actorId: string): Organization[] {
    return this.store.listOrganizationsForMember(requiredText(actorId,"actorId",160));
  }
  getCompany(organizationId: string, actorId: string, companyId: string): Company {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    const company=this.store.getCompany(organizationId,requiredText(companyId,"companyId",100));
    if (!company) throw new AgencyError("NOT_FOUND","Company not found");
    return company;
  }
  searchCompanies(organizationId: string, actorId: string, filters: CompanySearchFilters = {}): Page<Company> {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    const limit=filters.limit ?? 50, offset=filters.offset ?? 0;
    this.validatePage(limit,offset);
    if (filters.status && filters.status!=="active" && filters.status!=="archived") throw new AgencyError("VALIDATION_ERROR","Invalid company status");
    const result=this.store.searchCompanies(organizationId,{query:optionalText(filters.query,"query",200),
      industry:optionalText(filters.industry,"industry",120),countryCode:countryCode(filters.countryCode),
      city:optionalText(filters.city,"city",120),status:filters.status,limit,offset});
    return {...result,limit,offset};
  }
  searchContacts(organizationId: string, actorId: string, filters: ContactSearchFilters = {}): Page<Contact> {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    const limit=filters.limit ?? 50, offset=filters.offset ?? 0;
    this.validatePage(limit,offset);
    const companyId=optionalText(filters.companyId,"companyId",100);
    if (companyId && !this.store.getCompany(organizationId,companyId)) throw new AgencyError("NOT_FOUND","Company not found");
    if (filters.status && filters.status!=="active" && filters.status!=="archived") throw new AgencyError("VALIDATION_ERROR","Invalid contact status");
    const result=this.store.searchContacts(organizationId,{companyId,query:optionalText(filters.query,"query",200),status:filters.status,limit,offset});
    return {...result,limit,offset};
  }
  searchLeads(organizationId: string, actorId: string, filters: LeadSearchFilters = {}): Page<Lead> {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    const limit=filters.limit ?? 50, offset=filters.offset ?? 0;
    this.validatePage(limit,offset);
    const companyId=optionalText(filters.companyId,"companyId",100);
    if (companyId && !this.store.getCompany(organizationId,companyId)) throw new AgencyError("NOT_FOUND","Company not found");
    const stages: LeadStage[]=["new","researching","qualified","contact_pending","contacted","engaged","opportunity","proposal","won","lost","archived"];
    if (filters.stage && !stages.includes(filters.stage)) throw new AgencyError("VALIDATION_ERROR","Invalid lead stage");
    const result=this.store.searchLeads(organizationId,{companyId,stage:filters.stage,query:optionalText(filters.query,"query",200),limit,offset});
    return {...result,limit,offset};
  }
  dashboard(organizationId: string, actorId: string): AgencyDashboard {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    return this.store.dashboard(organizationId);
  }
  timeline(organizationId: string, actorId: string, filters: { entityType?: string; entityId?: string; limit?: number } = {}): AuditEvent[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    const limit=filters.limit ?? 50;
    if (!Number.isInteger(limit) || limit<1 || limit>200) throw new AgencyError("VALIDATION_ERROR","limit must be between 1 and 200");
    const entityType=optionalText(filters.entityType,"entityType",80), entityId=optionalText(filters.entityId,"entityId",160);
    if (!!entityType !== !!entityId) throw new AgencyError("VALIDATION_ERROR","entityType and entityId must be provided together");
    return this.store.listEntityAudit(organizationId,{entityType,entityId,limit});
  }
  private validatePage(limit: number, offset: number): void {
    if (!Number.isInteger(limit) || limit<1 || limit>100) throw new AgencyError("VALIDATION_ERROR","limit must be between 1 and 100");
    if (!Number.isSafeInteger(offset) || offset<0 || offset>100_000) throw new AgencyError("VALIDATION_ERROR","offset must be between 0 and 100000");
  }

  createCompany(organizationId: string, actorId: string, input: CreateCompanyInput): Company {
    this.requireMember(organizationId,actorId);
    const name=requiredText(input.name,"name",200), normalized=normalizedName(name), website=websiteUrl(input.website);
    const now=this.now();
    const company: Company={id:this.id(),organizationId,name,normalizedName:normalized,website,
      industry:optionalText(input.industry,"industry",120),countryCode:countryCode(input.countryCode),
      city:optionalText(input.city,"city",120),status:"active",createdAt:now,updatedAt:now};
    return this.store.transaction(() => {
      // Duplicate detection runs under BEGIN IMMEDIATE to serialize competing writes.
      const duplicate=this.store.findCompanyDuplicate(organizationId,normalized,website);
      if (duplicate) throw new AgencyError("CONFLICT","A company with the same name or website already exists",{companyId:duplicate.id});
      this.store.insertCompany(company);
      this.audit(organizationId,actorId,"company.created","company",company.id,{
        name:company.name,website:company.website,industry:company.industry,countryCode:company.countryCode,city:company.city,
      });
      return company;
    });
  }

  listCompanies(organizationId: string, actorId: string, limit = 100): Company[] {
    return this.searchCompanies(organizationId,actorId,{limit}).items;
  }

  createContact(organizationId: string, actorId: string, input: CreateContactInput): Contact {
    this.requireMember(organizationId,actorId);
    const companyId=requiredText(input.companyId,"companyId",100);
    if (!this.store.getCompany(organizationId,companyId)) throw new AgencyError("NOT_FOUND","Company not found");
    const now=this.now();
    const contact: Contact={
      id:this.id(),organizationId,companyId,
      displayName:requiredText(input.displayName,"displayName",160),
      role:optionalText(input.role,"role",120),
      email:emailAddress(input.email),
      phone:optionalText(input.phone,"phone",40),
      preferredChannel:optionalText(input.preferredChannel,"preferredChannel",40),
      status:"active",createdAt:now,updatedAt:now,
    };
    return this.store.transaction(() => {
      this.store.insertContact(contact);
      this.audit(organizationId,actorId,"contact.created","contact",contact.id,{
        companyId:contact.companyId,displayName:contact.displayName,email:contact.email,
        phonePresent:!!contact.phone,preferredChannel:contact.preferredChannel,
      });
      return contact;
    });
  }

  listContacts(organizationId: string, actorId: string, companyId: string): Contact[] {
    return this.searchContacts(organizationId,actorId,{companyId,limit:100}).items;
  }

  createLead(organizationId: string, actorId: string, input: CreateLeadInput): Lead {
    this.requireMember(organizationId,actorId);
    const companyId=requiredText(input.companyId,"companyId",100);
    if (!this.store.getCompany(organizationId,companyId)) throw new AgencyError("NOT_FOUND","Company not found");
    const contactId=input.contactId ? requiredText(input.contactId,"contactId",100) : "";
    if (contactId) {
      const contact=this.store.getContact(organizationId,contactId);
      if (!contact || contact.companyId !== companyId) throw new AgencyError("VALIDATION_ERROR","Contact must belong to the selected company");
    }
    const now=this.now();
    const lead: Lead={
      id:this.id(),organizationId,companyId,contactId,
      source:optionalText(input.source,"source",500),
      notes:optionalText(input.notes,"notes",4000),
      stage:"new",createdAt:now,updatedAt:now,
    };
    return this.store.transaction(() => {
      this.store.insertLead(lead);
      this.audit(organizationId,actorId,"lead.created","lead",lead.id,{companyId,contactId,source:lead.source,stage:lead.stage});
      return lead;
    });
  }

  getLead(organizationId: string, actorId: string, leadId: string): Lead {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    const lead=this.store.getLead(organizationId,leadId);
    if (!lead) throw new AgencyError("NOT_FOUND","Lead not found");
    return lead;
  }

  transitionLead(organizationId: string, actorId: string, leadId: string, nextStage: LeadStage): Lead {
    this.requireMember(organizationId,actorId);
    const current=this.store.getLead(organizationId,leadId);
    if (!current) throw new AgencyError("NOT_FOUND","Lead not found");
    assertLeadTransition(current.stage,nextStage);
    return this.store.transaction(() => {
      const updated=this.store.updateLeadStage(organizationId,leadId,nextStage,this.now());
      if (!updated) throw new AgencyError("NOT_FOUND","Lead not found");
      this.audit(organizationId,actorId,"lead.stage_changed","lead",leadId,{from:current.stage,to:nextStage});
      return updated;
    });
  }

  addEvidence(organizationId: string, actorId: string, input: AddEvidenceInput): Evidence {
    this.requireMember(organizationId,actorId,["owner","admin","member"]);
    const companyId=requiredText(input.companyId,"companyId",100);
    if (!this.store.getCompany(organizationId,companyId)) throw new AgencyError("NOT_FOUND","Company not found");
    const leadId=input.leadId ? requiredText(input.leadId,"leadId",100) : "";
    if (leadId) {
      const lead=this.store.getLead(organizationId,leadId);
      if (!lead || lead.companyId !== companyId) throw new AgencyError("VALIDATION_ERROR","Evidence lead must belong to the selected company");
    }
    const sourceUrl=websiteUrl(input.sourceUrl);
    if (!sourceUrl) throw new AgencyError("VALIDATION_ERROR","sourceUrl is required");
    const now=this.now();
    const evidence: Evidence={
      id:this.id(),organizationId,companyId,leadId,
      evidenceType:requiredText(input.evidenceType,"evidenceType",80),
      sourceUrl,summary:requiredText(input.summary,"summary",4000),
      contentHash:optionalText(input.contentHash,"contentHash",128),
      confidence:confidenceValue(input.confidence),
      observedAt:input.observedAt == null ? now : positiveTimestamp(input.observedAt,"observedAt"),
      collectedAt:now,
    };
    return this.store.transaction(() => {
      this.store.insertEvidence(evidence);
      this.audit(organizationId,actorId,"evidence.created","evidence",evidence.id,{
        companyId,leadId,evidenceType:evidence.evidenceType,sourceUrl,contentHash:evidence.contentHash,
        confidence:evidence.confidence,observedAt:evidence.observedAt,
      });
      return evidence;
    });
  }

  listEvidence(organizationId: string, actorId: string, companyId: string): Evidence[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    if (!this.store.getCompany(organizationId,companyId)) throw new AgencyError("NOT_FOUND","Company not found");
    return this.store.listEvidence(organizationId,companyId);
  }

  assessCompanyResearch(organizationId: string, actorId: string, companyId: string): ResearchAssessment {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    if (!this.store.getCompany(organizationId,companyId)) throw new AgencyError("NOT_FOUND","Company not found");
    return assessResearchEvidence(this.store.listEvidence(organizationId,companyId),this.now());
  }

  importCompanyResearchSources(organizationId: string, actorId: string, companyId: string, jobId: string, sources: CompanyResearchSource[]) {
    this.requireMember(organizationId,actorId,["owner","admin","member"]);
    const company=this.store.getCompany(organizationId,requiredText(companyId,"companyId",100));
    if (!company) throw new AgencyError("NOT_FOUND","Company not found");
    const job=requiredText(jobId,"jobId",128);
    if (!Array.isArray(sources) || sources.length>250) throw new AgencyError("VALIDATION_ERROR","Research source list is invalid");

    const now=this.now();
    return this.store.transaction(() => {
      let imported=0, duplicates=0, uncited=0;
      for (const source of sources) {
        if (!source || source.used===false) { uncited++; continue; }
        const sourceUrl=websiteUrl(source.url);
        if (!sourceUrl) continue;
        const parsed=new URL(sourceUrl);
        parsed.hash="";
        for (const key of [...parsed.searchParams.keys()]) if (key.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(key);
        parsed.searchParams.sort();
        const canonicalUrl=parsed.toString();
        const contentHash=createHash("sha256").update("company-research:v1:"+companyId+":"+canonicalUrl).digest("hex");
        if (this.store.findEvidenceByHash(organizationId,companyId,contentHash)) { duplicates++; continue; }

        const domain=source.domain ?? "company";
        const title=optionalText(source.title,"title",300) || parsed.hostname;
        const relevance=source.score===undefined ? "" : " Recorded relevance score: "+source.score.toFixed(2)+" (not a source-confidence score).";
        const evidence: Evidence={
          id:this.id(),organizationId,companyId,leadId:"",
          evidenceType:"company_research_"+domain,
          sourceUrl,
          summary:"Source reference imported from Company Research job "+job+". Title: "+title+". The report marked this source as cited. Publication date was not included in the source export."+relevance,
          contentHash,confidence:0.5,observedAt:0,collectedAt:now,
        };
        this.store.insertEvidence(evidence);
        imported++;
      }
      this.audit(organizationId,actorId,"research.sources_imported","company_research_job",job,{
        companyId,jobId:job,imported,duplicates,uncited,
      });
      return {
        jobId:job,imported,duplicates,uncited,
        total:imported+duplicates+uncited,
        assessment:assessResearchEvidence(this.store.listEvidence(organizationId,companyId),now),
      };
    });
  }

  recordConsent(organizationId: string, actorId: string, input: RecordConsentInput) {
    this.requireMember(organizationId,actorId);
    const contactId=requiredText(input.contactId,"contactId",100);
    if (!this.store.getContact(organizationId,contactId)) throw new AgencyError("NOT_FOUND","Contact not found");
    const channel=requiredText(input.channel,"channel",40).toLowerCase();
    const purpose=requiredText(input.purpose,"purpose",80).toLowerCase();
    if (input.status!=="granted" && input.status!=="withdrawn") throw new AgencyError("VALIDATION_ERROR","Consent status must be granted or withdrawn");
    const source=requiredText(input.source,"source",300);
    const proof=requiredText(input.proof,"proof",4000);
    const now=this.now();
    const record={
      id:this.id(),organizationId,contactId,channel,purpose,status:input.status,
      source,proof,textVersion:optionalText(input.textVersion,"textVersion",100),
      expiresAt:input.expiresAt == null ? 0 : positiveTimestamp(input.expiresAt,"expiresAt"),
      createdAt:now,
    };
    if (record.expiresAt && record.expiresAt <= now) throw new AgencyError("VALIDATION_ERROR","Consent expiry must be in the future");
    return this.store.transaction(() => {
      const saved=this.store.insertConsent(record);
      this.audit(organizationId,actorId,input.status === "granted" ? "consent.granted" : "consent.withdrawn","consent",record.id,{
        contactId,channel,purpose,source,textVersion:record.textVersion,expiresAt:record.expiresAt,
      });
      return saved;
    });
  }

  hasActiveConsent(organizationId: string, actorId: string, contactId: string, channel: string, purpose: string): boolean {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    if (!this.store.getContact(organizationId,contactId)) throw new AgencyError("NOT_FOUND","Contact not found");
    const latest=this.store.latestConsent(
      organizationId,contactId,requiredText(channel,"channel",40).toLowerCase(),requiredText(purpose,"purpose",80).toLowerCase(),
    );
    return !!latest && latest.status === "granted" && (!latest.expiresAt || latest.expiresAt > this.now());
  }

  requestApproval(organizationId: string, actorId: string, input: RequestApprovalInput): Approval {
    this.requireMember(organizationId,actorId);
    if (!CRITICAL_APPROVAL_ACTIONS.includes(input.action)) throw new AgencyError("VALIDATION_ERROR","Unsupported approval action");
    const now=this.now();
    let payload: ReturnType<typeof stablePayloadHash>;
    try {
      if (!input.payload || typeof input.payload!=="object" || Array.isArray(input.payload)) throw new TypeError("payload must be an object");
      payload=stablePayloadHash(input.payload);
    } catch {
      throw new AgencyError("VALIDATION_ERROR","Approval payload must be a finite, acyclic JSON object");
    }
    const expiresAt=input.expiresAt == null ? now + 15 * 60_000 : positiveTimestamp(input.expiresAt,"expiresAt");
    if (expiresAt <= now) throw new AgencyError("VALIDATION_ERROR","Approval expiry must be in the future");
    const approval: Approval={
      id:this.id(),organizationId,projectId:optionalText(input.projectId,"projectId",100),
      requestedBy:actorId,action:input.action,
      resourceType:requiredText(input.resourceType,"resourceType",80),
      resourceId:requiredText(input.resourceId,"resourceId",160),
      reason:requiredText(input.reason,"reason",1000),
      payloadJson:payload.json,payloadHash:payload.hash,status:"pending",
      expiresAt,decidedBy:"",decisionReason:"",createdAt:now,decidedAt:0,
    };
    return this.store.transaction(() => {
      const saved=this.store.insertApproval(approval);
      this.audit(organizationId,actorId,"approval.requested","approval",approval.id,{
        action:approval.action,resourceType:approval.resourceType,resourceId:approval.resourceId,
        payloadHash:approval.payloadHash,expiresAt,
      });
      return saved;
    });
  }

  decideApproval(organizationId: string, actorId: string, approvalId: string, decision: "approved" | "rejected", expectedPayloadHash: string, reason = ""): Approval {
    this.requireMember(organizationId,actorId,["owner"]);
    const approval=this.store.getApproval(organizationId,approvalId);
    if (!approval) throw new AgencyError("NOT_FOUND","Approval not found");
    if (approval.status !== "pending") throw new AgencyError("APPROVAL_ALREADY_DECIDED","Approval is no longer pending",{status:approval.status});
    if (approval.expiresAt && approval.expiresAt <= this.now()) {
      this.store.transaction(() => {
        this.store.decideApproval(organizationId,approvalId,"expired","system:expiry","Approval expired",this.now());
        this.audit(organizationId,"system:expiry","approval.expired","approval",approvalId,{payloadHash:approval.payloadHash});
      });
      throw new AgencyError("APPROVAL_EXPIRED","Approval has expired");
    }
    if (expectedPayloadHash !== approval.payloadHash) throw new AgencyError("APPROVAL_PAYLOAD_MISMATCH","The approved action payload has changed");
    return this.store.transaction(() => {
      const changed=this.store.decideApproval(organizationId,approvalId,decision,actorId,optionalText(reason,"reason",1000),this.now());
      if (!changed) throw new AgencyError("APPROVAL_ALREADY_DECIDED","Approval was already handled");
      this.audit(organizationId,actorId,`approval.${decision}`,"approval",approvalId,{
        action:approval.action,resourceType:approval.resourceType,resourceId:approval.resourceId,
        payloadHash:approval.payloadHash,reason:optionalText(reason,"reason",1000),
      });
      return this.store.getApproval(organizationId,approvalId)!;
    });
  }

  verifyAudit(organizationId: string, actorId: string) {
    this.requireMember(organizationId,actorId,["owner","admin","auditor"]);
    return this.store.verifyAuditChain(organizationId);
  }

  listAudit(organizationId: string, actorId: string, limit = 100): AuditEvent[] {
    this.requireMember(organizationId,actorId,["owner","admin","auditor"]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AgencyError("VALIDATION_ERROR","limit must be between 1 and 500");
    return this.store.listAudit(organizationId,limit);
  }
}
