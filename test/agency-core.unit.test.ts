import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgencyError, AgencyService, AgencyStore } from "../src/agency/index.js";

describe("Agency Core", () => {
  let store: AgencyStore;
  let service: AgencyService;
  let tick: number;
  let ids: number;

  beforeEach(() => {
    tick = 1_800_000_000_000;
    ids = 0;
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, { now: () => tick, id: () => `test-id-${++ids}` });
  });

  afterEach(() => store.close());

  function organization(owner = "owner-1", name = "Amireflow Agency") {
    return service.createOrganization({ name, countryCode: "SN", currency: "XOF" }, owner);
  }

  it("creates an organization and owner membership atomically", () => {
    const org=organization();
    expect(org.countryCode).toBe("SN");
    expect(org.currency).toBe("XOF");
    expect(store.getMembership(org.id,"owner-1")?.role).toBe("owner");
  });

  it("rejects invalid country and currency codes", () => {
    expect(() => service.createOrganization({name:"Bad",countryCode:"SEN"}, "owner"))
      .toThrowError(AgencyError);
    expect(() => service.createOrganization({name:"Bad",currency:"XOFX"}, "owner"))
      .toThrowError(AgencyError);
  });

  it("isolates company reads and writes by organization membership", () => {
    const first=organization("owner-1","First");
    const second=organization("owner-2","Second");
    service.createCompany(first.id,"owner-1",{name:"Company A"});
    expect(() => service.listCompanies(first.id,"owner-2")).toThrowError(AgencyError);
    expect(service.listCompanies(second.id,"owner-2")).toHaveLength(0);
  });

  it("prevents duplicate companies by normalized name or exact website", () => {
    const org=organization();
    service.createCompany(org.id,"owner-1",{name:"  Acme   Group "});
    expect(() => service.createCompany(org.id,"owner-1",{name:"acme group"}))
      .toThrowError(/already exists/);
    service.createCompany(org.id,"owner-1",{name:"Other",website:"https://example.com"});
    expect(() => service.createCompany(org.id,"owner-1",{name:"Different",website:"https://example.com/"}))
      .toThrowError(AgencyError);
  });

  it("rejects non-http websites and malformed email addresses", () => {
    const org=organization();
    expect(() => service.createCompany(org.id,"owner-1",{name:"Unsafe",website:"file:///etc/passwd"}))
      .toThrowError(AgencyError);
    const company=service.createCompany(org.id,"owner-1",{name:"Valid"});
    expect(() => service.createContact(org.id,"owner-1",{companyId:company.id,displayName:"A",email:"not-an-email"}))
      .toThrowError(AgencyError);
  });

  it("creates company contacts and leads and enforces lead transition rules", () => {
    const org=organization();
    const company=service.createCompany(org.id,"owner-1",{name:"Clinic"});
    const contact=service.createContact(org.id,"owner-1",{companyId:company.id,displayName:"Director"});
    const lead=service.createLead(org.id,"owner-1",{companyId:company.id,contactId:contact.id,source:"directory"});
    expect(lead.stage).toBe("new");
    expect(service.transitionLead(org.id,"owner-1",lead.id,"researching").stage).toBe("researching");
    expect(service.transitionLead(org.id,"owner-1",lead.id,"qualified").stage).toBe("qualified");
    expect(() => service.transitionLead(org.id,"owner-1",lead.id,"won")).toThrowError(AgencyError);
  });

  it("rejects a contact from a different company", () => {
    const org=organization();
    const a=service.createCompany(org.id,"owner-1",{name:"A"});
    const b=service.createCompany(org.id,"owner-1",{name:"B"});
    const contact=service.createContact(org.id,"owner-1",{companyId:a.id,displayName:"Person"});
    expect(() => service.createLead(org.id,"owner-1",{companyId:b.id,contactId:contact.id}))
      .toThrowError(AgencyError);
  });

  it("stores sourced evidence and rejects ungrounded or invalid confidence", () => {
    const org=organization();
    const company=service.createCompany(org.id,"owner-1",{name:"Evidence Co"});
    const evidence=service.addEvidence(org.id,"owner-1",{
      companyId:company.id,evidenceType:"website_observation",sourceUrl:"https://example.com",
      summary:"Official page lists the company's services.",confidence:0.8,
    });
    expect(service.listEvidence(org.id,"owner-1",company.id)).toEqual([evidence]);
    expect(() => service.addEvidence(org.id,"owner-1",{
      companyId:company.id,evidenceType:"note",sourceUrl:"",summary:"No source",
    })).toThrowError(AgencyError);
    expect(() => service.addEvidence(org.id,"owner-1",{
      companyId:company.id,evidenceType:"note",sourceUrl:"https://example.com",summary:"Invalid score",confidence:2,
    })).toThrowError(AgencyError);
  });

  it("requires explicit, current consent for an exact channel and purpose", () => {
    const org=organization();
    const company=service.createCompany(org.id,"owner-1",{name:"Consent Co"});
    const contact=service.createContact(org.id,"owner-1",{companyId:company.id,displayName:"Contact"});
    expect(service.hasActiveConsent(org.id,"owner-1",contact.id,"whatsapp","marketing")).toBe(false);
    service.recordConsent(org.id,"owner-1",{
      contactId:contact.id,channel:"whatsapp",purpose:"marketing",status:"granted",
      source:"website_form",proof:"consent record #42",textVersion:"v1",
    });
    expect(service.hasActiveConsent(org.id,"owner-1",contact.id,"whatsapp","marketing")).toBe(true);
    expect(service.hasActiveConsent(org.id,"owner-1",contact.id,"whatsapp","service")).toBe(false);
    service.recordConsent(org.id,"owner-1",{
      contactId:contact.id,channel:"whatsapp",purpose:"marketing",status:"withdrawn",
      source:"recipient_request",proof:"withdrawal event #43",
    });
    expect(service.hasActiveConsent(org.id,"owner-1",contact.id,"whatsapp","marketing")).toBe(false);
  });

  it("requires an owner and an unchanged payload to decide a critical approval", () => {
    const org=organization();
    service.addMember(org.id,"owner-1","member-1","member");
    const approval=service.requestApproval(org.id,"member-1",{
      action:"deploy_production",resourceType:"project",resourceId:"project-1",
      reason:"Deploy the approved release",payload:{environment:"production",commit:"abc123"},
    });
    expect(() => service.decideApproval(org.id,"member-1",approval.id,"approved",approval.payloadHash))
      .toThrowError(AgencyError);
    expect(() => service.decideApproval(org.id,"owner-1",approval.id,"approved","wrong-hash"))
      .toThrowError(AgencyError);
    const decided=service.decideApproval(org.id,"owner-1",approval.id,"approved",approval.payloadHash,"Reviewed");
    expect(decided.status).toBe("approved");
    expect(() => service.decideApproval(org.id,"owner-1",approval.id,"approved",approval.payloadHash))
      .toThrowError(AgencyError);
  });

  it("expires approvals closed and refuses late approval", () => {
    const org=organization();
    const approval=service.requestApproval(org.id,"owner-1",{
      action:"send_message",resourceType:"contact",resourceId:"contact-x",
      reason:"Send an approved message",payload:{recipient:"contact-x",template:"intro"},
      expiresAt:tick+100,
    });
    tick+=101;
    expect(() => service.decideApproval(org.id,"owner-1",approval.id,"approved",approval.payloadHash))
      .toThrowError(AgencyError);
    expect(store.getApproval(org.id,approval.id)?.status).toBe("expired");
  });

  it("records an immutable, verifiable audit chain", () => {
    const org=organization();
    const company=service.createCompany(org.id,"owner-1",{name:"Audited"});
    expect(service.verifyAudit(org.id,"owner-1")).toMatchObject({valid:true,eventsChecked:2});
    expect(() => store.db.prepare("UPDATE agency_audit_events SET action='tampered' WHERE entity_id=?").run(company.id))
      .toThrow();
    expect(service.verifyAudit(org.id,"owner-1").valid).toBe(true);
  });

  it("allows audit-only roles to inspect but not mutate", () => {
    const org=organization();
    service.addMember(org.id,"owner-1","auditor-1","auditor");
    expect(service.listCompanies(org.id,"auditor-1")).toHaveLength(0);
    expect(() => service.createCompany(org.id,"auditor-1",{name:"Forbidden"})).toThrowError(AgencyError);
    expect(service.verifyAudit(org.id,"auditor-1").valid).toBe(true);
  });

  it("refuses operations when an organization is suspended", () => {
    const org=organization();
    store.setOrganizationStatus(org.id,"suspended",tick);
    expect(() => service.createCompany(org.id,"owner-1",{name:"Blocked"})).toThrowError(AgencyError);
  });
});
