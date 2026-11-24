import type {
  Company, CompanyQualificationAssessment, Evidence, QualificationCriterion, QualificationProfile, ResearchDomain,
} from "./types.js";
import { classifyEvidenceType } from "./research-quality.js";

const INDUSTRY_WEIGHT = 30;
const COUNTRY_WEIGHT = 20;
const EXCLUDED_WEIGHT = 20;
const WEBSITE_WEIGHT = 10;
const EVIDENCE_WEIGHT = 20;

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu," ").toLocaleLowerCase("und");
}
function includesIndustry(actual: string, configured: string[]): boolean {
  const value=normalize(actual);
  return !!value && configured.some(item => {
    const target=normalize(item);
    return value===target || value.includes(target);
  });
}
function criterion(
  id: QualificationCriterion["id"], result: QualificationCriterion["result"], weight: number,
  expected: string[], observed: string,
): QualificationCriterion {
  return { id,result,weight,points:result==="met"?weight:0,expected,observed };
}

/** Deterministic fit-to-profile score based only on configured attributes and required evidence domains. */
export function assessCompanyQualification(
  company: Company,
  profile: QualificationProfile,
  evidence: Evidence[],
  now: number,
): CompanyQualificationAssessment {
  const criteria: QualificationCriterion[]=[];
  const configuredWeight =
    (profile.targetIndustries.length?INDUSTRY_WEIGHT:0) +
    (profile.targetCountries.length?COUNTRY_WEIGHT:0) +
    (profile.excludedIndustries.length?EXCLUDED_WEIGHT:0) +
    (profile.requireWebsite?WEBSITE_WEIGHT:0) +
    (profile.requiredEvidenceDomains.length?EVIDENCE_WEIGHT:0);

  if (profile.targetIndustries.length) {
    const result=!company.industry?"unknown":includesIndustry(company.industry,profile.targetIndustries)?"met":"not_met";
    criteria.push(criterion("target_industry",result,INDUSTRY_WEIGHT,profile.targetIndustries,company.industry||""));
  }
  if (profile.targetCountries.length) {
    const result=!company.countryCode?"unknown":profile.targetCountries.includes(company.countryCode.toUpperCase())?"met":"not_met";
    criteria.push(criterion("target_country",result,COUNTRY_WEIGHT,profile.targetCountries,company.countryCode||""));
  }
  if (profile.excludedIndustries.length) {
    const result=!company.industry?"unknown":includesIndustry(company.industry,profile.excludedIndustries)?"not_met":"met";
    criteria.push(criterion("excluded_industry",result,EXCLUDED_WEIGHT,profile.excludedIndustries,company.industry||""));
  }
  if (profile.requireWebsite) {
    criteria.push(criterion("website",company.website?"met":"not_met",WEBSITE_WEIGHT,["http/https website"],company.website?"present":"missing"));
  }
  if (profile.requiredEvidenceDomains.length) {
    const observed=new Set<ResearchDomain>();
    for (const item of evidence) {
      const domain=classifyEvidenceType(item.evidenceType);
      if (domain) observed.add(domain);
    }
    const weight=EVIDENCE_WEIGHT/profile.requiredEvidenceDomains.length;
    for (const domain of profile.requiredEvidenceDomains) {
      criteria.push(criterion(
        ("evidence_"+domain) as QualificationCriterion["id"],
        observed.has(domain)?"met":"not_met",
        weight,[domain],observed.has(domain)?"present":"missing",
      ));
    }
  }

  const evaluated=criteria.filter(item=>item.result!=="unknown");
  const evaluatedWeight=evaluated.reduce((sum,item)=>sum+item.weight,0);
  const earned=evaluated.reduce((sum,item)=>sum+item.points,0);
  const score=evaluatedWeight?Math.round((earned/evaluatedWeight)*100):null;
  const coverage=configuredWeight?Math.round((evaluatedWeight/configuredWeight)*100):0;
  const blockingReasons=criteria
    .filter(item=>item.id==="excluded_industry"&&item.result==="not_met")
    .map(item=>item.id);
  let status: CompanyQualificationAssessment["status"];
  if (configuredWeight===0) status="unconfigured";
  else if (blockingReasons.length) status="weak_fit";
  else if (evaluatedWeight===0 || coverage<60) status="insufficient_data";
  else if ((score??0)>=75) status="strong_fit";
  else if ((score??0)>=50) status="review";
  else status="weak_fit";

  return {
    modelVersion:"company-fit-v1",companyId:company.id,status,score,coverage,
    configuredWeight:Math.round(configuredWeight*100)/100,
    evaluatedWeight:Math.round(evaluatedWeight*100)/100,
    criteria,blockingReasons,assessedAt:now,
  };
}
