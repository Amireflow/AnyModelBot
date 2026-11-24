import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgencyError, AgencyService, AgencyStore, assessResearchEvidence, type Evidence } from "../src/agency/index.js";

describe("Agency research evidence quality", () => {
  let store: AgencyStore;
  let service: AgencyService;
  const now = 1_800_000_000_000;
  let id = 0;

  beforeEach(() => {
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, { now: () => now, id: () => "research-" + (++id) });
  });
  afterEach(() => store.close());

  const evidence = (id: string, evidenceType: string, sourceUrl: string, confidence = 0.8, observedAt = now): Evidence => ({
    id, organizationId: "org", companyId: "company", leadId: "",
    evidenceType, sourceUrl, summary: "Observed factual statement", contentHash: "",
    confidence, observedAt, collectedAt: now,
  });

  it("returns an explicit insufficient state for an empty dossier", () => {
    expect(assessResearchEvidence([], now)).toMatchObject({
      modelVersion: "research-evidence-v1", score: 0, status: "insufficient",
      evidenceCount: 0, missingDomains: ["company", "industry", "financial", "news"],
    });
  });

  it("scores coverage, source diversity, confidence and freshness deterministically", () => {
    const items = [
      evidence("1", "company_profile", "https://www.example.com/about"),
      evidence("2", "industry_market", "https://market.example.org/report"),
      evidence("3", "financial_report", "https://finance.example.net/results"),
      evidence("4", "news_article", "https://news.example.io/story"),
      evidence("5", "company_product", "https://www.example.com/product"),
    ];
    const result = assessResearchEvidence(items, now);
    expect(result.score).toBe(92);
    expect(result.status).toBe("review_ready");
    expect(result.coverage).toEqual({ company: 2, industry: 1, financial: 1, news: 1 });
    expect(result.distinctSourceHosts).toBe(4);
    expect(result.breakdown).toEqual({ coverage: 40, sourceDiversity: 16, confidence: 16, freshness: 20 });
  });

  it("does not mistake research completeness for automatic sales qualification", () => {
    const items = [
      evidence("1", "company_profile", "https://a.example.com"),
      evidence("2", "industry_market", "https://b.example.com"),
      evidence("3", "financial_report", "https://c.example.com"),
      evidence("4", "news_article", "https://d.example.com"),
      evidence("5", "company_product", "https://e.example.com"),
    ];
    const assessment = assessResearchEvidence(items, now);
    expect(assessment.status).toBe("review_ready");
    expect(assessment.recommendations.join(" ")).toContain("does not qualify the prospect automatically");
  });

  it("keeps stale and low-confidence evidence visible while lowering its score", () => {
    const items = [
      evidence("1", "company_profile", "https://a.example.com", 0.2, now - 800 * 86_400_000),
      evidence("2", "industry_market", "https://b.example.com", 0.2, now - 800 * 86_400_000),
      evidence("3", "financial_report", "https://c.example.com", 0.2, now - 800 * 86_400_000),
    ];
    const result = assessResearchEvidence(items, now);
    expect(result.evidenceCount).toBe(3);
    expect(result.freshEvidenceCount).toBe(0);
    expect(result.score).toBeLessThan(65);
    expect(result.status).toBe("developing");
    expect(result.recommendations).toContain("Refresh evidence that is more than 365 days old");
  });

  it("stores evidence and prevents an unrelated member from reading the company dossier", () => {
    const org = service.createOrganization({ name: "Agency", countryCode: "SN" }, "owner");
    const company = service.createCompany(org.id, "owner", { name: "Example Ltd" });
    const saved = service.addEvidence(org.id, "owner", {
      companyId: company.id, evidenceType: "company_profile",
      sourceUrl: "https://example.com/about", summary: "Company overview", confidence: 0.9,
    });
    expect(saved.id).toBeTruthy();
    expect(service.listEvidence(org.id, "owner", company.id)).toHaveLength(1);
    expect(service.assessCompanyResearch(org.id, "owner", company.id).evidenceCount).toBe(1);
    expect(() => service.listEvidence(org.id, "intruder", company.id)).toThrowError(AgencyError);
  });

  it("rejects evidence linked to a lead from another company", () => {
    const org = service.createOrganization({ name: "Agency", countryCode: "SN" }, "owner");
    const companyA = service.createCompany(org.id, "owner", { name: "Company A" });
    const companyB = service.createCompany(org.id, "owner", { name: "Company B" });
    const lead = service.createLead(org.id, "owner", { companyId: companyB.id });
    expect(() => service.addEvidence(org.id, "owner", {
      companyId: companyA.id, leadId: lead.id, evidenceType: "company",
      sourceUrl: "https://example.com", summary: "Mismatch",
    })).toThrowError(AgencyError);
  });
});
