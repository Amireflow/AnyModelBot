import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgencyError, AgencyService, AgencyStore, type WhatsAppTemplateSender } from "../src/agency/index.js";

describe("Agency WhatsApp Meta webhooks",()=>{
  let store:AgencyStore;
  let service:AgencyService;
  let tick:number;
  let ids:number;
  let calls:number;
  const sender:WhatsAppTemplateSender={
    isConfigured:()=>true,
    async sendTemplateMessage(){calls++;return {providerMessageId:"wamid.status-test"};},
  };

  beforeEach(()=>{
    tick=1_800_000_000_000;
    ids=0;calls=0;
    store=new AgencyStore(":memory:");
    service=new AgencyService(store,{now:()=>tick,id:()=>`webhook-test-${++ids}`,whatsapp:sender});
  });
  afterEach(()=>store.close());

  function setup(){
    const organization=service.createOrganization({name:"Webhook Agency",countryCode:"SN"},"owner-1");
    const company=service.createCompany(organization.id,"owner-1",{name:"Meta Contact"});
    const contact=service.createContact(organization.id,"owner-1",{
      companyId:company.id,displayName:"Awa",phone:"+221771234567",
    });
    const consent=service.recordConsent(organization.id,"owner-1",{
      contactId:contact.id,channel:"whatsapp",purpose:"marketing",status:"granted",
      source:"website_form",proof:"signed-consent-reference-01",textVersion:"wa-marketing-v1",
    });
    const payload={
      channel:"whatsapp",purpose:"marketing",contactId:contact.id,recipient:"+221771234567",
      type:"template",template:{name:"hello_world",language:"fr_FR",components:[]},
    };
    const approval=service.requestApproval(organization.id,"owner-1",{
      action:"send_message",resourceType:"whatsapp_template",resourceId:contact.id,
      reason:"Explicitly reviewed for the test",payload,
    });
    const decided=service.decideApproval(organization.id,"owner-1",approval.id,"approved",approval.payloadHash);
    const queued=service.queueWhatsAppTemplate(organization.id,"owner-1",{
      approvalId:decided.id,idempotencyKey:"webhook-outbox-0001",payload,
    });
    return {organization,contact,consent,queued};
  }

  function webhook(organizationId:string,items:Record<string,unknown>[],phoneNumberId="123456789012345"){
    return {
      object:"whatsapp_business_account",
      entry:[{
        id:"987654321098765",
        changes:[{
          field:"messages",
          value:{
            messaging_product:"whatsapp",
            metadata:{display_phone_number:"15551234567",phone_number_id:phoneNumberId},
            ...items.reduce((acc,item)=>{
              const key=String(item.kind);
              const value=item.value;
              if(key==="status") (acc.statuses as unknown[]).push(value);
              else (acc.messages as unknown[]).push(value);
              return acc;
            },{statuses:[] as unknown[],messages:[] as unknown[]}),
          },
        }],
      }],
    };
  }

  it("replays a status callback that arrives before the send response is committed",async()=>{
    const {organization,queued}=setup();
    const early=webhook(organization.id,[{kind:"status",value:{
      id:"wamid.status-test",status:"delivered",timestamp:"1800000001",recipient_id:"221771234567",
    }}]);
    const received=service.processWhatsAppWebhook(organization.id,"123456789012345",early);
    expect(received.statusEvents).toBe(1);
    expect(store.getWhatsAppOutbox(organization.id,queued.id)?.providerStatus).toBe("");

    const accepted=await service.dispatchWhatsAppTemplate(organization.id,"owner-1",queued.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.providerStatus).toBe("delivered");
    expect(accepted.providerStatusAt).toBe(1_800_000_001_000);
  });

  it("stores provider status events once and ignores out-of-order delivery callbacks",async()=>{
    const {organization,queued}=setup();
    const accepted=await service.dispatchWhatsAppTemplate(organization.id,"owner-1",queued.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.providerMessageId).toBe("wamid.status-test");

    const read=webhook(organization.id,[{kind:"status",value:{
      id:"wamid.status-test",status:"read",timestamp:"1800000001",recipient_id:"221771234567",
    }}]);
    const first=service.processWhatsAppWebhook(organization.id,"123456789012345",read);
    expect(first).toMatchObject({accepted:1,duplicates:0,statusEvents:1});
    expect(store.getWhatsAppOutbox(organization.id,queued.id)).toMatchObject({
      status:"accepted",providerStatus:"read",providerStatusAt:1_800_000_001_000,
    });

    const olderDelivered=webhook(organization.id,[{kind:"status",value:{
      id:"wamid.status-test",status:"delivered",timestamp:"1800000000",recipient_id:"221771234567",
    }}]);
    const older=service.processWhatsAppWebhook(organization.id,"123456789012345",olderDelivered);
    expect(older.statusEvents).toBe(1);
    expect(store.getWhatsAppOutbox(organization.id,queued.id)?.providerStatus).toBe("read");

    const duplicate=service.processWhatsAppWebhook(organization.id,"123456789012345",read);
    expect(duplicate).toMatchObject({accepted:0,duplicates:1,statusEvents:0});
    expect(store.countWhatsAppWebhookEvents(organization.id)).toBe(2);
    expect(()=>store.db.prepare("UPDATE agency_whatsapp_webhook_events SET provider_status='read'").run()).toThrow();
    expect(()=>store.db.prepare("DELETE FROM agency_whatsapp_webhook_events").run()).toThrow();
  });

  it("does not regress provider status when a later callback has a lower state",async()=>{
    const {organization,queued}=setup();
    await service.dispatchWhatsAppTemplate(organization.id,"owner-1",queued.id);
    const delivered=webhook(organization.id,[{kind:"status",value:{
      id:"wamid.status-test",status:"delivered",timestamp:"1800000002",recipient_id:"221771234567",
    }}]);
    service.processWhatsAppWebhook(organization.id,"123456789012345",delivered);
    const sentLate=webhook(organization.id,[{kind:"status",value:{
      id:"wamid.status-test",status:"sent",timestamp:"1800000003",recipient_id:"221771234567",
    }}]);
    service.processWhatsAppWebhook(organization.id,"123456789012345",sentLate);
    expect(store.getWhatsAppOutbox(organization.id,queued.id)?.providerStatus).toBe("delivered");
  });

  it("turns an inbound STOP into a durable WhatsApp opt-out without storing message text",()=>{
    const {organization,contact}=setup();
    const incoming=webhook(organization.id,[{kind:"message",value:{
      id:"wamid.inbound-stop-1",from:"221771234567",timestamp:"1800000002",
      type:"text",text:{body:"STOP"},
    }}]);
    const result=service.processWhatsAppWebhook(organization.id,"123456789012345",incoming);
    expect(result).toMatchObject({accepted:1,inboundMessages:1,optOuts:1,unmatchedOptOuts:0});
    expect(service.hasActiveConsent(organization.id,"owner-1",contact.id,"whatsapp","marketing")).toBe(false);
    expect(service.listConsents(organization.id,"owner-1",contact.id,"whatsapp","marketing")[0]).toMatchObject({
      status:"withdrawn",source:"whatsapp_inbound",
    });

    const duplicate=service.processWhatsAppWebhook(organization.id,"123456789012345",incoming);
    expect(duplicate).toMatchObject({accepted:0,duplicates:1,optOuts:0});
    expect(service.listConsents(organization.id,"owner-1",contact.id,"whatsapp","marketing")).toHaveLength(2);
  });

  it("does not assign a STOP to an ambiguous or unknown contact",()=>{
    const {organization}=setup();
    const incoming=webhook(organization.id,[{kind:"message",value:{
      id:"wamid.inbound-stop-unknown",from:"221779999999",timestamp:"1800000002",
      type:"text",text:{body:"ARRÊT"},
    }}]);
    const result=service.processWhatsAppWebhook(organization.id,"123456789012345",incoming);
    expect(result.unmatchedOptOuts).toBe(1);
  });

  it("rejects callbacks for a different configured phone number",()=>{
    const {organization}=setup();
    const incoming=webhook(organization.id,[{kind:"message",value:{
      id:"wamid.bad-phone",from:"221771234567",timestamp:"1800000002",
      type:"text",text:{body:"STOP"},
    }}],"999999999999999");
    expect(()=>service.processWhatsAppWebhook(organization.id,"123456789012345",incoming))
      .toThrowError(AgencyError);
    expect(store.countWhatsAppWebhookEvents(organization.id)).toBe(0);
  });
});
