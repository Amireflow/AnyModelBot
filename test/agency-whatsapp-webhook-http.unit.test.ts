import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgencyService, AgencyStore } from "../src/agency/index.js";
import { handleWhatsAppMetaWebhook } from "../src/web/routes/whatsapp-webhook.js";

describe("public Meta webhook endpoint",()=>{
  let store:AgencyStore;
  let service:AgencyService;
  const appSecret="unit-meta-app-secret";
  const verifyToken="unit-meta-verify-token";
  let organizationId:string;

  beforeEach(()=>{
    store=new AgencyStore(":memory:");
    service=new AgencyService(store,{now:()=>1_800_000_000_000});
    organizationId=service.createOrganization({name:"Webhook API"},"local-owner").id;
  });
  afterEach(()=>store.close());

  function config(){
    return {organizationId,phoneNumberId:"123456789012345",appSecret,verifyToken};
  }

  function request(method:string,body?:Buffer,headers:Record<string,string>={}){
    const req=Readable.from(body?[body]:[]) as unknown as IncomingMessage;
    Object.defineProperty(req,"method",{value:method});
    Object.defineProperty(req,"headers",{value:headers});
    return req;
  }

  function response(){
    const state={status:0,headers:{} as Record<string,string>,body:""};
    const res={
      writeHead(status:number,headers:Record<string,string>={}){state.status=status;state.headers=headers;return this;},
      end(body?:string|Buffer){state.body=body?.toString()??"";return this;},
    } as unknown as ServerResponse;
    return {res,state};
  }

  it("answers Meta's GET verification challenge only for the configured token",async()=>{
    const challenge="9081726354";
    const good=response();
    await expect(handleWhatsAppMetaWebhook(
      request("GET"),good.res,
      new URL("https://public.example/webhooks/whatsapp/meta?hub.mode=subscribe&hub.verify_token=unit-meta-verify-token&hub.challenge="+challenge),
      config(),service,
    )).resolves.toBe(true);
    expect(good.state).toMatchObject({status:200,body:challenge});
    expect(good.state.headers["content-type"]).toContain("text/plain");

    const bad=response();
    await handleWhatsAppMetaWebhook(
      request("GET"),bad.res,
      new URL("https://public.example/webhooks/whatsapp/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge="+challenge),
      config(),service,
    );
    expect(bad.state.status).toBe(403);
  });

  it("checks raw-body HMAC before parsing and deduplicates retried Meta POSTs",async()=>{
    const body=Buffer.from(JSON.stringify({
      object:"whatsapp_business_account",
      entry:[{id:"987654321098765",changes:[{
        field:"messages",
        value:{metadata:{phone_number_id:"123456789012345"},statuses:[{
          id:"wamid.not-yet-known",status:"sent",timestamp:"1800000001",recipient_id:"221771234567",
        }]},
      }]}],
    }));
    const signature="sha256="+createHmac("sha256",appSecret).update(body).digest("hex");

    const invalid=response();
    await handleWhatsAppMetaWebhook(
      request("POST",body,{"content-type":"application/json","x-hub-signature-256":"sha256="+ "0".repeat(64)}),
      invalid.res,new URL("https://public.example/webhooks/whatsapp/meta"),config(),service,
    );
    expect(invalid.state.status).toBe(401);
    expect(store.countWhatsAppWebhookEvents(organizationId)).toBe(0);

    const valid=response();
    await handleWhatsAppMetaWebhook(
      request("POST",body,{"content-type":"application/json","x-hub-signature-256":signature}),
      valid.res,new URL("https://public.example/webhooks/whatsapp/meta"),config(),service,
    );
    expect(valid.state.status).toBe(200);
    expect(JSON.parse(valid.state.body)).toMatchObject({success:true,accepted:1,duplicates:0,statusEvents:1});

    const retry=response();
    await handleWhatsAppMetaWebhook(
      request("POST",body,{"content-type":"application/json","x-hub-signature-256":signature}),
      retry.res,new URL("https://public.example/webhooks/whatsapp/meta"),config(),service,
    );
    expect(JSON.parse(retry.state.body)).toMatchObject({success:true,accepted:0,duplicates:1});
    expect(store.countWhatsAppWebhookEvents(organizationId)).toBe(1);
  });

  it("fails closed when public callback credentials are absent",async()=>{
    const result=response();
    await handleWhatsAppMetaWebhook(
      request("GET"),result.res,
      new URL("https://public.example/webhooks/whatsapp/meta?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=123"),
      {...config(),appSecret:"",verifyToken:""},service,
    );
    expect(result.state.status).toBe(503);
  });
});
