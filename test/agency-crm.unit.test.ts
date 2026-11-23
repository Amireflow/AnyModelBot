import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgencyError, AgencyService, AgencyStore, type LeadStage } from "../src/agency/index.js";

describe("Agency CRM query layer and tenant integrity", () => {
  let store: AgencyStore;
  let service: AgencyService;
  let tick: number;
  let id: number;

  beforeEach(() => {
    tick=1_800_000_000_000;
    id=0;
    store=new AgencyStore(":memory:");
    service=new AgencyService(store,{now:()=>tick,id:()=>`crm-test-${++id}`});
  });
  afterEach(()=>store.close());

  function org(owner: string,name: string) {
    return service.createOrganization({name,countryCode:"SN",currency:"XOF"},owner);
  }

  it("filters, paginates and isolates company, contact and lead searches", () => {
    const a=org("owner-a","Agency A"), b=org("owner-b","Agency B");
    const clinic=service.createCompany(a.id,"owner-a",{name:"Clinique Medina",industry:"health",city:"Dakar",countryCode:"SN"});
    service.createCompany(a.id,"owner-a",{name:"Studio Baobab",industry:"creative",city:"Thies",countryCode:"SN"});
    service.createCompany(b.id,"owner-b",{name:"Clinique Medina",industry:"health",city:"Dakar",countryCode:"SN"});
    const contact=service.createContact(a.id,"owner-a",{companyId:clinic.id,displayName:"Docteure Diallo",role:"Director"});
    const lead=service.createLead(a.id,"owner-a",{companyId:clinic.id,contactId:contact.id,source:"website",notes:"Interested in a booking platform"});
    service.transitionLead(a.id,"owner-a",lead.id,"researching");

    const companies=service.searchCompanies(a.id,"owner-a",{query:"clinique",industry:"health",limit:1,offset:0});
    expect(companies.total).toBe(1);
    expect(companies.items.map(x=>x.name)).toEqual(["Clinique Medina"]);
    expect(service.searchCompanies(b.id,"owner-b",{query:"clinique"}).total).toBe(1);
    expect(service.searchContacts(a.id,"owner-a",{query:"diallo",companyId:clinic.id}).total).toBe(1);
    expect(service.searchContacts(b.id,"owner-b",{query:"diallo"}).total).toBe(0);
    expect(service.searchLeads(a.id,"owner-a",{stage:"researching",query:"booking"}).items[0].id).toBe(lead.id);
    expect(service.searchLeads(b.id,"owner-b",{query:"booking"}).total).toBe(0);
  });

  it("provides consistent dashboard counts and organization-scoped audit history", () => {
    const a=org("owner-a","Agency A");
    const company=service.createCompany(a.id,"owner-a",{name:"Acme"});
    const contact=service.createContact(a.id,"owner-a",{companyId:company.id,displayName:"Ada"});
    const lead=service.createLead(a.id,"owner-a",{companyId:company.id,contactId:contact.id});
    service.transitionLead(a.id,"owner-a",lead.id,"researching");
    expect(service.dashboard(a.id,"owner-a")).toMatchObject({
      companyCount:1,contactCount:1,leadCount:1,openLeadCount:1,wonLeadCount:0,
    });
    expect(service.dashboard(a.id,"owner-a").stageCounts.researching).toBe(1);
    expect(service.timeline(a.id,"owner-a",{entityType:"company",entityId:company.id}).map(x=>x.action)).toContain("company.created");
    expect(service.listOrganizations("owner-a").map(x=>x.id)).toEqual([a.id]);
    expect(()=>service.timeline(a.id,"owner-a",{entityType:"company"})).toThrowError(AgencyError);
  });

  it("rejects cross-organization foreign-key combinations at the database boundary", () => {
    const a=org("owner-a","Agency A"), b=org("owner-b","Agency B");
    const company=service.createCompany(a.id,"owner-a",{name:"Private Company"});
    expect(()=>store.db.prepare(
      "INSERT INTO agency_contacts(id,organization_id,company_id,display_name,role,email,phone,preferred_channel,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run("cross-tenant-contact",b.id,company.id,"Intruder","","","","","active",tick,tick)).toThrow();
  });

  it("rejects malformed consent status, invalid stages and non-JSON approval payloads", () => {
    const a=org("owner-a","Agency A");
    const company=service.createCompany(a.id,"owner-a",{name:"Acme"});
    const contact=service.createContact(a.id,"owner-a",{companyId:company.id,displayName:"Ada"});
    expect(()=>service.recordConsent(a.id,"owner-a",{
      contactId:contact.id,channel:"whatsapp",purpose:"marketing",status:"pending" as never,
      source:"form",proof:"untrusted value",
    })).toThrowError(AgencyError);
    const lead=service.createLead(a.id,"owner-a",{companyId:company.id});
    expect(()=>service.transitionLead(a.id,"owner-a",lead.id,"not-a-stage" as LeadStage)).toThrowError(AgencyError);
    const cyclic: Record<string,unknown>={};
    cyclic.self=cyclic;
    expect(()=>service.requestApproval(a.id,"owner-a",{
      action:"send_message",resourceType:"contact",resourceId:contact.id,
      reason:"Attempt invalid payload",payload:cyclic,
    })).toThrowError(AgencyError);
  });

  it("enforces bounded paging and supported filter values", () => {
    const a=org("owner-a","Agency A");
    expect(()=>service.searchCompanies(a.id,"owner-a",{limit:101})).toThrowError(AgencyError);
    expect(()=>service.searchCompanies(a.id,"owner-a",{offset:-1})).toThrowError(AgencyError);
    expect(()=>service.searchCompanies(a.id,"owner-a",{status:"deleted" as never})).toThrowError(AgencyError);
  });
});
