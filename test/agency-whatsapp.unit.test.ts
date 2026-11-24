import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgencyError, AgencyService, AgencyStore, verifyMetaWebhookSignature, type WhatsAppTemplateSender } from "../src/agency/index.js";

describe("Agency WhatsApp Cloud API outbox",()=>{
  let store:AgencyStore;
  let service:AgencyService;
  let tick:number;
  let ids:number;
  let providerCalls:number;
  const sender:WhatsAppTemplateSender={
    isConfigured:()=>true,
    async sendTemplateMessage(){
      providerCalls++;
      return {providerMessageId:"wamid.test-123"};
    },
  };

  beforeEach(()=>{
    tick=1_800_000_000_000;
    ids=0;
    providerCalls=0;
    store=new AgencyStore(":memory:");
    service=new AgencyService(store,{now:()=>tick,id:()=>\`wa-test-\${++ids}\`,whatsapp:sender});
  });
  afterEach(()=>store.close());

  function setup(){
    const organization=service.createOrganization({name:"WhatsApp Agency",countryCode:"SN"},"owner-1");
    const company=service.createCompany(organization.id,"owner-1",{name:"Prospect"});
    const contact=service.createContact(organization.id,"owner-1",{
      companyId:company.id,displayName:"Prospect Contact",phone:"+221771234567",preferredChannel:"whatsapp",
    });
    return {organization,contact};
  }

  function grantConsent(organizationId:string,contactId:string){
    return service.recordConsent(organizationId,"owner-1",{
      contactId,channel:"whatsapp",purpose:"marketing",status:"granted",
      source:"website_form",proof:"form-submission:consent-2026-04",textVersion:"whatsapp-marketing-v1",
    });
  }

  function payload(contactId:string,recipient="+221771234567"){
    return {
      channel:"whatsapp",
      purpose:"marketing",
      contactId,
      recipient,
      type:"template",
      template:{name:"hello_world",language:"fr_FR",components:[]},
    };
  }

  function approve(organizationId:string,contactId:string,body:ReturnType<typeof payload>){
    const approval=service.requestApproval(organizationId,"owner-1",{
      action:"send_message",resourceType:"whatsapp_template",resourceId:contactId,
      reason:"Owner reviewed the exact recipient, template and parameters",payload:body,
    });
    return service.decideApproval(organizationId,"owner-1",approval.id,"approved",approval.payloadHash,"Approved for one submission");
  }

  it("requires consent text version and exact current channel and purpose",()=>{
    const {organization,contact}=setup();
    expect(()=>service.recordConsent(organization.id,"owner-1",{
      contactId:contact.id,channel:"whatsapp",purpose:"marketing",status:"granted",
      source:"website_form",proof:"submission-42",
    })).toThrowError(AgencyError);
    expect(service.hasActiveConsent(organization.id,"owner-1",contact.id,"whatsapp","marketing")).toBe(false);
    grantConsent(organization.id,contact.id);
    expect(service.hasActiveConsent(organization.id,"owner-1",contact.id,"whatsapp","marketing")).toBe(true);
    expect(service.hasActiveConsent(organization.id,"owner-1",contact.id,"whatsapp","service")).toBe(false);
    service.recordConsent(organization.id,"owner-1",{
      contactId:contact.id,channel:"whatsapp",purpose:"marketing",status:"withdrawn",
      source:"recipient_request",proof:"recipient-request:event-43",
    });
    expect(service.hasActiveConsent(organization.id,"owner-1",contact.id,"whatsapp","marketing")).toBe(false);
  });

  it("blocks queueing without both active consent and exact owner approval",()=>{
    const {organization,contact}=setup();
    const body=payload(contact.id);
    const approval=approve(organization.id,contact.id,body);
    expect(()=>service.queueWhatsAppTemplate(organization.id,"owner-1",{
      approvalId:approval.id,idempotencyKey:"wa-outbox-0001",payload:body,
    })).toThrowError(AgencyError);

    grantConsent(organization.id,contact.id);
    const changed=payload(contact.id,"+221779999999");
    expect(()=>service.queueWhatsAppTemplate(organization.id,"owner-1",{
      approvalId:approval.id,idempotencyKey:"wa-outbox-0002",payload:changed,
    })).toThrowError(AgencyError);
    const queued=service.queueWhatsAppTemplate(organization.id,"owner-1",{
      approvalId:approval.id,idempotencyKey:"wa-outbox-0003",payload:body,
    });
    expect(queued.status).toBe("queued");
    expect(queued.consentId).toBeTruthy();
    expect(queued.approvalPayloadHash).toBe(approval.payloadHash);
  });

  it("requires owner dispatch and submits an approved template at most once",async()=>{
    const {organization,contact}=setup();
    grantConsent(organization.id,contact.id);
    const body=payload(contact.id);
    const approval=approve(organization.id,contact.id,body);
    const queued=service.queueWhatsAppTemplate(organization.id,"owner-1",{
      approvalId:approval.id,idempotencyKey:"wa-outbox-0004",payload:body,
    });
    service.addMember(organization.id,"owner-1","member-1","member");
    await expect(service.dispatchWhatsAppTemplate(organization.id,"member-1",queued.id)).rejects.toBeInstanceOf(AgencyError);

    const sent=await service.dispatchWhatsAppTemplate(organization.id,"owner-1",queued.id);
    expect(sent.status).toBe("accepted");
    expect(sent.providerMessageId).toBe("wamid.test-123");
    expect(providerCalls).toBe(1);
    const repeated=await service.dispatchWhatsAppTemplate(organization.id,"owner-1",queued.id);
    expect(repeated.status).toBe("accepted");
    expect(providerCalls).toBe(1);
  });

  it("rechecks consent immediately before submission and blocks a post-queue opt-out",async()=>{
    const {organization,contact}=setup();
    grantConsent(organization.id,contact.id);
    const body=payload(contact.id);
    const approval=approve(organization.id,contact.id,body);
    const queued=service.queueWhatsAppTemplate(organization.id,"owner-1",{
      approvalId:approval.id,idempotencyKey:"wa-outbox-0005",payload:body,
    });
    service.recordConsent(organization.id,"owner-1",{
      contactId:contact.id,channel:"whatsapp",purpose:"marketing",status:"withdrawn",
      source:"recipient_request",proof:"STOP received",
    });
    await expect(service.dispatchWhatsAppTemplate(organization.id,"owner-1",queued.id)).rejects.toMatchObject({code:"CONSENT_REQUIRED"});
    expect(providerCalls).toBe(0);
    expect(store.getWhatsAppOutbox(organization.id,queued.id)?.status).toBe("queued");
  });


  it("keeps consent evidence append-only at the SQLite boundary",()=>{
    const {organization,contact}=setup();
    const consent=grantConsent(organization.id,contact.id);
    expect(()=>store.db.prepare("UPDATE agency_consents SET proof='tampered-proof' WHERE id=?").run(consent.id)).toThrow();
    expect(()=>store.db.prepare("DELETE FROM agency_consents WHERE id=?").run(consent.id)).toThrow();
    expect(service.hasActiveConsent(organization.id,"owner-1",contact.id,"whatsapp","marketing")).toBe(true);
  });

  it("verifies Meta webhook signatures against the exact raw payload",()=>{
    const raw=Buffer.from('{"entry":[{"id":"123"}]}');
    const secret="test-meta-app-secret";
    const signature="sha256="+createHmac("sha256",secret).update(raw).digest("hex");
    expect(verifyMetaWebhookSignature(raw,signature,secret)).toBe(true);
    expect(verifyMetaWebhookSignature(Buffer.from('{"entry":[]}'),signature,secret)).toBe(false);
    expect(verifyMetaWebhookSignature(raw,"sha256=invalid",secret)).toBe(false);
    expect(verifyMetaWebhookSignature(raw,signature,"wrong-secret")).toBe(false);
  });

  it("does not reuse an idempotency key for different content",()=>{
    const {organization,contact}=setup();
    grantConsent(organization.id,contact.id);
    const body=payload(contact.id);
    const approval=approve(organization.id,contact.id,body);
    const first=service.queueWhatsAppTemplate(organization.id,"owner-1",{
      approvalId:approval.id,idempotencyKey:"wa-outbox-0006",payload:body,
    });
    const duplicate=service.queueWhatsAppTemplate(organization.id,"owner-1",{
      approvalId:approval.id,idempotencyKey:"wa-outbox-0006",payload:body,
    });
    expect(duplicate.id).toBe(first.id);
    expect(()=>service.queueWhatsAppTemplate(organization.id,"owner-1",{
      approvalId:approval.id,idempotencyKey:"wa-outbox-0006",payload:payload(contact.id,"+221779999999"),
    })).toThrowError(AgencyError);
  });
});
