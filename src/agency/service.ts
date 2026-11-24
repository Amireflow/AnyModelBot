import { createHash, randomUUID } from "node:crypto";
import { AgencyError } from "./errors.js";
import { AgencyStore, stablePayloadHash } from "./store.js";
import { assertLeadTransition } from "./transitions.js";
import { assessResearchEvidence } from "./research-quality.js";
import { assessCompanyQualification } from "./qualification.js";
import type { CompanyResearchSource } from "./company-research-import.js";
import type {
  AddEvidenceInput, AgencyDashboard, Approval, ApprovalAction, AuditEvent, Company, CompanySearchFilters,
  Contact, ContactSearchFilters, CreateCompanyInput, CreateContactInput, CreateLeadInput,
  CreateOrganizationInput, Evidence, Lead, LeadSearchFilters, LeadStage, Organization,
  Page, RecordConsentInput, RequestApprovalInput, AgencyRole, ResearchAssessment,
  CompanyQualificationAssessment, QualificationProfile, ResearchDomain, UpdateQualificationProfileInput,
  QueueWhatsAppTemplateInput, WhatsAppOutboxMessage, WhatsAppWebhookProcessResult,
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
}
