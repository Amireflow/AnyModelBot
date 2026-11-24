import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgencyError, AgencyService, AgencyStore, assessCompanyQualification,
  type Company, type Evidence, type QualificationProfile,
} from "../src/agency/index.js";

describe("Commercial company qualification", () => {
  const now=1_800_000_000_000;
  const company:Company={
    id:"company-1",organizationId:"org-1",name:"Acme Software",normalizedName:"acme software",
    website:"https://acme.example/",industry:"Software and SaaS",countryCode:"SN",city:"Dakar",
    status:"active",createdAt:1,updatedAt:1,
  };
  const profile:QualificationProfile={
    organizationId:"org-1",targetIndustries:["software"],targetCountries:["SN"],
    excludedIndustries:["gambling"],requiredEvidenceDomains:["company","financial"],
    requireWebsite:true,createdAt:1,updatedAt:1,
  };
  const evidence=(id:string,evidenceType:string):Evidence=>({
    id,organizationId:"org-1",companyId:company.id,leadId:"",evidenceType,
    sourceUrl:"https://source-"+id+".example/",summary:"Verified reference",
    contentHash:"",confidence:0.7,observedAt:now,collectedAt:now,
  });

  it("scores only configured, observable criteria and exposes complete explanations",()=>{
    const result=assessCompanyQualification(company,profile,[
      evidence("company","company_profile"),evidence("finance","financial_report"),
    ],now);
    expect(result).toMatchObject({
      modelVersion:"company-fit-v1",status:"strong_fit",score:100,coverage:100,
      blockingReasons:[],
    });
    expect(result.criteria).toHaveLength(6);
    expect(result.criteria.every(item=>item.result==="met")).toBe(true);
  });

  it("does not treat missing company attributes as negative evidence",()=>{
    const sparse={...company,industry:"",countryCode:"",website:""};
    const result=assessCompanyQualification(sparse,profile,[],now);
    expect(result.status).toBe("insufficient_data");
    expect(result.score).toBe(0);
    expect(result.coverage).toBe(30);
    expect(result.criteria.filter(item=>item.result==="unknown").map(item=>item.id))
      .toEqual(["target_industry","target_country","excluded_industry"]);
  });

  it("makes an excluded industry a blocking reason even when other criteria match",()=>{
    const excluded={...company,industry:"Online Gambling Software"};
    const result=assessCompanyQualification(excluded,profile,[
      evidence("company","company_profile"),evidence("finance","financial_report"),
    ],now);
    expect(result.status).toBe("weak_fit");
    expect(result.score).toBe(80);
    expect(result.blockingReasons).toEqual(["excluded_industry"]);
  });

  it("returns an unconfigured state instead of inventing a default fit score",()=>{
    const result=assessCompanyQualification(company,{
      organizationId:"org-1",targetIndustries:[],targetCountries:[],excludedIndustries:[],
      requiredEvidenceDomains:[],requireWebsite:false,createdAt:0,updatedAt:0,
    },[],now);
    expect(result).toMatchObject({status:"unconfigured",score:null,coverage:0,configuredWeight:0});
  });

  describe("profile service and persistence",()=>{
    let store:AgencyStore;
    let service:AgencyService;
    let organizationId:string;
    beforeEach(()=>{
      store=new AgencyStore(":memory:");
      let sequence=0;
      service=new AgencyService(store,{now:()=>now,id:()=>"qualification-"+(++sequence)});
      organizationId=service.createOrganization({name:"Agency",countryCode:"SN"},"owner").id;
    });
    afterEach(()=>store.close());

    it("saves a profile, audits the change and restricts editing to administrators",()=>{
      service.addMember(organizationId,"owner","member","member");
      const saved=service.updateQualificationProfile(organizationId,"owner",{
        targetIndustries:["Software","software"],targetCountries:["sn"],excludedIndustries:["Gambling"],
        requiredEvidenceDomains:["company","financial"],requireWebsite:true,
      });
      expect(saved).toMatchObject({
        targetIndustries:["Software"],targetCountries:["SN"],excludedIndustries:["Gambling"],
        requiredEvidenceDomains:["company","financial"],requireWebsite:true,
      });
      expect(()=>service.updateQualificationProfile(organizationId,"member",{targetIndustries:["retail"]}))
        .toThrowError(AgencyError);
      expect(service.timeline(organizationId,"owner").map(event=>event.action))
        .toContain("qualification.profile_updated");
      expect(service.verifyAudit(organizationId,"owner").valid).toBe(true);
    });

    it("rejects conflicting and malformed profile rules",()=>{
      expect(()=>service.updateQualificationProfile(organizationId,"owner",{
        targetIndustries:["Software"],excludedIndustries:["software"],
      })).toThrowError(AgencyError);
      expect(()=>service.updateQualificationProfile(organizationId,"owner",{
        targetCountries:["SEN"],
      })).toThrowError(AgencyError);
      expect(()=>service.updateQualificationProfile(organizationId,"owner",{
        requiredEvidenceDomains:["unknown" as never],
      })).toThrowError(AgencyError);
    });

    it("assesses a company without moving its prospect stage",()=>{
      const companyRecord=service.createCompany(organizationId,"owner",{
        name:"Acme",industry:"Software",countryCode:"SN",website:"https://acme.example",
      });
      const lead=service.createLead(organizationId,"owner",{companyId:companyRecord.id});
      service.updateQualificationProfile(organizationId,"owner",{
        targetIndustries:["software"],targetCountries:["SN"],requireWebsite:true,
      });
      const result=service.assessCompanyQualification(organizationId,"owner",companyRecord.id);
      expect(result.status).toBe("strong_fit");
      expect(service.getLead(organizationId,"owner",lead.id).stage).toBe("new");
    });
  });
});

describe("Commercial qualification profile SQLite migration",()=>{
  const now=1_800_000_000_000;
  it("persists a saved profile after reopening an existing database",()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"agency-qualification-"));
    const database=path.join(directory,"agency.sqlite");
    let store:AgencyStore|undefined;
    try{
      store=new AgencyStore(database);
      let service=new AgencyService(store,{now:()=>now});
      const org=service.createOrganization({name:"Persistent Agency"},"owner");
      service.updateQualificationProfile(org.id,"owner",{targetIndustries:["software"],targetCountries:["SN"]});
      store.close();
      store=new AgencyStore(database);
      service=new AgencyService(store,{now:()=>now});
      expect(service.getQualificationProfile(org.id,"owner")).toMatchObject({
        targetIndustries:["software"],targetCountries:["SN"],
      });
    }finally{
      store?.close();
      fs.rmSync(directory,{recursive:true,force:true});
    }
  });
});
