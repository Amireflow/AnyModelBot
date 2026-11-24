import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AgencyService, AgencyStore } from "../src/agency/index.js";
import { agencyRoutes } from "../src/web/routes/agency.js";
import { HttpError, type WebContext } from "../src/web/http.js";

describe("Agency qualification HTTP API",()=>{
  let store:AgencyStore;
  let service:AgencyService;
  let route:ReturnType<typeof agencyRoutes>;
  let orgId:string;
  let companyId:string;
  beforeEach(()=>{
    store=new AgencyStore(":memory:");
    service=new AgencyService(store,{now:()=>1_800_000_000_000});
    orgId=service.createOrganization({name:"Agency"},"local-owner").id;
    companyId=service.createCompany(orgId,"local-owner",{
      name:"Acme",industry:"Software",countryCode:"SN",website:"https://acme.example",
    }).id;
    route=agencyRoutes({agency:service} as WebContext);
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
    const segments=path.split("/").filter(Boolean);
    try{await route(request,response,new URL("http://localhost/amb/api"+path),segments,path,method);}
    catch(error){if(!(error instanceof HttpError))throw error;response.writeHead(error.status);response.end(JSON.stringify({error:error.message}));}
    return {status:response.status,body:response.payload?JSON.parse(response.payload):null};
  }

  it("creates a profile and returns an explainable company assessment",async()=>{
    const profile=await invoke("PUT","/agency/"+orgId+"/qualification-profile",{
      targetIndustries:["software"],targetCountries:["SN"],requireWebsite:true,
    });
    expect(profile.status).toBe(200);
    expect(profile.body.profile.targetCountries).toEqual(["SN"]);
    const assessment=await invoke("GET","/agency/"+orgId+"/companies/"+companyId+"/qualification");
    expect(assessment.status).toBe(200);
    expect(assessment.body.assessment).toMatchObject({
      modelVersion:"company-fit-v1",status:"strong_fit",score:100,coverage:100,
    });
  });

  it("does not let cross-site requests edit a qualification profile",async()=>{
    const request=Readable.from([JSON.stringify({targetIndustries:["software"]})]) as unknown as IncomingMessage;
    Object.defineProperty(request,"headers",{value:{"content-type":"application/json","sec-fetch-site":"cross-site"}});
    const response={status:0,payload:"",writeHead(status:number){this.status=status;return this;},end(payload?:string){this.payload=String(payload??"");return this;}} as unknown as ServerResponse & {status:number;payload:string};
    const path="/agency/"+orgId+"/qualification-profile";
    await expect(route(request,response,new URL("http://localhost/amb/api"+path),path.split("/").filter(Boolean),path,"PUT"))
      .rejects.toMatchObject({status:403});
  });
});
