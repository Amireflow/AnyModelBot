import { createHash, randomUUID } from "node:crypto";
import { AgencyError } from "./errors.js";
import { AgencyStore, stablePayloadHash } from "./store.js";
import { assertLeadTransition } from "./transitions.js";
import { assessResearchEvidence } from "./research-quality.js";
import { assessCompanyQualification } from "./qualification.js";
import type { CompanyResearchSource } from "./company-research-import.js";
import {
  buildTieredProposals, calculateQuoteTotals, classifyCommercialSignal, evaluateNegotiation,
} from "./commercial.js";
import { assertProjectTransition, computeAgencyMetrics, evaluateQaGate } from "./delivery.js";
import {
  AGENCY_AGENT_PROFILES, buildProjectExecutionBrief, detectLocalDevTools, getAgentProfile,
} from "./orchestrator.js";
import type {
  AddConversationMessageInput, AddEvidenceInput, AgencyAgentRole, AgencyDashboard,
  AgencyMetrics, AgencyMission, AgencyMissionStatus, AgentProfile, Approval, ApprovalAction,
  AuditEvent, ClientFollowUp, CommercialChannel, CommercialConversation, CommercialRules,
  Company, CompanySearchFilters, Contact, ContactSearchFilters, Contract, ConversationMessage,
  CreateCatalogItemInput, CreateCompanyInput, CreateContactInput, CreateContractInput,
  CreateConversationInput, CreateLeadInput, CreateMissionInput, CreateOrganizationInput,
  CreateProjectInput, CreateProjectLotInput, CreateQuoteInput, DepositStatus, DetectedDevTool,
  Evidence, FollowUpStatus, FollowUpType, Lead, LeadSearchFilters, LeadStage, MessageDirection,
  NeedsQualification, NegotiationEvaluation, Organization, Page, PrepareDeliveryInput,
  Project, ProjectDelivery, ProjectLot, ProjectLotStatus, ProjectStatus,
  ProposeScopeChangeInput, QaCategory, QaCheck, QaCheckStatus, QaGateEvaluation, Quote,
  QuoteTier, RecordConsentInput, RecordQaCheckInput, RequestApprovalInput, AgencyRole,
  ResearchAssessment, CompanyQualificationAssessment, QualificationProfile, ResearchDomain,
  ScheduleFollowUpInput, ScopeChange, ServiceCatalogItem, SolutionType, TieredProposalOption,
  UpdateCatalogItemInput, UpdateCommercialRulesInput, UpdateProjectLotInput,
  UpdateQualificationProfileInput, UpsertNeedsQualificationInput, QueueWhatsAppTemplateInput,
  WhatsAppOutboxMessage, WhatsAppWebhookProcessResult,
} from "./types.js";
import { WhatsAppProviderError, type WhatsAppTemplateSender } from "./whatsapp-cloud.js";
import {
  confidenceValue, countryCode, currencyCode, emailAddress, normalizedName, optionalText,
  positiveTimestamp, requiredText, websiteUrl,
} from "./validation.js";

export interface AgencyServiceOptions {
  now?: () => number;
  id?: () => string;
  whatsapp?: WhatsAppTemplateSender;
}

const WRITE_ROLES: AgencyRole[] = ["owner","admin","member"];
const SOLUTION_TYPES: SolutionType[] = [
  "vitrine","ecommerce","web_app","mobile_app","business_platform","internal_tool","automation","maintenance",
];
const COMMERCIAL_CHANNELS: CommercialChannel[] = ["whatsapp","email","web_form","social","phone","other"];
const QUOTE_TIERS: QuoteTier[] = ["essential","standard","advanced","custom"];

function stringList(value: unknown, field: string, maxItems = 50, maxLength = 300): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new AgencyError("VALIDATION_ERROR", `${field} must be an array`);
  if (value.length > maxItems) throw new AgencyError("VALIDATION_ERROR", `${field} exceeds ${maxItems} items`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new AgencyError("VALIDATION_ERROR", `${field} items must be text`);
    const cleaned = item.trim();
    if (!cleaned) continue;
    if (cleaned.length > maxLength) throw new AgencyError("VALIDATION_ERROR", `${field} item is too long`);
    if (!seen.has(cleaned)) { seen.add(cleaned); out.push(cleaned); }
  }
  return out;
}

function nonNegativeNumber(value: unknown, field: string, fallback = 0): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgencyError("VALIDATION_ERROR", `${field} must be a non-negative number`);
  }
  return value;
}

function quoteApprovalPayload(quote: Quote): Record<string, unknown> {
  return {
    quoteId: quote.id,
    leadId: quote.leadId,
    version: quote.version,
    tier: quote.tier,
    currency: quote.currency,
    discountPct: quote.discountPct,
    netTotal: quote.netTotal,
    estimatedCost: quote.estimatedCost,
    marginPct: quote.marginPct,
    deliveryDays: quote.deliveryDays,
  };
}

function contractApprovalPayload(contract: Contract): Record<string, unknown> {
  return {
    contractId: contract.id,
    leadId: contract.leadId,
    quoteId: contract.quoteId,
    title: contract.title,
    totalAmount: contract.totalAmount,
    depositAmount: contract.depositAmount,
    currency: contract.currency,
    paymentTerms: contract.paymentTerms,
  };
}
const CRITICAL_APPROVAL_ACTIONS: ApprovalAction[] = [
  "send_message","send_quote","send_contract","sign_contract","spend_money",
  "grant_access","delete_data","deploy_production","change_scope","other_external_action",
];

export class AgencyService {
  constructor(readonly store: AgencyStore, private readonly options: AgencyServiceOptions = {}) {}

  private now(): number { return (this.options.now ?? Date.now)(); }
  private id(): string { return (this.options.id ?? randomUUID)(); }

  private activeConsentRecord(organizationId: string, contactId: string, channel: string, purpose: string) {
    const latest=this.store.latestConsent(organizationId,contactId,channel,purpose);
    if (!latest || latest.status !== "granted" || (latest.expiresAt && latest.expiresAt <= this.now())
      || !latest.source.trim() || !latest.proof.trim() || !latest.textVersion.trim()) return undefined;
    return latest;
  }

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
    if ((role as string) === "owner") throw new AgencyError("VALIDATION_ERROR","Use an explicit ownership-transfer workflow");
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

  getQualificationProfile(organizationId: string, actorId: string): QualificationProfile {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    return this.store.getQualificationProfile(organizationId) ?? {
      organizationId,targetIndustries:[],targetCountries:[],excludedIndustries:[],
      requiredEvidenceDomains:[],requireWebsite:false,createdAt:0,updatedAt:0,
    };
  }

  updateQualificationProfile(organizationId: string, actorId: string, input: UpdateQualificationProfileInput): QualificationProfile {
    this.requireMember(organizationId,actorId,["owner","admin"]);
    const list=(value: unknown,field: string,maxItems=20): string[] => {
      if (value==null) return [];
      if (!Array.isArray(value) || value.length>maxItems) throw new AgencyError("VALIDATION_ERROR",field+" must be a list of up to "+maxItems+" values");
      const result:string[]=[];
      const seen=new Set<string>();
      for (const raw of value) {
        const item=requiredText(raw,field,100);
        const key=normalizedName(item);
        if (!seen.has(key)) { seen.add(key); result.push(item); }
      }
      return result;
    };
    const targetIndustries=list(input.targetIndustries,"targetIndustries");
    const excludedIndustries=list(input.excludedIndustries,"excludedIndustries");
    const targetCountries=list(input.targetCountries,"targetCountries").map(value=>{
      const code=countryCode(value);
      if (!code) throw new AgencyError("VALIDATION_ERROR","targetCountries cannot contain empty country codes");
      return code;
    });
    const requiredEvidenceDomains=list(input.requiredEvidenceDomains,"requiredEvidenceDomains",4) as ResearchDomain[];
    const validDomains:ResearchDomain[]=["company","industry","financial","news"];
    if (requiredEvidenceDomains.some(domain=>!validDomains.includes(domain))) {
      throw new AgencyError("VALIDATION_ERROR","requiredEvidenceDomains contains an unsupported domain");
    }
    if (targetIndustries.some(value=>excludedIndustries.some(excluded=>normalizedName(excluded)===normalizedName(value)))) {
      throw new AgencyError("VALIDATION_ERROR","An industry cannot be both targeted and excluded");
    }
    if (input.requireWebsite!==undefined && typeof input.requireWebsite!=="boolean") {
      throw new AgencyError("VALIDATION_ERROR","requireWebsite must be a boolean");
    }
    const now=this.now();
    const previous=this.store.getQualificationProfile(organizationId);
    const profile:QualificationProfile={
      organizationId,targetIndustries,targetCountries,excludedIndustries,requiredEvidenceDomains,
      requireWebsite:input.requireWebsite??false,
      createdAt:previous?.createdAt||now,updatedAt:now,
    };
    return this.store.transaction(()=>{
      const saved=this.store.saveQualificationProfile(profile);
      this.audit(organizationId,actorId,"qualification.profile_updated","qualification_profile",organizationId,{
        targetIndustries:targetIndustries.length,targetCountries:targetCountries.length,
        excludedIndustries:excludedIndustries.length,requiredEvidenceDomains,requireWebsite:profile.requireWebsite,
      });
      return saved;
    });
  }

  assessCompanyQualification(organizationId: string, actorId: string, companyId: string): CompanyQualificationAssessment {
    this.requireMember(organizationId,actorId,["owner","admin","member","client","auditor"]);
    const company=this.store.getCompany(organizationId,requiredText(companyId,"companyId",100));
    if (!company) throw new AgencyError("NOT_FOUND","Company not found");
    const profile=this.store.getQualificationProfile(organizationId) ?? {
      organizationId,targetIndustries:[],targetCountries:[],excludedIndustries:[],
      requiredEvidenceDomains:[],requireWebsite:false,createdAt:0,updatedAt:0,
    };
    return assessCompanyQualification(company,profile,this.store.listEvidence(organizationId,companyId),this.now());
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
        const sourceSummary=typeof source.summary==="string" ? source.summary.trim().slice(0,1200) : "";
        const sourceContent=typeof source.content==="string" ? source.content.trim().slice(0,2400) : "";
        const publishedAt=typeof source.publishedAt==="string" ? Date.parse(source.publishedAt) : Number.NaN;
        const observedAt=Number.isFinite(publishedAt) && publishedAt>0 && publishedAt<=now+24*60*60_000
          ? Math.trunc(publishedAt) : 0;
        const details=[
          sourceSummary ? "Source summary: "+sourceSummary : "",
          sourceContent ? "Additional extracted detail: "+sourceContent : "",
        ].filter(Boolean).join("\n");
        const publication=observedAt
          ? "Publication date: "+new Date(observedAt).toISOString()+"."
          : "Publication date was not included or could not be validated in the source export.";
        const relevance=typeof source.score==="number" && Number.isFinite(source.score) && source.score>=0 && source.score<=1
          ? " Recorded relevance score: "+source.score.toFixed(2)+" (not a source-confidence score)." : "";
        const evidence: Evidence={
          id:this.id(),organizationId,companyId,leadId:"",
          evidenceType:"company_research_"+domain,
          sourceUrl,
          summary:[
            "Source reference imported from Company Research job "+job+".",
            "Title: "+title+".",
            "The report marked this source as cited.",
            details ? "Source-derived information (untrusted reference text): "+details : "",
            publication,
            relevance,
          ].filter(Boolean).join(" "),
          contentHash,confidence:0.5,observedAt,collectedAt:now,
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
    if (!/^[a-z][a-z0-9_.-]{1,39}$/.test(channel) || !/^[a-z][a-z0-9_.-]{1,79}$/.test(purpose)) {
      throw new AgencyError("VALIDATION_ERROR","Consent channel and purpose must use stable identifiers");
    }
    const source=requiredText(input.source,"source",80).toLowerCase();
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(source)) throw new AgencyError("VALIDATION_ERROR","Consent source must use a stable identifier");
    const proof=requiredText(input.proof,"proof",4000);
    if (proof.length<8) throw new AgencyError("VALIDATION_ERROR","Consent proof must contain a meaningful reference (at least 8 characters)");
    const textVersion=optionalText(input.textVersion,"textVersion",100);
    if (input.status==="granted" && !textVersion) {
      throw new AgencyError("VALIDATION_ERROR","A granted consent requires the exact consent-text version");
    }
    const now=this.now();
    const record={
      id:this.id(),organizationId,contactId,channel,purpose,status:input.status,
      source,proof,textVersion,
      expiresAt:input.expiresAt == null ? 0 : positiveTimestamp(input.expiresAt,"expiresAt"),
      createdAt:now,
    };
    if (record.expiresAt && record.expiresAt <= now) throw new AgencyError("VALIDATION_ERROR","Consent expiry must be in the future");
    return this.store.transaction(() => {
      const saved=this.store.insertConsent(record);
      this.audit(organizationId,actorId,input.status === "granted" ? "consent.granted" : "consent.withdrawn","consent",record.id,{
        contactId,channel,purpose,source,textVersion:record.textVersion,expiresAt:record.expiresAt,
        proofPresent:true,
      });
      return saved;
    });
  }

  listConsents(organizationId: string, actorId: string, contactId: string, channel?: string, purpose?: string) {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    if (!this.store.getContact(organizationId,contactId)) throw new AgencyError("NOT_FOUND","Contact not found");
    return this.store.listConsents(organizationId,contactId,
      channel ? requiredText(channel,"channel",40).toLowerCase() : undefined,
      purpose ? requiredText(purpose,"purpose",80).toLowerCase() : undefined);
  }

  hasActiveConsent(organizationId: string, actorId: string, contactId: string, channel: string, purpose: string): boolean {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    if (!this.store.getContact(organizationId,contactId)) throw new AgencyError("NOT_FOUND","Contact not found");
    return !!this.activeConsentRecord(organizationId,contactId,
      requiredText(channel,"channel",40).toLowerCase(),requiredText(purpose,"purpose",80).toLowerCase());
  }

  queueWhatsAppTemplate(organizationId: string, actorId: string, input: QueueWhatsAppTemplateInput): WhatsAppOutboxMessage {
    this.requireMember(organizationId,actorId);
    const approvalId=requiredText(input.approvalId,"approvalId",100);
    const idempotencyKey=requiredText(input.idempotencyKey,"idempotencyKey",120);
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) {
      throw new AgencyError("VALIDATION_ERROR","idempotencyKey must contain 8-120 safe characters");
    }
    const payload=input.payload;
    if (!payload || typeof payload!=="object" || Array.isArray(payload)) throw new AgencyError("VALIDATION_ERROR","WhatsApp payload must be an object");
    const contactId=requiredText(payload.contactId as string,"payload.contactId",100);
    const channel=requiredText(payload.channel as string,"payload.channel",40).toLowerCase();
    const purpose=requiredText(payload.purpose as string,"payload.purpose",80).toLowerCase();
    const recipient=requiredText(payload.recipient as string,"payload.recipient",32);
    if (channel!=="whatsapp" || payload.type!=="template") {
      throw new AgencyError("VALIDATION_ERROR","Only WhatsApp Cloud API template messages are supported");
    }
    const phone=recipient;
    if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) throw new AgencyError("VALIDATION_ERROR","Recipient must be a canonical E.164 phone number");
    const template=payload.template;
    if (!template || typeof template!=="object" || Array.isArray(template)) throw new AgencyError("VALIDATION_ERROR","A WhatsApp template is required");
    const templateRecord=template as Record<string,unknown>;
    if (Object.keys(payload).sort().join(",")!=="channel,contactId,purpose,recipient,template,type"
      || Object.keys(templateRecord).sort().join(",")!=="components,language,name") {
      throw new AgencyError("VALIDATION_ERROR","WhatsApp approval payload contains unsupported fields");
    }
    const templateName=requiredText(templateRecord.name as string,"template.name",512).toLowerCase();
    const language=requiredText(templateRecord.language as string,"template.language",20);
    if (!/^[a-z0-9_]{1,512}$/.test(templateName) || !/^[a-z]{2,3}_[A-Z]{2}$/.test(language)) {
      throw new AgencyError("VALIDATION_ERROR","Template name or language is invalid");
    }
    if (!Array.isArray(templateRecord.components) || templateRecord.components.length>10
      || templateRecord.components.some((item) => !item || typeof item!=="object" || Array.isArray(item))) {
      throw new AgencyError("VALIDATION_ERROR","Template components must be an array of up to 10 objects");
    }
    const components=templateRecord.components as Record<string,unknown>[];
    let payloadHash: ReturnType<typeof stablePayloadHash>;
    try { payloadHash=stablePayloadHash(payload); }
    catch { throw new AgencyError("VALIDATION_ERROR","WhatsApp payload must be finite JSON"); }
    if (payloadHash.json.length>12_000) throw new AgencyError("VALIDATION_ERROR","WhatsApp template parameters are too large");

    const contact=this.store.getContact(organizationId,contactId);
    if (!contact) throw new AgencyError("NOT_FOUND","Contact not found");
    const storedPhone=contact.phone.replace(/[\s().-]/g,"");
    if (!/^\+[1-9][0-9]{7,14}$/.test(storedPhone) || storedPhone!==phone) {
      throw new AgencyError("VALIDATION_ERROR","The approved recipient must exactly match the contact stored E.164 phone number");
    }
    const consent=this.activeConsentRecord(organizationId,contactId,"whatsapp",purpose);
    if (!consent) throw new AgencyError("CONSENT_REQUIRED","A current, evidenced WhatsApp consent for this exact purpose is required");
    const approval=this.store.getApproval(organizationId,approvalId);
    if (!approval || approval.action!=="send_message" || approval.resourceType!=="whatsapp_template"
      || approval.resourceId!==contactId || approval.status!=="approved"
      || approval.payloadHash!==payloadHash.hash || (approval.expiresAt && approval.expiresAt<=this.now())) {
      throw new AgencyError("FORBIDDEN","A current owner approval for this exact WhatsApp template payload is required");
    }
    const existing=this.store.findWhatsAppOutboxByIdempotency(organizationId,idempotencyKey);
    if (existing) {
      if (existing.approvalPayloadHash!==payloadHash.hash || existing.approvalId!==approvalId
        || existing.contactId!==contactId || existing.consentId!==consent.id) {
        throw new AgencyError("CONFLICT","idempotencyKey was already used for a different or superseded authorization");
      }
      return existing;
    }
    const now=this.now();
    const message: WhatsAppOutboxMessage={
      id:this.id(),organizationId,contactId,channel:"whatsapp",purpose,recipient:phone,
      templateName,language,templateComponents:components,approvalId,approvalPayloadHash:payloadHash.hash,
      consentId:consent.id,status:"queued",providerMessageId:"",failureCode:"",
      idempotencyKey,createdAt:now,updatedAt:now,submittedAt:0,
      providerStatus:"",providerStatusAt:0,providerErrorCode:"",
    };
    return this.store.transaction(()=>{
      // Recheck under BEGIN IMMEDIATE so concurrent retries cannot race the unique key.
      const lockedExisting=this.store.findWhatsAppOutboxByIdempotency(organizationId,idempotencyKey);
      if (lockedExisting) {
        if (lockedExisting.approvalPayloadHash!==payloadHash.hash || lockedExisting.approvalId!==approvalId
          || lockedExisting.contactId!==contactId || lockedExisting.consentId!==consent.id) {
          throw new AgencyError("CONFLICT","idempotencyKey was already used for a different or superseded authorization");
        }
        return lockedExisting;
      }
      const currentConsent=this.activeConsentRecord(organizationId,contactId,"whatsapp",purpose);
      if (!currentConsent || currentConsent.id!==consent.id) {
        throw new AgencyError("CONSENT_REQUIRED","Consent changed while the message was being queued");
      }
      const currentApproval=this.store.getApproval(organizationId,approvalId);
      if (!currentApproval || currentApproval.status!=="approved" || currentApproval.action!=="send_message"
        || currentApproval.resourceType!=="whatsapp_template" || currentApproval.resourceId!==contactId
        || currentApproval.payloadHash!==payloadHash.hash || (currentApproval.expiresAt && currentApproval.expiresAt<=now)) {
        throw new AgencyError("FORBIDDEN","Approval changed while the message was being queued");
      }
      const saved=this.store.insertWhatsAppOutbox(message);
      this.audit(organizationId,actorId,"whatsapp.message.queued","whatsapp_message",message.id,{
        contactId,purpose,templateName,language,approvalId,approvalPayloadHash:payloadHash.hash,consentId:consent.id,
        idempotencyKey,
      });
      return saved;
    });
  }

  listWhatsAppOutbox(organizationId: string, actorId: string, limit=100): WhatsAppOutboxMessage[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    if (!Number.isInteger(limit) || limit<1 || limit>200) throw new AgencyError("VALIDATION_ERROR","limit must be between 1 and 200");
    return this.store.listWhatsAppOutbox(organizationId,limit);
  }

  async dispatchWhatsAppTemplate(organizationId: string, actorId: string, messageId: string): Promise<WhatsAppOutboxMessage> {
    this.requireMember(organizationId,actorId,["owner"]);
    const message=this.store.getWhatsAppOutbox(organizationId,requiredText(messageId,"messageId",100));
    if (!message) throw new AgencyError("NOT_FOUND","WhatsApp outbox message not found");
    if (message.status==="accepted") return message;
    if (message.status!=="queued") throw new AgencyError("CONFLICT","Only queued messages can be submitted; ambiguous submissions must be reconciled manually");
    const sender=this.options.whatsapp;
    if (!sender || !(await sender.isConfigured(organizationId))) throw new AgencyError("WHATSAPP_NOT_CONFIGURED","WhatsApp Cloud API credentials are not configured for this organization");
    const approval=this.store.getApproval(organizationId,message.approvalId);
    if (!approval || approval.status!=="approved" || approval.action!=="send_message"
      || approval.resourceType!=="whatsapp_template" || approval.resourceId!==message.contactId
      || approval.payloadHash!==message.approvalPayloadHash || (approval.expiresAt && approval.expiresAt<=this.now())) {
      throw new AgencyError("FORBIDDEN","The owner approval is missing, expired or no longer matches this message");
    }
    const consent=this.activeConsentRecord(organizationId,message.contactId,"whatsapp",message.purpose);
    if (!consent || consent.id!==message.consentId) {
      throw new AgencyError("CONSENT_REQUIRED","Consent was withdrawn, expired or replaced after this message was queued");
    }
    const contact=this.store.getContact(organizationId,message.contactId);
    if (!contact || contact.phone.replace(/[\s().-]/g,"")!==message.recipient) {
      throw new AgencyError("CONSENT_REQUIRED","The contact recipient changed after approval; a new review is required");
    }

    const startedAt=this.now();
    this.store.transaction(()=>{
      if (!this.store.updateWhatsAppOutbox(organizationId,message.id,"queued","sending",startedAt)) {
        throw new AgencyError("CONFLICT","This WhatsApp message is already being processed");
      }
      this.audit(organizationId,actorId,"whatsapp.message.submission_started","whatsapp_message",message.id,{
        approvalId:message.approvalId,approvalPayloadHash:message.approvalPayloadHash,
      });
    });

    try {
      const result=await sender.sendTemplateMessage({
        organizationId,recipient:message.recipient,templateName:message.templateName,
        language:message.language,components:message.templateComponents,
      });
      const now=this.now();
      this.store.transaction(()=>{
        if (!this.store.updateWhatsAppOutbox(organizationId,message.id,"sending","accepted",now,result.providerMessageId,"",now)) {
          throw new AgencyError("CONFLICT","WhatsApp message state changed during submission");
        }
        this.audit(organizationId,actorId,"whatsapp.message.accepted","whatsapp_message",message.id,{
          providerMessageId:result.providerMessageId,
        });
        // Meta can deliver a status callback before the send HTTP response is committed.
        // Replay any already-persisted callbacks now that the provider id is known.
        for (const event of this.store.listWhatsAppWebhookStatusEvents(organizationId,result.providerMessageId)) {
          const applied=this.store.updateWhatsAppProviderStatus(
            organizationId,message.id,event.status,event.eventAt,event.errorCode,now,
          );
          if (applied) this.audit(organizationId,"system:meta-webhook","whatsapp.message.provider_status",
            "whatsapp_message",message.id,{providerMessageId:result.providerMessageId,status:event.status,eventAt:event.eventAt});
        }
      });
    } catch (error) {
      const providerError=error instanceof WhatsAppProviderError ? error : new WhatsAppProviderError("UNEXPECTED_PROVIDER_FAILURE",true);
      const status=providerError.uncertain ? "submission_unknown" : "failed";
      const now=this.now();
      this.store.transaction(()=>{
        this.store.updateWhatsAppOutbox(organizationId,message.id,"sending",status,now,"",providerError.code,0);
        this.audit(organizationId,actorId,"whatsapp.message."+status,"whatsapp_message",message.id,{
          failureCode:providerError.code,
        });
      });
    }
    return this.store.getWhatsAppOutbox(organizationId,message.id)!;
  }

  processWhatsAppWebhook(organizationId: string, expectedPhoneNumberId: string, payload: unknown): WhatsAppWebhookProcessResult {
    const organization=this.store.getOrganization(organizationId);
    if (!organization || organization.status!=="active") throw new AgencyError("NOT_FOUND","Webhook organization is unavailable");
    if (!payload || typeof payload!=="object" || Array.isArray(payload)) throw new AgencyError("VALIDATION_ERROR","Webhook payload must be an object");
    const root=payload as Record<string,unknown>;
    if (root.object!=="whatsapp_business_account" || !Array.isArray(root.entry)) {
      throw new AgencyError("VALIDATION_ERROR","Unsupported Meta webhook object");
    }
    const result: WhatsAppWebhookProcessResult={
      accepted:0,duplicates:0,statusEvents:0,inboundMessages:0,optOuts:0,unmatchedOptOuts:0,
    };
    const now=this.now();
    for (const entryValue of root.entry) {
      if (!entryValue || typeof entryValue!=="object" || Array.isArray(entryValue)) continue;
      const entry=entryValue as Record<string,unknown>;
      if (!Array.isArray(entry.changes)) continue;
      for (const changeValue of entry.changes) {
        if (!changeValue || typeof changeValue!=="object" || Array.isArray(changeValue)) continue;
        const change=changeValue as Record<string,unknown>;
        if (change.field!=="messages" || !change.value || typeof change.value!=="object" || Array.isArray(change.value)) continue;
        const value=change.value as Record<string,unknown>;
        const metadata=value.metadata && typeof value.metadata==="object"
          ? value.metadata as Record<string,unknown> : {};
        if (metadata.phone_number_id!==expectedPhoneNumberId) {
          throw new AgencyError("FORBIDDEN","Webhook phone number does not match the configured Meta number");
        }

        if (Array.isArray(value.statuses)) for (const statusValue of value.statuses) {
          if (!statusValue || typeof statusValue!=="object" || Array.isArray(statusValue)) continue;
          const statusRecord=statusValue as Record<string,unknown>;
          const providerMessageId=typeof statusRecord.id==="string" ? statusRecord.id : "";
          const status=typeof statusRecord.status==="string" ? statusRecord.status : "";
          const recipientId=typeof statusRecord.recipient_id==="string" ? statusRecord.recipient_id : "";
          const seconds=typeof statusRecord.timestamp==="string" && /^\d{1,12}$/.test(statusRecord.timestamp)
            ? Number(statusRecord.timestamp) : Number.NaN;
          const supportedStatus=status==="sent" || status==="delivered" || status==="read" || status==="failed";
          if (!providerMessageId || !supportedStatus || !Number.isSafeInteger(seconds) || seconds<=0) continue;
          const eventAt=seconds*1000;
          if (!Number.isSafeInteger(eventAt)) continue;
          const eventKey=createHash("sha256")
            .update(["status",providerMessageId,status,String(eventAt),recipientId].join("|")).digest("hex");
          const errorValue=Array.isArray(statusRecord.errors) ? statusRecord.errors[0] : undefined;
          const errorRecord=errorValue && typeof errorValue==="object" && !Array.isArray(errorValue)
            ? errorValue as Record<string,unknown> : {};
          const errorCode=typeof errorRecord.code==="number" || typeof errorRecord.code==="string"
            ? String(errorRecord.code).slice(0,80) : "";
          this.store.transaction(()=>{
            const inserted=this.store.insertWhatsAppWebhookEvent({
              organizationId,eventKey,providerMessageId,eventType:"status",providerStatus:status,errorCode,
              eventAt,contactId:"",receivedAt:now,
            });
            if (!inserted) { result.duplicates++; return; }
            result.accepted++;
            result.statusEvents++;
            const message=this.store.getWhatsAppOutboxByProviderId(organizationId,providerMessageId);
            if (message) {
              const updated=this.store.updateWhatsAppProviderStatus(
                organizationId,message.id,status as "sent"|"delivered"|"read"|"failed",eventAt,errorCode,now,
              );
              if (updated) this.audit(organizationId,"system:meta-webhook","whatsapp.message.provider_status",
                "whatsapp_message",message.id,{providerMessageId,status,eventAt,errorCode});
            }
          });
        }

        if (Array.isArray(value.messages)) for (const messageValue of value.messages) {
          if (!messageValue || typeof messageValue!=="object" || Array.isArray(messageValue)) continue;
          const inbound=messageValue as Record<string,unknown>;
          const providerMessageId=typeof inbound.id==="string" ? inbound.id : "";
          const sender=typeof inbound.from==="string" ? inbound.from.replace(/\D/g,"") : "";
          const seconds=typeof inbound.timestamp==="string" && /^\d{1,12}$/.test(inbound.timestamp)
            ? Number(inbound.timestamp) : Number.NaN;
          if (!providerMessageId || !/^\d{8,15}$/.test(sender) || !Number.isSafeInteger(seconds) || seconds<=0) continue;
          const eventAt=seconds*1000;
          if (!Number.isSafeInteger(eventAt)) continue;
          const eventKey=createHash("sha256").update(["inbound",providerMessageId].join("|")).digest("hex");
          const textRecord=inbound.text && typeof inbound.text==="object"
            ? inbound.text as Record<string,unknown> : {};
          const textBody=typeof textRecord.body==="string" ? textRecord.body : "";
          const normalized=textBody.normalize("NFD").replace(/\p{Diacritic}/gu,"")
            .trim().toUpperCase().replace(/[.!?,;:]+$/g,"");
          const isOptOut=new Set<string>(["STOP","STOP ALL","UNSUBSCRIBE","CANCEL","END","QUIT","ARRET",
            "DESINSCRIRE","DESABONNER","NE PLUS ME CONTACTER"]).has(normalized);
          this.store.transaction(()=>{
            const candidates=this.store.findContactsByPhone(organizationId,sender);
            const contact=candidates.length===1 ? candidates[0] : undefined;
            const inserted=this.store.insertWhatsAppWebhookEvent({
              organizationId,eventKey,providerMessageId,eventType:"inbound_message",
              providerStatus:"",errorCode:"",eventAt,contactId:contact?.id ?? "",receivedAt:now,
            });
            if (!inserted) { result.duplicates++; return; }
            result.accepted++;
            result.inboundMessages++;
            if (!isOptOut) return;
            if (!contact) {
              result.unmatchedOptOuts++;
              this.audit(organizationId,"system:meta-webhook","whatsapp.opt_out.unmatched",
                "whatsapp_webhook_event",eventKey,{providerMessageId});
              return;
            }

            const history=this.store.listConsents(organizationId,contact.id,"whatsapp");
            const latestByPurpose=new Map<string, typeof history[number]>();
            for (const consent of history) if (!latestByPurpose.has(consent.purpose)) latestByPurpose.set(consent.purpose,consent);
            const activePurposes=[...latestByPurpose.values()].filter(consent=>
              consent.status==="granted" && (!consent.expiresAt || consent.expiresAt>now)).map(consent=>consent.purpose);
            if (!activePurposes.includes("marketing") && !latestByPurpose.has("marketing")) activePurposes.push("marketing");
            let withdrawn=0;
            for (const purpose of activePurposes) {
              const record={
                id:this.id(),organizationId,contactId:contact.id,channel:"whatsapp",purpose,
                status:"withdrawn" as const,source:"whatsapp_inbound",
                proof:"meta-wamid:"+providerMessageId,textVersion:"",expiresAt:0,createdAt:now,
              };
              this.store.insertConsent(record);
              this.audit(organizationId,"system:meta-webhook","consent.withdrawn","consent",record.id,{
                contactId:contact.id,channel:"whatsapp",purpose,source:record.source,providerMessageId,
              });
              withdrawn++;
            }
            result.optOuts+=withdrawn>0 ? 1 : 0;
            this.audit(organizationId,"system:meta-webhook","whatsapp.opt_out.received",
              "contact",contact.id,{providerMessageId,purposesWithdrawn:withdrawn});
          });
        }
      }
    }
    return result;
  }

  requestApproval(organizationId: string, actorId: string, input: RequestApprovalInput): Approval {
    this.requireMember(organizationId,actorId);
    if (!CRITICAL_APPROVAL_ACTIONS.includes(input.action)) throw new AgencyError("VALIDATION_ERROR","Unsupported approval action");
    if (input.action==="send_message" && input.resourceType==="whatsapp_template") {
      const message=input.payload;
      if (!message || typeof message!=="object" || Array.isArray(message)
        || message.channel!=="whatsapp" || message.type!=="template") {
        throw new AgencyError("VALIDATION_ERROR","WhatsApp approval requires a template-message payload");
      }
      const contactId=requiredText(message.contactId as string,"payload.contactId",100);
      const purpose=requiredText(message.purpose as string,"payload.purpose",80).toLowerCase();
      const recipient=requiredText(message.recipient as string,"payload.recipient",32);
      if (input.resourceId!==contactId) throw new AgencyError("VALIDATION_ERROR","WhatsApp approval resource must match its contact");
      if (Object.keys(message).sort().join(",")!=="channel,contactId,purpose,recipient,template,type") {
        throw new AgencyError("VALIDATION_ERROR","WhatsApp approval payload contains unsupported fields");
      }
      const template=message.template;
      if (!template || typeof template!=="object" || Array.isArray(template)) {
        throw new AgencyError("VALIDATION_ERROR","A WhatsApp template is required");
      }
      const templateRecord=template as Record<string,unknown>;
      if (Object.keys(templateRecord).sort().join(",")!=="components,language,name") {
        throw new AgencyError("VALIDATION_ERROR","WhatsApp template contains unsupported fields");
      }
      const templateName=requiredText(templateRecord.name as string,"payload.template.name",512).toLowerCase();
      const language=requiredText(templateRecord.language as string,"payload.template.language",20);
      if (!/^[a-z0-9_]{1,512}$/.test(templateName) || !/^[a-z]{2,3}_[A-Z]{2}$/.test(language)) {
        throw new AgencyError("VALIDATION_ERROR","Template name or language is invalid");
      }
      const components=templateRecord.components;
      if (!Array.isArray(components)||components.length>10
        || components.some(item=>!item||typeof item!=="object"||Array.isArray(item))) {
        throw new AgencyError("VALIDATION_ERROR","Template components must be an array of up to 10 objects");
      }
      if (!/^\+[1-9][0-9]{7,14}$/.test(recipient)) {
        throw new AgencyError("VALIDATION_ERROR","Recipient must be a canonical E.164 phone number");
      }
      const contact=this.store.getContact(organizationId,contactId);
      if (!contact) throw new AgencyError("NOT_FOUND","Contact not found");
      if (contact.phone.replace(/[\s().-]/g,"")!==recipient) {
        throw new AgencyError("CONSENT_REQUIRED","The WhatsApp recipient must match the contact's current phone number");
      }
      if (!this.activeConsentRecord(organizationId,contactId,"whatsapp",purpose)) {
        throw new AgencyError("CONSENT_REQUIRED","A current WhatsApp consent grant with proof is required before requesting approval");
      }
    }
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

  listApprovals(organizationId: string, actorId: string, limit = 100): Approval[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new AgencyError("VALIDATION_ERROR","limit must be between 1 and 200");
    }
    return this.store.listApprovals(organizationId,limit);
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

  // ---------- Priority 1: Commercial Conversations, Needs, Catalog, Quotes, Negotiation, Contracts ----------

  createConversation(organizationId: string, actorId: string, input: CreateConversationInput): CommercialConversation {
    this.requireMember(organizationId,actorId);
    const leadId=requiredText(input.leadId,"leadId",100);
    const lead=this.store.getLead(organizationId,leadId);
    if (!lead) throw new AgencyError("NOT_FOUND","Lead not found");
    if (!COMMERCIAL_CHANNELS.includes(input.channel)) throw new AgencyError("VALIDATION_ERROR","Unsupported conversation channel");
    const contactId=input.contactId ? requiredText(input.contactId,"contactId",100) : lead.contactId;
    if (contactId) {
      const contact=this.store.getContact(organizationId,contactId);
      if (!contact || contact.companyId!==lead.companyId) {
        throw new AgencyError("VALIDATION_ERROR","Contact must belong to the lead's company");
      }
    }
    const nextFollowUpAt=input.nextFollowUpAt == null ? 0 : positiveTimestamp(input.nextFollowUpAt,"nextFollowUpAt");
    const now=this.now();
    const conv: CommercialConversation={
      id:this.id(), organizationId, leadId, contactId, channel:input.channel,
      subject:requiredText(input.subject,"subject",240),
      status:"open", nextFollowUpAt, handoffReason:"", lastMessageAt:now, createdAt:now, updatedAt:now,
    };
    return this.store.transaction(() => {
      this.store.insertConversation(conv);
      this.audit(organizationId,actorId,"conversation.created","conversation",conv.id,{
        leadId:conv.leadId,channel:conv.channel,subject:conv.subject,
      });
      return conv;
    });
  }

  listConversations(organizationId: string, actorId: string, leadId?: string, limit = 100): CommercialConversation[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AgencyError("VALIDATION_ERROR","limit must be between 1 and 200");
    return this.store.listConversations(organizationId,leadId ? requiredText(leadId,"leadId",100) : undefined,limit);
  }

  getConversation(organizationId: string, actorId: string, conversationId: string): CommercialConversation {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    const conv=this.store.getConversation(organizationId,requiredText(conversationId,"conversationId",100));
    if (!conv) throw new AgencyError("NOT_FOUND","Conversation not found");
    return conv;
  }

  listConversationMessages(organizationId: string, actorId: string, conversationId: string, limit = 200): ConversationMessage[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    const conv=this.store.getConversation(organizationId,requiredText(conversationId,"conversationId",100));
    if (!conv) throw new AgencyError("NOT_FOUND","Conversation not found");
    return this.store.listConversationMessages(organizationId,conv.id,limit);
  }

  addConversationMessage(organizationId: string, actorId: string, conversationId: string, input: AddConversationMessageInput): {
    conversation: CommercialConversation; message: ConversationMessage;
  } {
    this.requireMember(organizationId,actorId);
    const conv=this.store.getConversation(organizationId,requiredText(conversationId,"conversationId",100));
    if (!conv) throw new AgencyError("NOT_FOUND","Conversation not found");
    const validDirections: MessageDirection[]=["inbound","outbound","internal_note"];
    if (!validDirections.includes(input.direction)) throw new AgencyError("VALIDATION_ERROR","Invalid message direction");
    if (conv.status==="opted_out" && input.direction==="outbound") {
      throw new AgencyError("CONSENT_REQUIRED","This conversation has opted out; outbound messages and follow-ups are blocked");
    }
    if (conv.status==="closed" && input.direction==="outbound") {
      throw new AgencyError("CONFLICT","Cannot send outbound messages on a closed conversation");
    }
    const body=requiredText(input.body,"body",4000);
    const signal=input.signal ?? classifyCommercialSignal(body);
    const now=this.now();
    let nextStatus=conv.status;
    let nextFollowUpAt=input.nextFollowUpAt == null ? conv.nextFollowUpAt : (input.nextFollowUpAt === 0 ? 0 : positiveTimestamp(input.nextFollowUpAt,"nextFollowUpAt"));
    let handoffReason=conv.handoffReason;
    if (input.direction==="inbound") {
      if (signal==="opt_out") {
        nextStatus="opted_out";
        nextFollowUpAt=0;
      } else if (signal==="needs_human") {
        nextStatus="handoff_human";
        handoffReason=handoffReason || "Inbound message requested human review";
      } else if (conv.status==="awaiting_reply") {
        nextStatus="open";
      }
    } else if (input.direction==="outbound") {
      nextStatus="awaiting_reply";
    }
    const message: ConversationMessage={
      id:this.id(), organizationId, conversationId:conv.id, direction:input.direction,
      body, signal, authorId:actorId, createdAt:now,
    };
    return this.store.transaction(() => {
      this.store.insertConversationMessage(message);
      const updated=this.store.updateConversationState(organizationId,conv.id,nextStatus,nextFollowUpAt,handoffReason,now,now)!;
      this.audit(organizationId,actorId,"conversation.message_added","conversation",conv.id,{
        messageId:message.id,direction:message.direction,signal:message.signal,status:updated.status,
      });
      return { conversation:updated, message };
    });
  }

  handoffConversation(organizationId: string, actorId: string, conversationId: string, reason: string): CommercialConversation {
    this.requireMember(organizationId,actorId);
    const conv=this.store.getConversation(organizationId,requiredText(conversationId,"conversationId",100));
    if (!conv) throw new AgencyError("NOT_FOUND","Conversation not found");
    if (conv.status==="opted_out") throw new AgencyError("CONFLICT","Opted-out conversation cannot be reopened for outreach");
    const cleanReason=requiredText(reason,"reason",500);
    const now=this.now();
    return this.store.transaction(() => {
      const updated=this.store.updateConversationState(organizationId,conv.id,"handoff_human",0,cleanReason,conv.lastMessageAt,now)!;
      this.audit(organizationId,actorId,"conversation.handoff_human","conversation",conv.id,{reason:cleanReason});
      return updated;
    });
  }

  upsertNeedsQualification(organizationId: string, actorId: string, leadId: string, input: UpsertNeedsQualificationInput): NeedsQualification {
    this.requireMember(organizationId,actorId);
    const cleanLeadId=requiredText(leadId,"leadId",100);
    if (!this.store.getLead(organizationId,cleanLeadId)) throw new AgencyError("NOT_FOUND","Lead not found");
    if (!SOLUTION_TYPES.includes(input.solutionType)) throw new AgencyError("VALIDATION_ERROR","Unsupported solutionType");
    const budgetMin=nonNegativeNumber(input.budgetMin,"budgetMin",0);
    const budgetMax=nonNegativeNumber(input.budgetMax,"budgetMax",0);
    if (budgetMax > 0 && budgetMax < budgetMin) throw new AgencyError("VALIDATION_ERROR","budgetMax cannot be below budgetMin");
    const existing=this.store.getNeedsQualification(organizationId,cleanLeadId);
    const now=this.now();
    const record: NeedsQualification={
      organizationId, leadId:cleanLeadId,
      problemStatement:requiredText(input.problemStatement,"problemStatement",4000),
      targetUsers:optionalText(input.targetUsers,"targetUsers",1000),
      solutionType:input.solutionType,
      mustHaveFeatures:stringList(input.mustHaveFeatures,"mustHaveFeatures"),
      niceToHaveFeatures:stringList(input.niceToHaveFeatures,"niceToHaveFeatures"),
      constraints:stringList(input.constraints,"constraints"),
      desiredTimeline:optionalText(input.desiredTimeline,"desiredTimeline",200),
      budgetMin, budgetMax,
      assumptions:stringList(input.assumptions,"assumptions"),
      unknowns:stringList(input.unknowns,"unknowns"),
      risks:stringList(input.risks,"risks"),
      recommendedSolution:optionalText(input.recommendedSolution,"recommendedSolution",2000),
      clientConfirmed:input.clientConfirmed === true,
      createdAt:existing?.createdAt ?? now,
      updatedAt:now,
    };
    return this.store.transaction(() => {
      const saved=this.store.upsertNeedsQualification(record);
      this.audit(organizationId,actorId,"lead.needs_qualified","lead",cleanLeadId,{
        solutionType:saved.solutionType,clientConfirmed:saved.clientConfirmed,
        mustHaveCount:saved.mustHaveFeatures.length,unknownCount:saved.unknowns.length,
      });
      return saved;
    });
  }

  getNeedsQualification(organizationId: string, actorId: string, leadId: string): NeedsQualification | undefined {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    const cleanLeadId=requiredText(leadId,"leadId",100);
    if (!this.store.getLead(organizationId,cleanLeadId)) throw new AgencyError("NOT_FOUND","Lead not found");
    return this.store.getNeedsQualification(organizationId,cleanLeadId);
  }

  listNeedsQualifications(organizationId: string, actorId: string, limit = 100): NeedsQualification[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    return this.store.listNeedsQualifications(organizationId,limit);
  }

  createCatalogItem(organizationId: string, actorId: string, input: CreateCatalogItemInput): ServiceCatalogItem {
    this.requireMember(organizationId,actorId,["owner","admin"]);
    const code=requiredText(input.code,"code",60).toLowerCase();
    if (!/^[a-z0-9_-]{2,60}$/.test(code)) throw new AgencyError("VALIDATION_ERROR","Catalog code must be alphanumeric with dashes/underscores");
    if (this.store.getCatalogItemByCode(organizationId,code)) throw new AgencyError("CONFLICT","A catalog item with this code already exists");
    if (!SOLUTION_TYPES.includes(input.category)) throw new AgencyError("VALIDATION_ERROR","Unsupported catalog category");
    const estimatedDays=nonNegativeNumber(input.estimatedDays,"estimatedDays");
    if (estimatedDays <= 0) throw new AgencyError("VALIDATION_ERROR","estimatedDays must be positive");
    const priceMin=nonNegativeNumber(input.priceMin,"priceMin");
    const priceBase=nonNegativeNumber(input.priceBase,"priceBase");
    const priceMax=nonNegativeNumber(input.priceMax,"priceMax");
    const estimatedCost=nonNegativeNumber(input.estimatedCost,"estimatedCost");
    if (priceBase < priceMin || (priceMax > 0 && priceMax < priceBase)) {
      throw new AgencyError("VALIDATION_ERROR","Catalog prices must satisfy priceMin <= priceBase <= priceMax");
    }
    const now=this.now();
    const item: ServiceCatalogItem={
      id:this.id(), organizationId, code, name:requiredText(input.name,"name",160),
      category:input.category, description:requiredText(input.description,"description",2000),
      defaultScope:optionalText(input.defaultScope,"defaultScope",2000),
      exclusions:stringList(input.exclusions,"exclusions"),
      estimatedDays, priceMin, priceBase, priceMax, estimatedCost,
      paymentTerms:optionalText(input.paymentTerms,"paymentTerms",500),
      maintenanceTerms:optionalText(input.maintenanceTerms,"maintenanceTerms",500),
      active:input.active !== false, createdAt:now, updatedAt:now,
    };
    return this.store.transaction(() => {
      this.store.insertCatalogItem(item);
      this.audit(organizationId,actorId,"catalog.item_created","catalog_item",item.id,{
        code:item.code,name:item.name,priceBase:item.priceBase,estimatedCost:item.estimatedCost,
      });
      return item;
    });
  }

  listCatalogItems(organizationId: string, actorId: string, activeOnly = false): ServiceCatalogItem[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    return this.store.listCatalogItems(organizationId,activeOnly);
  }

  updateCatalogItem(organizationId: string, actorId: string, itemId: string, input: UpdateCatalogItemInput): ServiceCatalogItem {
    this.requireMember(organizationId,actorId,["owner","admin"]);
    const current=this.store.getCatalogItem(organizationId,requiredText(itemId,"itemId",100));
    if (!current) throw new AgencyError("NOT_FOUND","Catalog item not found");
    const category=input.category ?? current.category;
    if (!SOLUTION_TYPES.includes(category)) throw new AgencyError("VALIDATION_ERROR","Unsupported catalog category");
    const estimatedDays=input.estimatedDays == null ? current.estimatedDays : nonNegativeNumber(input.estimatedDays,"estimatedDays");
    if (estimatedDays <= 0) throw new AgencyError("VALIDATION_ERROR","estimatedDays must be positive");
    const priceMin=input.priceMin == null ? current.priceMin : nonNegativeNumber(input.priceMin,"priceMin");
    const priceBase=input.priceBase == null ? current.priceBase : nonNegativeNumber(input.priceBase,"priceBase");
    const priceMax=input.priceMax == null ? current.priceMax : nonNegativeNumber(input.priceMax,"priceMax");
    const estimatedCost=input.estimatedCost == null ? current.estimatedCost : nonNegativeNumber(input.estimatedCost,"estimatedCost");
    if (priceBase < priceMin || (priceMax > 0 && priceMax < priceBase)) {
      throw new AgencyError("VALIDATION_ERROR","Catalog prices must satisfy priceMin <= priceBase <= priceMax");
    }
    const next: ServiceCatalogItem={
      ...current,
      name:input.name == null ? current.name : requiredText(input.name,"name",160),
      category,
      description:input.description == null ? current.description : requiredText(input.description,"description",2000),
      defaultScope:input.defaultScope == null ? current.defaultScope : optionalText(input.defaultScope,"defaultScope",2000),
      exclusions:input.exclusions == null ? current.exclusions : stringList(input.exclusions,"exclusions"),
      estimatedDays, priceMin, priceBase, priceMax, estimatedCost,
      paymentTerms:input.paymentTerms == null ? current.paymentTerms : optionalText(input.paymentTerms,"paymentTerms",500),
      maintenanceTerms:input.maintenanceTerms == null ? current.maintenanceTerms : optionalText(input.maintenanceTerms,"maintenanceTerms",500),
      active:input.active == null ? current.active : Boolean(input.active),
      updatedAt:this.now(),
    };
    return this.store.transaction(() => {
      const updated=this.store.updateCatalogItem(next);
      this.audit(organizationId,actorId,"catalog.item_updated","catalog_item",updated.id,{
        priceBase:updated.priceBase,estimatedCost:updated.estimatedCost,active:updated.active,
      });
      return updated;
    });
  }

  getCommercialRules(organizationId: string, actorId: string): CommercialRules {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    const stored=this.store.getCommercialRules(organizationId);
    if (stored) return stored;
    const now=this.now();
    return {
      organizationId, minMarginPct:30, maxAutonomousDiscountPct:10, defaultDepositPct:30,
      requireOwnerApprovalAboveAmount:0, paymentTermsDefault:"30% acompte à la signature, 70% à la livraison",
      createdAt:now, updatedAt:now,
    };
  }

  updateCommercialRules(organizationId: string, actorId: string, input: UpdateCommercialRulesInput): CommercialRules {
    this.requireMember(organizationId,actorId,["owner","admin"]);
    const current=this.getCommercialRules(organizationId,actorId);
    const minMarginPct=input.minMarginPct == null ? current.minMarginPct : nonNegativeNumber(input.minMarginPct,"minMarginPct");
    if (minMarginPct > 95) throw new AgencyError("VALIDATION_ERROR","minMarginPct cannot exceed 95");
    const maxAutonomousDiscountPct=input.maxAutonomousDiscountPct == null
      ? current.maxAutonomousDiscountPct : nonNegativeNumber(input.maxAutonomousDiscountPct,"maxAutonomousDiscountPct");
    if (maxAutonomousDiscountPct > 100) throw new AgencyError("VALIDATION_ERROR","maxAutonomousDiscountPct cannot exceed 100");
    const defaultDepositPct=input.defaultDepositPct == null
      ? current.defaultDepositPct : nonNegativeNumber(input.defaultDepositPct,"defaultDepositPct");
    if (defaultDepositPct > 100) throw new AgencyError("VALIDATION_ERROR","defaultDepositPct cannot exceed 100");
    const requireOwnerApprovalAboveAmount=input.requireOwnerApprovalAboveAmount == null
      ? current.requireOwnerApprovalAboveAmount : nonNegativeNumber(input.requireOwnerApprovalAboveAmount,"requireOwnerApprovalAboveAmount");
    const now=this.now();
    const rules: CommercialRules={
      organizationId, minMarginPct, maxAutonomousDiscountPct, defaultDepositPct, requireOwnerApprovalAboveAmount,
      paymentTermsDefault:input.paymentTermsDefault == null
        ? current.paymentTermsDefault : optionalText(input.paymentTermsDefault,"paymentTermsDefault",500),
      createdAt:current.createdAt, updatedAt:now,
    };
    return this.store.transaction(() => {
      const saved=this.store.upsertCommercialRules(rules);
      this.audit(organizationId,actorId,"commercial_rules.updated","organization",organizationId,{
        minMarginPct:saved.minMarginPct,maxAutonomousDiscountPct:saved.maxAutonomousDiscountPct,
        defaultDepositPct:saved.defaultDepositPct,requireOwnerApprovalAboveAmount:saved.requireOwnerApprovalAboveAmount,
      });
      return saved;
    });
  }

  previewTieredProposals(organizationId: string, actorId: string, catalogItemId: string): TieredProposalOption[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    const item=this.store.getCatalogItem(organizationId,requiredText(catalogItemId,"catalogItemId",100));
    if (!item) throw new AgencyError("NOT_FOUND","Catalog item not found");
    return buildTieredProposals(item,this.getCommercialRules(organizationId,actorId));
  }

  createQuote(organizationId: string, actorId: string, input: CreateQuoteInput): {
    quote: Quote; negotiation: NegotiationEvaluation;
  } {
    this.requireMember(organizationId,actorId);
    const org=this.store.getOrganization(organizationId)!;
    const leadId=requiredText(input.leadId,"leadId",100);
    if (!this.store.getLead(organizationId,leadId)) throw new AgencyError("NOT_FOUND","Lead not found");
    const tier=input.tier ?? "standard";
    if (!QUOTE_TIERS.includes(tier)) throw new AgencyError("VALIDATION_ERROR","Unsupported quote tier");
    const rules=this.getCommercialRules(organizationId,actorId);
    const totals=calculateQuoteTotals(input.lines,input.discountPct ?? 0,input.uncertaintyPct ?? 15);
    const negotiation=evaluateNegotiation(totals,totals.discountPct,rules);
    const validUntil=input.validUntil == null ? this.now() + 30 * 24 * 3600_000 : positiveTimestamp(input.validUntil,"validUntil");
    const now=this.now();
    return this.store.transaction(() => {
      const version=this.store.nextQuoteVersion(organizationId,leadId);
      const quote: Quote={
        id:this.id(), organizationId, leadId, version,
        title:requiredText(input.title,"title",240),
        tier, currency:org.currency, lines:input.lines,
        exclusions:stringList(input.exclusions,"exclusions"),
        paymentTerms:optionalText(input.paymentTerms,"paymentTerms",500) || rules.paymentTermsDefault,
        deliveryDays:totals.totalDays,
        discountPct:totals.discountPct, subtotal:totals.subtotal, discountAmount:totals.discountAmount,
        netTotal:totals.netTotal, estimatedCost:totals.estimatedCost, grossMargin:totals.grossMargin,
        marginPct:totals.marginPct, rangeLow:totals.rangeLow, rangeHigh:totals.rangeHigh,
        status:"draft", approvalId:"", validUntil, createdAt:now, updatedAt:now,
      };
      this.store.insertQuote(quote);
      this.audit(organizationId,actorId,"quote.created","quote",quote.id,{
        leadId:quote.leadId,version:quote.version,netTotal:quote.netTotal,
        marginPct:quote.marginPct,requiresOwnerApproval:negotiation.requiresOwnerApproval,
      });
      return { quote, negotiation };
    });
  }

  listQuotes(organizationId: string, actorId: string, leadId?: string): Quote[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    return this.store.listQuotes(organizationId,leadId ? requiredText(leadId,"leadId",100) : undefined);
  }

  getQuote(organizationId: string, actorId: string, quoteId: string): Quote {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    const quote=this.store.getQuote(organizationId,requiredText(quoteId,"quoteId",100));
    if (!quote) throw new AgencyError("NOT_FOUND","Quote not found");
    return quote;
  }

  evaluateQuoteNegotiation(organizationId: string, actorId: string, quoteId: string, requestedDiscountPct: number): NegotiationEvaluation {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    const quote=this.getQuote(organizationId,actorId,quoteId);
    const rules=this.getCommercialRules(organizationId,actorId);
    const totals=calculateQuoteTotals(quote.lines,quote.discountPct);
    return evaluateNegotiation(totals,requestedDiscountPct,rules);
  }

  requestQuoteApproval(organizationId: string, actorId: string, quoteId: string, reason: string): {
    quote: Quote; approval: Approval;
  } {
    this.requireMember(organizationId,actorId);
    const quote=this.store.getQuote(organizationId,requiredText(quoteId,"quoteId",100));
    if (!quote) throw new AgencyError("NOT_FOUND","Quote not found");
    if (quote.status!=="draft" && quote.status!=="pending_approval") {
      throw new AgencyError("CONFLICT",`Quote cannot request approval from status ${quote.status}`);
    }
    const approval=this.requestApproval(organizationId,actorId,{
      action:"send_quote", resourceType:"quote", resourceId:quote.id,
      reason:requiredText(reason,"reason",1000),
      payload:quoteApprovalPayload(quote),
    });
    const updated=this.store.transaction(() => {
      const saved=this.store.updateQuoteStatus(organizationId,quote.id,"pending_approval",approval.id,this.now())!;
      this.audit(organizationId,actorId,"quote.approval_requested","quote",quote.id,{approvalId:approval.id});
      return saved;
    });
    return { quote:updated, approval };
  }

  sendQuote(organizationId: string, actorId: string, quoteId: string): Quote {
    this.requireMember(organizationId,actorId);
    const quote=this.store.getQuote(organizationId,requiredText(quoteId,"quoteId",100));
    if (!quote) throw new AgencyError("NOT_FOUND","Quote not found");
    if (quote.status!=="pending_approval" && quote.status!=="approved" && quote.status!=="draft") {
      throw new AgencyError("CONFLICT",`Quote cannot be sent from status ${quote.status}`);
    }
    if (!quote.approvalId) throw new AgencyError("FORBIDDEN","Owner approval is required before sending a quote");
    const approval=this.store.getApproval(organizationId,quote.approvalId);
    const expectedHash=stablePayloadHash(quoteApprovalPayload(quote)).hash;
    if (!approval || approval.action!=="send_quote" || approval.resourceType!=="quote" || approval.resourceId!==quote.id
      || approval.status!=="approved" || approval.payloadHash!==expectedHash || (approval.expiresAt && approval.expiresAt<=this.now())) {
      throw new AgencyError("APPROVAL_EXPIRED","A current approved send_quote approval matching the exact quote is required");
    }
    return this.store.transaction(() => {
      const updated=this.store.updateQuoteStatus(organizationId,quote.id,"sent",quote.approvalId,this.now())!;
      this.audit(organizationId,actorId,"quote.sent","quote",quote.id,{version:quote.version,netTotal:quote.netTotal});
      return updated;
    });
  }

  recordQuoteDecision(organizationId: string, actorId: string, quoteId: string, decision: "accepted" | "rejected" | "expired"): Quote {
    this.requireMember(organizationId,actorId);
    const quote=this.store.getQuote(organizationId,requiredText(quoteId,"quoteId",100));
    if (!quote) throw new AgencyError("NOT_FOUND","Quote not found");
    if (quote.status!=="sent" && quote.status!=="approved") {
      throw new AgencyError("CONFLICT",`Quote must be sent before recording decision ${decision}`);
    }
    if (decision!=="accepted" && decision!=="rejected" && decision!=="expired") {
      throw new AgencyError("VALIDATION_ERROR","Invalid quote decision");
    }
    return this.store.transaction(() => {
      const updated=this.store.updateQuoteStatus(organizationId,quote.id,decision,quote.approvalId,this.now())!;
      this.audit(organizationId,actorId,`quote.${decision}`,"quote",quote.id,{version:quote.version,netTotal:quote.netTotal});
      return updated;
    });
  }

  createContractFromQuote(organizationId: string, actorId: string, input: CreateContractInput): Contract {
    this.requireMember(organizationId,actorId);
    const quote=this.store.getQuote(organizationId,requiredText(input.quoteId,"quoteId",100));
    if (!quote) throw new AgencyError("NOT_FOUND","Quote not found");
    if (quote.status!=="accepted") {
      throw new AgencyError("CONFLICT","A contract can only be created from an accepted quote");
    }
    const rules=this.getCommercialRules(organizationId,actorId);
    const depositAmount=input.depositAmount == null
      ? Math.round((quote.netTotal * (rules.defaultDepositPct / 100) + Number.EPSILON) * 100) / 100
      : nonNegativeNumber(input.depositAmount,"depositAmount");
    if (depositAmount > quote.netTotal) throw new AgencyError("VALIDATION_ERROR","depositAmount cannot exceed contract totalAmount");
    const deliverables=input.deliverables == null
      ? quote.lines.map(l=>l.label)
      : stringList(input.deliverables,"deliverables");
    const now=this.now();
    const contract: Contract={
      id:this.id(), organizationId, leadId:quote.leadId, quoteId:quote.id,
      title:optionalText(input.title,"title",240) || `Contrat — ${quote.title}`,
      scopeSummary:optionalText(input.scopeSummary,"scopeSummary",4000) || quote.lines.map(l=>l.label).join(", "),
      deliverables, paymentTerms:optionalText(input.paymentTerms,"paymentTerms",500) || quote.paymentTerms,
      totalAmount:quote.netTotal, depositAmount, depositStatus:"unpaid", depositReference:"",
      currency:quote.currency, status:"draft", approvalId:"", signedAt:0, createdAt:now, updatedAt:now,
    };
    return this.store.transaction(() => {
      this.store.insertContract(contract);
      this.audit(organizationId,actorId,"contract.draft_created","contract",contract.id,{
        quoteId:contract.quoteId,leadId:contract.leadId,totalAmount:contract.totalAmount,depositAmount:contract.depositAmount,
      });
      return contract;
    });
  }

  listContracts(organizationId: string, actorId: string, leadId?: string): Contract[] {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    return this.store.listContracts(organizationId,leadId ? requiredText(leadId,"leadId",100) : undefined);
  }

  getContract(organizationId: string, actorId: string, contractId: string): Contract {
    this.requireMember(organizationId,actorId,["owner","admin","member","auditor"]);
    const contract=this.store.getContract(organizationId,requiredText(contractId,"contractId",100));
    if (!contract) throw new AgencyError("NOT_FOUND","Contract not found");
    return contract;
  }

  requestContractApproval(organizationId: string, actorId: string, contractId: string, reason: string): {
    contract: Contract; approval: Approval;
  } {
    this.requireMember(organizationId,actorId);
    const contract=this.store.getContract(organizationId,requiredText(contractId,"contractId",100));
    if (!contract) throw new AgencyError("NOT_FOUND","Contract not found");
    if (contract.status!=="draft" && contract.status!=="pending_approval") {
      throw new AgencyError("CONFLICT",`Contract cannot request signature approval from status ${contract.status}`);
    }
    const approval=this.requestApproval(organizationId,actorId,{
      action:"sign_contract", resourceType:"contract", resourceId:contract.id,
      reason:requiredText(reason,"reason",1000),
      payload:contractApprovalPayload(contract),
    });
    const updated=this.store.transaction(() => {
      const saved=this.store.updateContractStatus(organizationId,contract.id,"pending_approval",approval.id,0,this.now())!;
      this.audit(organizationId,actorId,"contract.approval_requested","contract",contract.id,{approvalId:approval.id});
      return saved;
    });
    return { contract:updated, approval };
  }

  markContractSigned(organizationId: string, actorId: string, contractId: string): Contract {
    this.requireMember(organizationId,actorId,["owner"]);
    const contract=this.store.getContract(organizationId,requiredText(contractId,"contractId",100));
    if (!contract) throw new AgencyError("NOT_FOUND","Contract not found");
    if (contract.status==="signed") throw new AgencyError("CONFLICT","Contract is already signed");
    if (contract.status==="cancelled") throw new AgencyError("CONFLICT","Cancelled contract cannot be signed");
    if (!contract.approvalId) throw new AgencyError("FORBIDDEN","Owner sign_contract approval is required before signing");
    const approval=this.store.getApproval(organizationId,contract.approvalId);
    const expectedHash=stablePayloadHash(contractApprovalPayload(contract)).hash;
    if (!approval || approval.action!=="sign_contract" || approval.resourceType!=="contract" || approval.resourceId!==contract.id
      || approval.status!=="approved" || approval.payloadHash!==expectedHash || (approval.expiresAt && approval.expiresAt<=this.now())) {
      throw new AgencyError("APPROVAL_EXPIRED","A current approved sign_contract approval matching the exact contract is required");
    }
    const now=this.now();
    return this.store.transaction(() => {
      const signed=this.store.updateContractStatus(organizationId,contract.id,"signed",contract.approvalId,now,now)!;
      this.audit(organizationId,actorId,"contract.signed","contract",contract.id,{
        quoteId:contract.quoteId,leadId:contract.leadId,totalAmount:contract.totalAmount,signedAt:now,
      });
      return signed;
    });
  }

  recordContractDeposit(organizationId: string, actorId: string, contractId: string, status: DepositStatus, reference: string): Contract {
    this.requireMember(organizationId,actorId,["owner"]);
    const contract=this.store.getContract(organizationId,requiredText(contractId,"contractId",100));
    if (!contract) throw new AgencyError("NOT_FOUND","Contract not found");
    if (contract.status!=="signed") throw new AgencyError("CONFLICT","Contract must be signed before recording deposit payment");
    if (status!=="paid" && status!=="unpaid") throw new AgencyError("VALIDATION_ERROR","Invalid deposit status");
    const cleanRef=status==="paid" ? requiredText(reference,"reference",200) : optionalText(reference,"reference",200);
    return this.store.transaction(() => {
      const updated=this.store.updateContractDeposit(organizationId,contract.id,status,cleanRef,this.now())!;
      this.audit(organizationId,actorId,"contract.deposit_updated","contract",contract.id,{
        depositStatus:updated.depositStatus,depositReference:updated.depositReference,depositAmount:updated.depositAmount,
      });
      return updated;
    });
  }

  private sanitizeWorkspacePath(raw: string | undefined, contractId: string): string {
    const trimmed = optionalText(raw, "workspacePath", 300);
    if (!trimmed) return `workspaces/projects/${contractId}`;
    const normalized = trimmed.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0 || parts.some((p) => p === ".." || p === ".")) {
      throw new AgencyError("VALIDATION_ERROR", "workspacePath cannot contain path traversal segments");
    }
    return normalized;
  }

  private scopeChangeApprovalPayload(sc: ScopeChange): Record<string, unknown> {
    return {
      scopeChangeId: sc.id,
      projectId: sc.projectId,
      title: sc.title,
      budgetDelta: sc.budgetDelta,
      daysDelta: sc.daysDelta,
    };
  }

  private deliveryApprovalPayload(delivery: ProjectDelivery, project: Project, gate: QaGateEvaluation): Record<string, unknown> {
    return {
      deliveryId: delivery.id,
      projectId: project.id,
      version: delivery.version,
      environmentUrl: delivery.environmentUrl,
      verifiedLots: gate.verifiedLots,
      totalLots: gate.totalLots,
      passedCategories: gate.passedCategories,
    };
  }

  createProjectFromContract(organizationId: string, actorId: string, input: CreateProjectInput): Project {
    this.requireMember(organizationId, actorId);
    const contractId = requiredText(input.contractId, "contractId", 100);
    const contract = this.store.getContract(organizationId, contractId);
    if (!contract) throw new AgencyError("NOT_FOUND", "Contract not found");
    if (contract.status !== "signed") {
      throw new AgencyError("CONFLICT", "Contract must be signed before production handoff");
    }
    if (contract.depositAmount > 0 && contract.depositStatus !== "paid") {
      throw new AgencyError("CONFLICT", "Contract deposit must be paid before production handoff");
    }
    if (this.store.getProjectByContract(organizationId, contract.id)) {
      throw new AgencyError("CONFLICT", "A project already exists for this contract");
    }

    const quote = this.store.getQuote(organizationId, contract.quoteId);
    const needs = this.store.getNeedsQualification(organizationId, contract.leadId);
    const estimatedDays = input.estimatedDays == null
      ? Math.max(1, quote?.deliveryDays ?? 14)
      : Math.max(1, Math.round(nonNegativeNumber(input.estimatedDays, "estimatedDays", 1)));
    const targetStack = input.targetStack != null
      ? stringList(input.targetStack, "targetStack", 20, 80)
      : (needs?.solutionType ? [needs.solutionType, "typescript", "sqlite"] : ["typescript", "web"]);
    const technicalSpecs = optionalText(input.technicalSpecs, "technicalSpecs", 8000)
      || [
        `Scope: ${contract.scopeSummary}`,
        contract.deliverables.length > 0 ? `Deliverables: ${contract.deliverables.join(", ")}` : "",
        needs?.problemStatement ? `Needs: ${needs.problemStatement}` : "",
      ].filter(Boolean).join("\n");
    const handoffSummary = optionalText(input.handoffSummary, "handoffSummary", 2000)
      || `Signed contract ${contract.id} handed off to production.`;
    const now = this.now();
    const project: Project = {
      id: this.id(),
      organizationId,
      leadId: contract.leadId,
      contractId: contract.id,
      title: optionalText(input.title, "title", 240) || contract.title.replace(/^Contrat\s*—\s*/i, ""),
      status: "handoff_pending",
      workspacePath: this.sanitizeWorkspacePath(input.workspacePath, contract.id),
      technicalSpecs,
      targetStack,
      budgetAmount: contract.totalAmount,
      currency: contract.currency,
      estimatedDays,
      handoffSummary,
      handoffAt: now,
      deliveredAt: null,
      acceptedAt: null,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.insertProject(project);
      this.audit(organizationId, actorId, "project.handoff_created", "project", project.id, {
        contractId: project.contractId,
        leadId: project.leadId,
        workspacePath: project.workspacePath,
        budgetAmount: project.budgetAmount,
      });
      return project;
    });
  }

  listProjects(organizationId: string, actorId: string, status?: ProjectStatus): Project[] {
    this.requireMember(organizationId, actorId, ["owner", "admin", "member", "auditor"]);
    if (status !== undefined) {
      const allowed: ProjectStatus[] = [
        "handoff_pending", "scoping", "in_progress", "qa_review",
        "ready_for_delivery", "delivered", "accepted", "maintenance", "archived",
      ];
      if (!allowed.includes(status)) throw new AgencyError("VALIDATION_ERROR", "Invalid project status");
    }
    return this.store.listProjects(organizationId, status);
  }

  getProject(organizationId: string, actorId: string, projectId: string): Project {
    this.requireMember(organizationId, actorId, ["owner", "admin", "member", "auditor"]);
    const project = this.store.getProject(organizationId, requiredText(projectId, "projectId", 100));
    if (!project) throw new AgencyError("NOT_FOUND", "Project not found");
    return project;
  }

  transitionProject(organizationId: string, actorId: string, projectId: string, toStatus: ProjectStatus): Project {
    this.requireMember(organizationId, actorId);
    const project = this.getProject(organizationId, actorId, projectId);
    assertProjectTransition(project.status, toStatus);
    if (toStatus === "ready_for_delivery" || toStatus === "delivered") {
      const gate = evaluateQaGate(
        this.store.listProjectLots(organizationId, project.id),
        this.store.listQaChecks(organizationId, project.id),
      );
      if (!gate.readyForDelivery) {
        throw new AgencyError("CONFLICT", `QA gate failed: ${gate.blockers.join(", ")}`, { gate });
      }
    }
    const now = this.now();
    return this.store.transaction(() => {
      const updated = this.store.updateProjectState(organizationId, project.id, {
        status: toStatus,
        deliveredAt: toStatus === "delivered" && project.deliveredAt === null ? now : undefined,
        acceptedAt: toStatus === "accepted" && project.acceptedAt === null ? now : undefined,
        updatedAt: now,
      })!;
      this.audit(organizationId, actorId, "project.transitioned", "project", project.id, {
        from: project.status,
        to: toStatus,
      });
      return updated;
    });
  }

  createProjectLot(organizationId: string, actorId: string, projectId: string, input: CreateProjectLotInput): ProjectLot {
    this.requireMember(organizationId, actorId);
    const project = this.getProject(organizationId, actorId, projectId);
    const ownerRole = input.ownerRole ?? "developer";
    getAgentProfile(ownerRole);
    const existingLots = this.store.listProjectLots(organizationId, project.id);
    const lotOrder = input.lotOrder == null
      ? existingLots.length + 1
      : Math.max(1, Math.round(nonNegativeNumber(input.lotOrder, "lotOrder", 1)));
    const estimatedHours = nonNegativeNumber(input.estimatedHours, "estimatedHours", 8);
    const now = this.now();
    const lot: ProjectLot = {
      id: this.id(),
      organizationId,
      projectId: project.id,
      lotOrder,
      title: requiredText(input.title, "title", 240),
      description: optionalText(input.description, "description", 4000),
      acceptanceCriteria: stringList(input.acceptanceCriteria, "acceptanceCriteria", 30, 300),
      dependencies: stringList(input.dependencies, "dependencies", 30, 120),
      ownerRole,
      status: "pending",
      estimatedHours,
      actualHours: 0,
      evidenceSummary: "",
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.insertProjectLot(lot);
      this.audit(organizationId, actorId, "project_lot.created", "project_lot", lot.id, {
        projectId: project.id,
        lotOrder: lot.lotOrder,
        ownerRole: lot.ownerRole,
      });
      return lot;
    });
  }

  listProjectLots(organizationId: string, actorId: string, projectId: string): ProjectLot[] {
    const project = this.getProject(organizationId, actorId, projectId);
    return this.store.listProjectLots(organizationId, project.id);
  }

  updateProjectLot(
    organizationId: string,
    actorId: string,
    projectId: string,
    lotId: string,
    input: UpdateProjectLotInput,
  ): ProjectLot {
    this.requireMember(organizationId, actorId);
    const project = this.getProject(organizationId, actorId, projectId);
    const lot = this.store.getProjectLot(organizationId, requiredText(lotId, "lotId", 100));
    if (!lot || lot.projectId !== project.id) throw new AgencyError("NOT_FOUND", "Project lot not found");

    const allowedStatuses: ProjectLotStatus[] = ["pending", "in_progress", "in_qa", "verified", "done", "blocked"];
    const nextStatus = input.status ?? lot.status;
    if (!allowedStatuses.includes(nextStatus)) {
      throw new AgencyError("VALIDATION_ERROR", "Invalid project lot status");
    }
    if (input.ownerRole !== undefined) getAgentProfile(input.ownerRole);
    const nextEvidence = input.evidenceSummary !== undefined
      ? optionalText(input.evidenceSummary, "evidenceSummary", 4000)
      : lot.evidenceSummary;
    if ((nextStatus === "verified" || nextStatus === "done") && !nextEvidence.trim()) {
      throw new AgencyError("VALIDATION_ERROR", "Verified or done project lots require evidenceSummary");
    }
    const nextHours = input.actualHours !== undefined
      ? nonNegativeNumber(input.actualHours, "actualHours", 0)
      : lot.actualHours;
    return this.store.transaction(() => {
      const updated = this.store.updateProjectLot(organizationId, lot.id, {
        status: nextStatus,
        actualHours: nextHours,
        evidenceSummary: nextEvidence,
        ownerRole: input.ownerRole,
        updatedAt: this.now(),
      })!;
      this.audit(organizationId, actorId, "project_lot.updated", "project_lot", lot.id, {
        projectId: project.id,
        status: updated.status,
        actualHours: updated.actualHours,
      });
      return updated;
    });
  }

  generateLotExecutionBrief(
    organizationId: string,
    actorId: string,
    projectId: string,
    lotId: string,
    preferredTool?: string,
  ): { brief: string; detectedTools: DetectedDevTool[] } {
    const project = this.getProject(organizationId, actorId, projectId);
    const lot = this.store.getProjectLot(organizationId, requiredText(lotId, "lotId", 100));
    if (!lot || lot.projectId !== project.id) throw new AgencyError("NOT_FOUND", "Project lot not found");
    const detectedTools = detectLocalDevTools();
    const brief = buildProjectExecutionBrief({
      project,
      lot,
      agentRole: lot.ownerRole,
      preferredTool: optionalText(preferredTool, "preferredTool", 80),
      availableTools: detectedTools,
    });
    return { brief, detectedTools };
  }

  proposeScopeChange(
    organizationId: string,
    actorId: string,
    projectId: string,
    input: ProposeScopeChangeInput,
  ): ScopeChange {
    this.requireMember(organizationId, actorId);
    const project = this.getProject(organizationId, actorId, projectId);
    const budgetDelta = input.budgetDelta == null ? 0 : Number(input.budgetDelta);
    const daysDelta = input.daysDelta == null ? 0 : Math.round(Number(input.daysDelta));
    if (!Number.isFinite(budgetDelta) || !Number.isFinite(daysDelta)) {
      throw new AgencyError("VALIDATION_ERROR", "budgetDelta and daysDelta must be finite numbers");
    }
    const now = this.now();
    const sc: ScopeChange = {
      id: this.id(),
      organizationId,
      projectId: project.id,
      title: requiredText(input.title, "title", 240),
      description: optionalText(input.description, "description", 4000),
      budgetDelta,
      daysDelta,
      status: "proposed",
      approvalId: null,
      requestedBy: actorId,
      decidedBy: null,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.insertScopeChange(sc);
      this.audit(organizationId, actorId, "scope_change.proposed", "scope_change", sc.id, {
        projectId: project.id,
        budgetDelta: sc.budgetDelta,
        daysDelta: sc.daysDelta,
      });
      return sc;
    });
  }

  listScopeChanges(organizationId: string, actorId: string, projectId: string): ScopeChange[] {
    const project = this.getProject(organizationId, actorId, projectId);
    return this.store.listScopeChanges(organizationId, project.id);
  }

  requestScopeChangeApproval(
    organizationId: string,
    actorId: string,
    projectId: string,
    scopeChangeId: string,
    reason: string,
  ): { scopeChange: ScopeChange; approval: Approval } {
    this.requireMember(organizationId, actorId);
    const project = this.getProject(organizationId, actorId, projectId);
    const sc = this.store.getScopeChange(organizationId, requiredText(scopeChangeId, "scopeChangeId", 100));
    if (!sc || sc.projectId !== project.id) throw new AgencyError("NOT_FOUND", "Scope change not found");
    if (sc.status !== "proposed" && sc.status !== "approval_requested") {
      throw new AgencyError("CONFLICT", `Scope change cannot request approval from status ${sc.status}`);
    }
    const approval = this.requestApproval(organizationId, actorId, {
      projectId: project.id,
      action: "change_scope",
      resourceType: "scope_change",
      resourceId: sc.id,
      reason: requiredText(reason, "reason", 1000),
      payload: this.scopeChangeApprovalPayload(sc),
    });
    const updated = this.store.transaction(() => {
      const saved = this.store.updateScopeChangeStatus(
        organizationId, sc.id, "approval_requested", approval.id, null, null, this.now(),
      )!;
      this.audit(organizationId, actorId, "scope_change.approval_requested", "scope_change", sc.id, {
        projectId: project.id,
        approvalId: approval.id,
      });
      return saved;
    });
    return { scopeChange: updated, approval };
  }

  applyApprovedScopeChange(
    organizationId: string,
    actorId: string,
    projectId: string,
    scopeChangeId: string,
  ): { scopeChange: ScopeChange; project: Project } {
    this.requireMember(organizationId, actorId, ["owner", "admin"]);
    const project = this.getProject(organizationId, actorId, projectId);
    const sc = this.store.getScopeChange(organizationId, requiredText(scopeChangeId, "scopeChangeId", 100));
    if (!sc || sc.projectId !== project.id) throw new AgencyError("NOT_FOUND", "Scope change not found");
    if (sc.status === "applied") throw new AgencyError("CONFLICT", "Scope change is already applied");
    if (!sc.approvalId) throw new AgencyError("FORBIDDEN", "Owner change_scope approval is required before applying");
    const approval = this.store.getApproval(organizationId, sc.approvalId);
    const expectedHash = stablePayloadHash(this.scopeChangeApprovalPayload(sc)).hash;
    if (
      !approval ||
      approval.action !== "change_scope" ||
      approval.resourceType !== "scope_change" ||
      approval.resourceId !== sc.id ||
      approval.status !== "approved" ||
      approval.payloadHash !== expectedHash ||
      (approval.expiresAt && approval.expiresAt <= this.now())
    ) {
      throw new AgencyError("APPROVAL_EXPIRED", "A current approved change_scope approval matching this scope change is required");
    }
    const now = this.now();
    return this.store.transaction(() => {
      const nextBudget = Math.max(0, Math.round((project.budgetAmount + sc.budgetDelta) * 100) / 100);
      const nextDays = Math.max(1, project.estimatedDays + sc.daysDelta);
      const updatedProject = this.store.updateProjectState(organizationId, project.id, {
        budgetAmount: nextBudget,
        estimatedDays: nextDays,
        updatedAt: now,
      })!;
      const updatedSc = this.store.updateScopeChangeStatus(
        organizationId,
        sc.id,
        "applied",
        sc.approvalId,
        approval.decidedBy || actorId,
        approval.decidedAt || now,
        now,
      )!;
      this.audit(organizationId, actorId, "scope_change.applied", "scope_change", sc.id, {
        projectId: project.id,
        budgetAmount: nextBudget,
        estimatedDays: nextDays,
      });
      return { scopeChange: updatedSc, project: updatedProject };
    });
  }

  recordQaCheck(organizationId: string, actorId: string, projectId: string, input: RecordQaCheckInput): QaCheck {
    this.requireMember(organizationId, actorId);
    const project = this.getProject(organizationId, actorId, projectId);
    const categories: QaCategory[] = ["functional", "technical", "ui_ux", "security"];
    if (!categories.includes(input.category)) {
      throw new AgencyError("VALIDATION_ERROR", "Unsupported QA category");
    }
    const statuses: QaCheckStatus[] = ["pending", "passed", "failed", "blocked"];
    if (!statuses.includes(input.status)) {
      throw new AgencyError("VALIDATION_ERROR", "Unsupported QA check status");
    }
    let lotId: string | null = null;
    if (input.lotId) {
      const lot = this.store.getProjectLot(organizationId, requiredText(input.lotId, "lotId", 100));
      if (!lot || lot.projectId !== project.id) throw new AgencyError("NOT_FOUND", "Referenced lot not found");
      lotId = lot.id;
    }
    const evidence = optionalText(input.evidence, "evidence", 4000);
    if (input.status === "passed" && !evidence.trim()) {
      throw new AgencyError("VALIDATION_ERROR", "A passed QA check requires verifiable evidence");
    }
    const now = this.now();
    const check: QaCheck = {
      id: this.id(),
      organizationId,
      projectId: project.id,
      lotId,
      category: input.category,
      title: requiredText(input.title, "title", 240),
      status: input.status,
      evidence,
      findings: optionalText(input.findings, "findings", 4000),
      checkedBy: actorId,
      checkedAt: input.status === "pending" ? null : now,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.insertQaCheck(check);
      this.audit(organizationId, actorId, "qa_check.recorded", "qa_check", check.id, {
        projectId: project.id,
        category: check.category,
        status: check.status,
      });
      return check;
    });
  }

  listQaChecks(organizationId: string, actorId: string, projectId: string): QaCheck[] {
    const project = this.getProject(organizationId, actorId, projectId);
    return this.store.listQaChecks(organizationId, project.id);
  }

  evaluateProjectQaGate(organizationId: string, actorId: string, projectId: string): QaGateEvaluation {
    const project = this.getProject(organizationId, actorId, projectId);
    return evaluateQaGate(
      this.store.listProjectLots(organizationId, project.id),
      this.store.listQaChecks(organizationId, project.id),
    );
  }

  prepareDelivery(
    organizationId: string,
    actorId: string,
    projectId: string,
    input: PrepareDeliveryInput,
  ): { delivery: ProjectDelivery; gate: QaGateEvaluation } {
    this.requireMember(organizationId, actorId);
    const project = this.getProject(organizationId, actorId, projectId);
    const gate = evaluateQaGate(
      this.store.listProjectLots(organizationId, project.id),
      this.store.listQaChecks(organizationId, project.id),
    );
    if (!gate.readyForDelivery) {
      throw new AgencyError("CONFLICT", `QA gate failed: ${gate.blockers.join(", ")}`, { gate });
    }
    const existing = this.store.listDeliveries(organizationId, project.id);
    const now = this.now();
    const delivery: ProjectDelivery = {
      id: this.id(),
      organizationId,
      projectId: project.id,
      version: existing.length + 1,
      status: "prepared",
      environmentUrl: optionalText(input.environmentUrl, "environmentUrl", 500),
      releaseNotes: optionalText(input.releaseNotes, "releaseNotes", 4000),
      qaSummary: `${gate.verifiedLots}/${gate.totalLots} lots verified; ${gate.passedCategories.length}/4 QA categories passed`,
      approvalId: null,
      clientFeedback: "",
      deployedAt: null,
      acceptedAt: null,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.insertDelivery(delivery);
      if (project.status === "qa_review" || project.status === "in_progress") {
        this.store.updateProjectState(organizationId, project.id, { status: "ready_for_delivery", updatedAt: now });
      }
      this.audit(organizationId, actorId, "delivery.prepared", "delivery", delivery.id, {
        projectId: project.id,
        version: delivery.version,
      });
      return { delivery, gate };
    });
  }

  listDeliveries(organizationId: string, actorId: string, projectId: string): ProjectDelivery[] {
    const project = this.getProject(organizationId, actorId, projectId);
    return this.store.listDeliveries(organizationId, project.id);
  }

  requestDeliveryApproval(
    organizationId: string,
    actorId: string,
    projectId: string,
    deliveryId: string,
    reason: string,
  ): { delivery: ProjectDelivery; approval: Approval } {
    this.requireMember(organizationId, actorId);
    const project = this.getProject(organizationId, actorId, projectId);
    const delivery = this.store.getDelivery(organizationId, requiredText(deliveryId, "deliveryId", 100));
    if (!delivery || delivery.projectId !== project.id) throw new AgencyError("NOT_FOUND", "Delivery not found");
    if (delivery.status !== "prepared" && delivery.status !== "approval_requested") {
      throw new AgencyError("CONFLICT", `Delivery cannot request approval from status ${delivery.status}`);
    }
    const gate = evaluateQaGate(
      this.store.listProjectLots(organizationId, project.id),
      this.store.listQaChecks(organizationId, project.id),
    );
    if (!gate.readyForDelivery) {
      throw new AgencyError("CONFLICT", `QA gate failed: ${gate.blockers.join(", ")}`, { gate });
    }
    const approval = this.requestApproval(organizationId, actorId, {
      projectId: project.id,
      action: "deploy_production",
      resourceType: "delivery",
      resourceId: delivery.id,
      reason: requiredText(reason, "reason", 1000),
      payload: this.deliveryApprovalPayload(delivery, project, gate),
    });
    const updated = this.store.transaction(() => {
      const saved = this.store.updateDeliveryState(organizationId, delivery.id, {
        status: "approval_requested",
        approvalId: approval.id,
        updatedAt: this.now(),
      })!;
      this.audit(organizationId, actorId, "delivery.approval_requested", "delivery", delivery.id, {
        projectId: project.id,
        approvalId: approval.id,
      });
      return saved;
    });
    return { delivery: updated, approval };
  }

  markDeliveryDeployed(
    organizationId: string,
    actorId: string,
    projectId: string,
    deliveryId: string,
  ): { delivery: ProjectDelivery; project: Project } {
    this.requireMember(organizationId, actorId, ["owner"]);
    const project = this.getProject(organizationId, actorId, projectId);
    const delivery = this.store.getDelivery(organizationId, requiredText(deliveryId, "deliveryId", 100));
    if (!delivery || delivery.projectId !== project.id) throw new AgencyError("NOT_FOUND", "Delivery not found");
    if (delivery.status === "deployed" || delivery.status === "accepted") {
      throw new AgencyError("CONFLICT", "Delivery is already deployed");
    }
    const gate = evaluateQaGate(
      this.store.listProjectLots(organizationId, project.id),
      this.store.listQaChecks(organizationId, project.id),
    );
    if (!gate.readyForDelivery) {
      throw new AgencyError("CONFLICT", `QA gate failed: ${gate.blockers.join(", ")}`, { gate });
    }
    if (!delivery.approvalId) {
      throw new AgencyError("FORBIDDEN", "Owner deploy_production approval is required before deployment");
    }
    const approval = this.store.getApproval(organizationId, delivery.approvalId);
    const expectedHash = stablePayloadHash(this.deliveryApprovalPayload(delivery, project, gate)).hash;
    if (
      !approval ||
      approval.action !== "deploy_production" ||
      approval.resourceType !== "delivery" ||
      approval.resourceId !== delivery.id ||
      approval.status !== "approved" ||
      approval.payloadHash !== expectedHash ||
      (approval.expiresAt && approval.expiresAt <= this.now())
    ) {
      throw new AgencyError("APPROVAL_EXPIRED", "A current approved deploy_production approval matching this delivery is required");
    }
    const now = this.now();
    return this.store.transaction(() => {
      const updatedDelivery = this.store.updateDeliveryState(organizationId, delivery.id, {
        status: "deployed",
        deployedAt: now,
        updatedAt: now,
      })!;
      const updatedProject = this.store.updateProjectState(organizationId, project.id, {
        status: "delivered",
        deliveredAt: project.deliveredAt ?? now,
        updatedAt: now,
      })!;
      this.audit(organizationId, actorId, "delivery.deployed", "delivery", delivery.id, {
        projectId: project.id,
        version: delivery.version,
        environmentUrl: delivery.environmentUrl,
      });
      return { delivery: updatedDelivery, project: updatedProject };
    });
  }

  recordClientAcceptance(
    organizationId: string,
    actorId: string,
    projectId: string,
    deliveryId: string,
    accepted: boolean,
    feedback: string,
  ): { delivery: ProjectDelivery; project: Project } {
    this.requireMember(organizationId, actorId);
    const project = this.getProject(organizationId, actorId, projectId);
    const delivery = this.store.getDelivery(organizationId, requiredText(deliveryId, "deliveryId", 100));
    if (!delivery || delivery.projectId !== project.id) throw new AgencyError("NOT_FOUND", "Delivery not found");
    if (delivery.status !== "deployed") {
      throw new AgencyError("CONFLICT", "Delivery must be deployed before recording client acceptance");
    }
    const cleanFeedback = optionalText(feedback, "feedback", 2000);
    const now = this.now();
    return this.store.transaction(() => {
      const updatedDelivery = this.store.updateDeliveryState(organizationId, delivery.id, {
        status: accepted ? "accepted" : "rejected",
        clientFeedback: cleanFeedback,
        acceptedAt: accepted ? now : null,
        updatedAt: now,
      })!;
      const updatedProject = this.store.updateProjectState(organizationId, project.id, {
        status: accepted ? "accepted" : "qa_review",
        acceptedAt: accepted ? now : project.acceptedAt,
        updatedAt: now,
      })!;
      this.audit(organizationId, actorId, accepted ? "delivery.accepted" : "delivery.rejected", "delivery", delivery.id, {
        projectId: project.id,
        feedback: cleanFeedback,
      });
      return { delivery: updatedDelivery, project: updatedProject };
    });
  }

  scheduleFollowUp(
    organizationId: string,
    actorId: string,
    projectId: string,
    input: ScheduleFollowUpInput,
  ): ClientFollowUp {
    this.requireMember(organizationId, actorId);
    const project = this.getProject(organizationId, actorId, projectId);
    const allowed: FollowUpType[] = ["satisfaction", "maintenance", "upsell", "support", "case_study"];
    if (!allowed.includes(input.type)) {
      throw new AgencyError("VALIDATION_ERROR", "Unsupported follow-up type");
    }
    const leadId = input.leadId ? requiredText(input.leadId, "leadId", 100) : project.leadId;
    if (leadId !== project.leadId) {
      throw new AgencyError("VALIDATION_ERROR", "Follow-up leadId must match project leadId");
    }
    const now = this.now();
    const followUp: ClientFollowUp = {
      id: this.id(),
      organizationId,
      projectId: project.id,
      leadId,
      type: input.type,
      status: "scheduled",
      dueAt: positiveTimestamp(input.dueAt, "dueAt"),
      notes: optionalText(input.notes, "notes", 2000),
      outcome: "",
      createdBy: actorId,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.insertFollowUp(followUp);
      this.audit(organizationId, actorId, "followup.scheduled", "followup", followUp.id, {
        projectId: project.id,
        type: followUp.type,
        dueAt: followUp.dueAt,
      });
      return followUp;
    });
  }

  listFollowUps(organizationId: string, actorId: string, projectId?: string): ClientFollowUp[] {
    this.requireMember(organizationId, actorId, ["owner", "admin", "member", "auditor"]);
    return this.store.listFollowUps(organizationId, projectId ? requiredText(projectId, "projectId", 100) : undefined);
  }

  updateFollowUpStatus(
    organizationId: string,
    actorId: string,
    followUpId: string,
    status: FollowUpStatus,
    outcome = "",
  ): ClientFollowUp {
    this.requireMember(organizationId, actorId);
    const existing = this.store.getFollowUp(organizationId, requiredText(followUpId, "followUpId", 100));
    if (!existing) throw new AgencyError("NOT_FOUND", "Follow-up not found");
    const allowed: FollowUpStatus[] = ["scheduled", "contacted", "completed", "dismissed"];
    if (!allowed.includes(status)) {
      throw new AgencyError("VALIDATION_ERROR", "Invalid follow-up status");
    }
    const cleanOutcome = optionalText(outcome, "outcome", 2000);
    const now = this.now();
    const completedAt = status === "completed" || status === "dismissed" ? now : null;
    return this.store.transaction(() => {
      const updated = this.store.updateFollowUp(organizationId, existing.id, status, cleanOutcome, completedAt, now)!;
      this.audit(organizationId, actorId, "followup.updated", "followup", existing.id, {
        status,
        outcome: cleanOutcome,
      });
      return updated;
    });
  }

  listAgentProfiles(organizationId: string, actorId: string): AgentProfile[] {
    this.requireMember(organizationId, actorId, ["owner", "admin", "member", "auditor"]);
    return [...AGENCY_AGENT_PROFILES];
  }

  detectDevTools(organizationId: string, actorId: string): DetectedDevTool[] {
    this.requireMember(organizationId, actorId, ["owner", "admin", "member", "auditor"]);
    return detectLocalDevTools();
  }

  createMission(organizationId: string, actorId: string, input: CreateMissionInput): AgencyMission {
    this.requireMember(organizationId, actorId);
    const profile = getAgentProfile(input.agentRole);
    let project: Project | undefined;
    if (input.projectId) {
      project = this.getProject(organizationId, actorId, input.projectId);
    }
    const leadId = input.leadId ? requiredText(input.leadId, "leadId", 100) : (project?.leadId ?? null);
    if (leadId && !this.store.getLead(organizationId, leadId)) {
      throw new AgencyError("NOT_FOUND", "Lead not found");
    }
    const title = requiredText(input.title, "title", 240);
    const objective = optionalText(input.objective, "objective", 4000) || profile.mission;
    const preferredTool = optionalText(input.preferredTool, "preferredTool", 80) || profile.defaultTools[0] || "";
    const detected = detectLocalDevTools();
    const brief = project
      ? buildProjectExecutionBrief({
        project,
        agentRole: input.agentRole,
        preferredTool,
        objective,
        availableTools: detected,
      })
      : `# Mission Brief — ${title}\n- Agent Role: ${profile.name} (${profile.role})\n- Preferred Tool: ${preferredTool}\n- Objective: ${objective}`;
    const now = this.now();
    const mission: AgencyMission = {
      id: this.id(),
      organizationId,
      projectId: project?.id ?? null,
      leadId,
      agentRole: input.agentRole,
      title,
      objective,
      status: "planned",
      preferredTool,
      brief,
      outputSummary: "",
      evidencePaths: [],
      startedAt: null,
      completedAt: null,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.insertMission(mission);
      this.audit(organizationId, actorId, "mission.created", "mission", mission.id, {
        agentRole: mission.agentRole,
        projectId: mission.projectId,
        preferredTool: mission.preferredTool,
      });
      return mission;
    });
  }

  listMissions(organizationId: string, actorId: string, projectId?: string): AgencyMission[] {
    this.requireMember(organizationId, actorId, ["owner", "admin", "member", "auditor"]);
    return this.store.listMissions(organizationId, projectId ? requiredText(projectId, "projectId", 100) : undefined);
  }

  getMission(organizationId: string, actorId: string, missionId: string): AgencyMission {
    this.requireMember(organizationId, actorId, ["owner", "admin", "member", "auditor"]);
    const mission = this.store.getMission(organizationId, requiredText(missionId, "missionId", 100));
    if (!mission) throw new AgencyError("NOT_FOUND", "Mission not found");
    return mission;
  }

  updateMissionStatus(
    organizationId: string,
    actorId: string,
    missionId: string,
    status: AgencyMissionStatus,
    outputSummary = "",
    evidencePaths?: string[],
  ): AgencyMission {
    this.requireMember(organizationId, actorId);
    const mission = this.store.getMission(organizationId, requiredText(missionId, "missionId", 100));
    if (!mission) throw new AgencyError("NOT_FOUND", "Mission not found");
    const allowed: AgencyMissionStatus[] = ["planned", "running", "blocked", "completed", "failed"];
    if (!allowed.includes(status)) {
      throw new AgencyError("VALIDATION_ERROR", "Invalid mission status");
    }
    const now = this.now();
    const nextSummary = outputSummary ? optionalText(outputSummary, "outputSummary", 4000) : mission.outputSummary;
    const nextEvidence = evidencePaths !== undefined
      ? stringList(evidencePaths, "evidencePaths", 50, 500)
      : mission.evidencePaths;
    const startedAt = status === "running" && mission.startedAt === null ? now : mission.startedAt;
    const completedAt = status === "completed" || status === "failed" ? now : null;
    return this.store.transaction(() => {
      const updated = this.store.updateMission(organizationId, mission.id, {
        status,
        outputSummary: nextSummary,
        evidencePaths: nextEvidence,
        startedAt,
        completedAt,
        updatedAt: now,
      })!;
      this.audit(organizationId, actorId, "mission.updated", "mission", mission.id, {
        status: updated.status,
        evidenceCount: updated.evidencePaths.length,
      });
      return updated;
    });
  }

  getMetrics(organizationId: string, actorId: string): AgencyMetrics {
    this.requireMember(organizationId, actorId, ["owner", "admin", "member", "auditor"]);
    return computeAgencyMetrics({
      organizationId,
      leads: this.store.searchLeads(organizationId, { limit: 500, offset: 0 }).items,
      quotes: this.store.listQuotes(organizationId),
      contracts: this.store.listContracts(organizationId),
      projects: this.store.listProjects(organizationId),
      qaChecks: this.store.listQaChecks(organizationId),
      followUps: this.store.listFollowUps(organizationId),
      missions: this.store.listMissions(organizationId),
    });
  }
}
