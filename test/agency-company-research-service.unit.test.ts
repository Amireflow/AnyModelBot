import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgencyError, AgencyService, AgencyStore } from "../src/agency/index.js";

describe("Company Research source import into Agency CRM", () => {
  let store: AgencyStore;
  let service: AgencyService;
  let organizationId: string;
  let companyId: string;

  beforeEach(() => {
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, {
      now: () => 1_800_000_000_000,
      id: (() => { let n=0; return () => "research-import-" + (++n); })(),
    });
    const organization = service.createOrganization({ name: "Agency", countryCode: "SN" }, "owner");
    organizationId = organization.id;
    companyId = service.createCompany(organizationId, "owner", {
      name: "Acme Inc.", website: "https://acme.example",
    }).id;
  });

  afterEach(() => store.close());

  it("imports cited sources once, ignores uncited references and writes an audit event", () => {
    const first = service.importCompanyResearchSources(organizationId, "owner", companyId, "job-one", [
      {
        url: "https://example.com/report?utm_source=research#section",
        title: "Annual report", domain: "financial", score: 0.93, used: true,
        summary: "The filing reports revenue and operating margin for the fiscal year.",
        content: "Revenue increased compared with the prior fiscal year.",
        publishedAt: "2026-10-12",
      },
      { url: "https://unused.example/article", title: "Not cited", domain: "news", score: 0.8, used: false },
    ]);
    expect(first).toMatchObject({ jobId: "job-one", imported: 1, duplicates: 0, uncited: 1, total: 2 });
    const evidence = service.listEvidence(organizationId, "owner", companyId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      evidenceType: "company_research_financial",
      confidence: 0.5,
      observedAt: Date.parse("2026-10-12"),
      sourceUrl: "https://example.com/report?utm_source=research#section",
    });
    expect(evidence[0].summary).toContain("The filing reports revenue");
    expect(evidence[0].summary).toContain("Revenue increased");
    expect(evidence[0].summary).toContain("Publication date: 2026-10-12");
    expect(evidence[0].summary).toContain("not a source-confidence score");

    const second = service.importCompanyResearchSources(organizationId, "owner", companyId, "job-two", [
      { url: "https://example.com/report", title: "Annual report", domain: "financial", score: 0.94, used: true },
    ]);
    expect(second).toMatchObject({ imported: 0, duplicates: 1, uncited: 0 });
    expect(service.listEvidence(organizationId, "owner", companyId)).toHaveLength(1);
    expect(service.timeline(organizationId, "owner").map(event => event.action))
      .toContain("research.sources_imported");
  });

  it("does not invent a publication date when the curated date is invalid", () => {
    service.importCompanyResearchSources(organizationId, "owner", companyId, "job-invalid-date", [
      {
        url: "https://news.example/story", title: "News story", used: true,
        summary: "A summary supplied by the research pipeline.", publishedAt: "not-a-date",
      },
    ]);
    const imported = service.listEvidence(organizationId, "owner", companyId)
      .find(item => item.sourceUrl === "https://news.example/story");
    expect(imported?.observedAt).toBe(0);
    expect(imported?.summary).toContain("could not be validated");
  });

  it("requires a CRM write role and keeps evidence scoped to its company", () => {
    expect(() => service.importCompanyResearchSources(organizationId, "intruder", companyId, "job-three", [
      { url: "https://example.com", title: "Source", used: true },
    ])).toThrowError(AgencyError);
    expect(() => service.importCompanyResearchSources(organizationId, "owner", "missing-company", "job-three", []))
      .toThrowError(AgencyError);
  });
});
