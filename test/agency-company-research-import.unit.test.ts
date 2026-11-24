import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CompanyResearchImportError,
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
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it("lists only completed, non-sample jobs matching the CRM company", () => {
    expect(listCompanyResearchJobs(dataDir, botId, company)).toEqual([{
      id: jobId, company: "Acme Inc.", companyUrl: "https://acme.example",
      updatedAt: "2026-11-24T10:00:00Z", sourceCount: 1,
    }]);
  });

  it("loads only valid HTTP sources and preserves report relevance separately from confidence", () => {
    const loaded = loadCompanyResearchSources(dataDir, botId, company, jobId);
    expect(loaded.job.id).toBe(jobId);
    expect(loaded.sources).toHaveLength(2);
    expect(loaded.sources[0]).toMatchObject({
      url: "https://acme.example/about", title: "About Acme",
      domain: "company", score: 0.91, used: true,
    });
    expect(loaded.sources[1].used).toBe(false);
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
