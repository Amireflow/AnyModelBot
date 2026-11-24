import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CompanyResearchImportError,
  findActiveCompanyResearchJob,
  listCompanyResearchJobs,
  loadCompanyResearchSources,
} from "../src/agency/company-research-import.js";
import type { Company } from "../src/agency/types.js";

describe("Company Research workspace importer", () => {
  let dataDir: string;
  let appRoot: string;
  let company: Company;
  const botId = "cat-company-research";
  const jobId = "job-20261124-acme";

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-company-research-"));
    appRoot = path.join(dataDir, "workspaces", botId, "app");
    fs.mkdirSync(path.join(appRoot, "jobs", jobId), { recursive: true });
    company = {
      id: "company-1", organizationId: "org-1", name: "Acme Inc.",
      normalizedName: "acme inc.", website: "https://acme.example/",
      industry: "software", countryCode: "SN", city: "Dakar",
      status: "active", createdAt: 1, updatedAt: 1,
    };
    const state = {
      jobs: [
        { id: jobId, company: "Acme Inc.", companyUrl: "https://acme.example", status: "completed", updatedAt: "2026-11-24T10:00:00Z", sourcesPath: "app/jobs/" + jobId + "/sources.json" },
        { id: "job-running-acme", company: "Acme Inc.", status: "researching", progress: 45, currentStep: "news_scanner", updatedAt: "2026-11-24T11:00:00Z" },
        { id: "job-running-other", company: "Other Company", status: "researching", progress: 20, updatedAt: "2026-11-24T11:15:00Z" },
        { id: "job-sample-acme", company: "Acme Inc.", status: "completed", sample: true },
        { id: "job-failed-acme", company: "Acme Inc.", status: "failed" },
        { id: "job-completed-other", company: "Other Company", status: "completed" },
      ],
    };
    fs.writeFileSync(path.join(appRoot, "state.json"), JSON.stringify(state));
    fs.writeFileSync(path.join(appRoot, "jobs", jobId, "report.md"), "# Acme Inc. research report\n");
    fs.writeFileSync(path.join(appRoot, "jobs", jobId, "sources.json"), JSON.stringify([
      { url: "https://acme.example/about", title: "About Acme", domain: "company", score: 0.91, used: true },
      { url: "https://finance.example/acme", title: "Acme annual filing", domain: "financial", score: 0.84, used: false },
      { url: "javascript:alert(1)", title: "Unsafe source", used: true },
    ]));
    fs.writeFileSync(path.join(appRoot, "jobs", jobId, "curated.json"), JSON.stringify({
      financial: [],
      news: [],
      industry: [],
      company: [{
        url: "https://acme.example/about?utm_source=research#team",
        title: "About Acme",
        summary: "Acme designs and sells point-of-sale software to retailers.",
        content: "The official site lists inventory and payment workflows.",
        publishedAt: "2026-10-12",
        score: 0.98,
      }],
    }));
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it("lists active, completed and failed non-sample jobs matching the CRM company", () => {
    expect(listCompanyResearchJobs(dataDir, botId, company)).toEqual([
      {
        id: "job-running-acme", company: "Acme Inc.",
        updatedAt: "2026-11-24T11:00:00Z", sourceCount: 0,
        status: "researching", progress: 45, currentStep: "news_scanner",
      },
      {
        id: jobId, company: "Acme Inc.", companyUrl: "https://acme.example",
        updatedAt: "2026-11-24T10:00:00Z", sourceCount: 1,
        status: "completed", progress: 100,
      },
      {
        id: "job-failed-acme", company: "Acme Inc.",
        sourceCount: 0, status: "failed", progress: 0,
      },
    ]);
  });



  it("can enumerate the shared workspace jobs across companies for concurrency checks", () => {
    const jobs = listCompanyResearchJobs(dataDir, botId);
    expect(jobs.map(job => job.id)).toContain("job-running-other");
    expect(jobs.find(job => job.id === "job-running-other")).toMatchObject({
      company: "Other Company", status: "researching", progress: 20,
    });
  });

  it("finds a recent active job for any company in the shared workspace", () => {
    expect(findActiveCompanyResearchJob(dataDir, botId, Date.parse("2026-11-24T11:32:00Z"))).toMatchObject({
      id: "job-running-other", company: "Other Company", status: "researching", progress: 20,
    });
  });

  it("does not treat an active job with a stale progress timestamp as a workspace lock", () => {
    expect(findActiveCompanyResearchJob(dataDir, botId, Date.parse("2026-11-24T12:00:00Z"))).toBeUndefined();
  });

  it("returns an empty job list when the Company Research bot has just been installed", () => {
    fs.rmSync(path.join(appRoot, "jobs"), { recursive: true, force: true });
    expect(listCompanyResearchJobs(dataDir, botId, company)).toEqual([]);
  });
\n  it("loads only valid HTTP sources and preserves report relevance separately from confidence", () => {
    const loaded = loadCompanyResearchSources(dataDir, botId, company, jobId);
    expect(loaded.job.id).toBe(jobId);
    expect(loaded.sources).toHaveLength(2);
    expect(loaded.sources[0]).toMatchObject({
      url: "https://acme.example/about", title: "About Acme",
      domain: "company", score: 0.91, used: true,
      summary: "Acme designs and sells point-of-sale software to retailers.",
      content: "The official site lists inventory and payment workflows.",
      publishedAt: "2026-10-12",
    });
    expect(loaded.sources[1].used).toBe(false);
  });

  it("keeps legacy imports working when curated.json is absent", () => {
    fs.rmSync(path.join(appRoot, "jobs", jobId, "curated.json"));
    const loaded = loadCompanyResearchSources(dataDir, botId, company, jobId);
    expect(loaded.sources[0]).not.toHaveProperty("summary");
    expect(loaded.sources[0]).not.toHaveProperty("publishedAt");
  });

  it("rejects an unsafe curated.json symlink", () => {
    const curatedPath = path.join(appRoot, "jobs", jobId, "curated.json");
    const outsidePath = path.join(dataDir, "outside-curated.json");
    fs.writeFileSync(outsidePath, JSON.stringify({ company: [{ url: "https://acme.example/about", summary: "outside" }] }));
    fs.rmSync(curatedPath);
    fs.symlinkSync(outsidePath, curatedPath);
    expect(() => loadCompanyResearchSources(dataDir, botId, company, jobId))
      .toThrowError(CompanyResearchImportError);
  });

  it("rejects importing a completed report for a different company", () => {
    expect(() => loadCompanyResearchSources(dataDir, botId, { ...company, normalizedName: "someone else" }, jobId))
      .toThrowError(CompanyResearchImportError);
  });

  it("refuses sample and unfinished jobs", () => {
    expect(() => loadCompanyResearchSources(dataDir, botId, company, "job-sample-acme"))
      .toThrowError(CompanyResearchImportError);
    expect(() => loadCompanyResearchSources(dataDir, botId, company, "job-failed-acme"))
      .toThrowError(CompanyResearchImportError);
  });

  it("rejects a source path override even when it points to an existing file", () => {
    const statePath = path.join(appRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.jobs[0].sourcesPath = "app/jobs/../../outside.json";
    fs.writeFileSync(statePath, JSON.stringify(state));
    expect(() => loadCompanyResearchSources(dataDir, botId, company, jobId))
      .toThrowError(CompanyResearchImportError);
  });

  it("rejects a symlinked job directory", () => {
    const jobs = path.join(appRoot, "jobs");
    const outside = path.join(dataDir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sources.json"), JSON.stringify([{ url: "https://example.com", used: true }]));
    fs.rmSync(path.join(jobs, jobId), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(jobs, jobId), "dir");
    expect(() => loadCompanyResearchSources(dataDir, botId, company, jobId))
      .toThrowError(CompanyResearchImportError);
  });
});
