import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AgencyService, AgencyStore, type WhatsAppTemplateSender } from "../src/agency/index.js";
import { agencyRoutes } from "../src/web/routes/agency.js";
import { HttpError, type WebContext } from "../src/web/http.js";

describe("Agency WhatsApp HTTP API",()=>{
  let store:AgencyStore;
  let service:AgencyService;
  let route:ReturnType<typeof agencyRoutes>;
  let organizationId:string;
  let contactId:string;
  let savedConfig:Record<string,unknown>|undefined;
  beforeEach(()=>{
    const sender:WhatsAppTemplateSender={isConfigured:()=>true,async sendTemplateMessage(){return {providerMessageId:"wamid.http-test"};}};
    store=new AgencyStore(":memory:");
    service=new AgencyService(store,{now:()=>1_800_000_000_000,whatsapp:sender});
    organizationId=service.createOrganization({name:"Agency"},"local-owner").id;
    const company=service.createCompany(organizationId,"local-owner",{name:"Acme"});
    contactId=service.createContact(organizationId,"local-owner",{
      companyId:company.id,displayName:"Contact",phone:"+221771234567",
    }).id;
    savedConfig=undefined;
    route=agencyRoutes({
      agency:service,
      whatsappConfig:{
        async status(orgId){
          return {
            configured:savedConfig?.organizationId===orgId,
            organizationId:orgId,
            savedInSecureStorage:!!savedConfig,
            secureStorageAvailable:true,
            secureStorageBackend:"mock-keychain",
            secureStorageReason:"",
            environmentConfigured:false,
            phoneNumberId:savedConfig?.phoneNumberId,
            webhookConfigured:!!savedConfig?.appSecret&&!!savedConfig?.verifyToken,
            secretReturned:false,
          };
        },
        async save(orgId,input){
          if(!input || typeof input!=="object" || Array.isArray(input))throw new TypeError("invalid config");
          savedConfig={...input as Record<string,unknown>,organizationId:orgId};
        },
        async clear(orgId){
          if(savedConfig && savedConfig.organizationId!==orgId)throw new Error("wrong organization");
          savedConfig=undefined;
        },
      },
    } as WebContext);
  });
  afterEach(()=>store.close());

  async function invoke(method:string,path:string,body?:unknown){
    const request=Readable.from(body===undefined?[]:[JSON.stringify(body)]) as unknown as IncomingMessage;
    Object.defineProperty(request,"headers",{value:{
      "content-type":body===undefined?"":"application/json","sec-fetch-site":"same-origin",
    }});
    const response={
      status:0,payload:"",
      writeHead(status:number){this.status=status;return this;},
      end(payload?:string){this.payload=String(payload??"");return this;},
    } as unknown as ServerResponse & {status:number;payload:string};
    const requestUrl=new URL("http://localhost/amb/api"+path);
    const segments=requestUrl.pathname.split("/").filter(Boolean);
    try{await route(request,response,requestUrl,segments,path,method);}
    catch(error){
      if(!(error instanceof HttpError))throw error;
      response.writeHead(error.status);response.end(JSON.stringify({error:error.message}));
    }
    return {status:response.status,body:response.payload?JSON.parse(response.payload):null};
  }

  it("records consent, asks for owner approval, queues and submits a template",async()=>{
    const denied=await invoke("POST",`/agency/${organizationId}/approvals`,{
      action:"send_message",resourceType:"whatsapp_template",resourceId:contactId,
      reason:"Attempt before consent",
      payload:{
        channel:"whatsapp",purpose:"marketing",contactId,recipient:"+221771234567",
        type:"template",template:{name:"hello_world",language:"fr_FR",components:[]},
      },
    });
    expect(denied.status).toBe(409);
    const consent=await invoke("POST",\`/agency/\${organizationId}/contacts/\${contactId}/consents\`,{
      channel:"whatsapp",purpose:"marketing",status:"granted",source:"website_form",
      proof:"form-submission:42",textVersion:"wa-marketing-v1",
    });
    expect(consent.status).toBe(201);

    const payload={
      channel:"whatsapp",purpose:"marketing",contactId,recipient:"+221771234567",
      type:"template",template:{name:"hello_world",language:"fr_FR",components:[]},
    };
    const requested=await invoke("POST",\`/agency/\${organizationId}/approvals\`,{
      action:"send_message",resourceType:"whatsapp_template",resourceId:contactId,
      reason:"Explicit review of first prospect contact",payload,
    });
    expect(requested.status).toBe(201);
    const approvals=await invoke("GET",`/agency/${organizationId}/approvals?limit=10`);
    expect(approvals.status).toBe(200);
    expect(approvals.body.items).toHaveLength(1);
    expect(approvals.body.items[0]).toMatchObject({
      action:"send_message",resourceType:"whatsapp_template",status:"pending",
      resourceId:contactId,
    });
    const otherOrganization=service.createOrganization({name:"Other Agency"},"local-owner");
    const otherApprovals=await invoke("GET",`/agency/${otherOrganization.id}/approvals?limit=10`);
    expect(otherApprovals.status).toBe(200);
    expect(otherApprovals.body.items).toHaveLength(0);
    const approvalId=requested.body.approval.id as string;
    const decision=await invoke("POST",\`/agency/\${organizationId}/approvals/\${approvalId}/decision\`,{
      decision:"approved",expectedPayloadHash:requested.body.approval.payloadHash,reason:"Approved",
    });
    expect(decision.status).toBe(200);

    const queued=await invoke("POST",\`/agency/\${organizationId}/whatsapp/outbox\`,{
      approvalId,idempotencyKey:"wa-http-0001",payload,
    });
    expect(queued.status).toBe(201);
    expect(queued.body.message.status).toBe("queued");

    const submitted=await invoke("POST",\`/agency/\${organizationId}/whatsapp/outbox/\${queued.body.message.id}/send\`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.message.status).toBe("accepted");
  });

  it("stores WhatsApp credentials without returning the secret and supports explicit removal",async()=>{
    const path=`/agency/${organizationId}/whatsapp/config`;
    const initial=await invoke("GET",path);
    expect(initial.status).toBe(200);
    expect(initial.body.configured).toBe(false);

    const credentials={
      accessToken:"EAAB-secret-access-token-0123456789",
      phoneNumberId:"123456789012345",
      businessAccountId:"987654321098765",
      apiVersion:"v27.0",
      appSecret:"meta-app-secret-0123456789",
      verifyToken:"verify-token-0123456789",
    };
    const saved=await invoke("PUT",path,credentials);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      saved:true,secretReturned:false,
      configuration:{configured:true,savedInSecureStorage:true},
    });
    expect(JSON.stringify(saved.body)).not.toContain(credentials.accessToken);
    expect(JSON.stringify(saved.body)).not.toContain(credentials.appSecret);

    const read=await invoke("GET",path);
    expect(read.body.configured).toBe(true);
    expect(JSON.stringify(read.body)).not.toContain(credentials.accessToken);

    const cleared=await invoke("DELETE",path);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({cleared:true,configuration:{configured:false}});
  });

  it("rejects cross-site consent changes",async()=>{
    const path=\`/agency/\${organizationId}/contacts/\${contactId}/consents\`;
    const request=Readable.from([JSON.stringify({channel:"whatsapp",purpose:"marketing",status:"granted",source:"form",proof:"ref",textVersion:"v1"})]) as unknown as IncomingMessage;
    Object.defineProperty(request,"headers",{value:{"content-type":"application/json","sec-fetch-site":"cross-site"}});
    const response={status:0,payload:"",writeHead(status:number){this.status=status;return this;},end(payload?:string){this.payload=String(payload??"");return this;}} as unknown as ServerResponse & {status:number;payload:string};
    await expect(route(request,response,new URL("http://localhost/amb/api"+path),path.split("/").filter(Boolean),path,"POST"))
      .rejects.toMatchObject({status:403});
  });
});
