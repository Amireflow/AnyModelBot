import fs from "node:fs";
import path from "node:path";
import type { Company } from "./types.js";

export interface CompanyResearchJob {
  id: string;
  company: string;
  companyUrl?: string;
  updatedAt?: string;
  sourceCount: number;
}

export interface CompanyResearchSource {
  url: string;
  title: string;
  domain?: "financial" | "news" | "industry" | "company";
  score?: number;
  used: boolean;
}

const STATE_LIMIT = 1_000_000;
const SOURCES_LIMIT = 2_000_000;
const SOURCES_MAX = 250;
const JOB_ID = /^job-[a-z0-9][a-z0-9-]{0,120}$/i;

export class CompanyResearchImportError extends Error {
  constructor(readonly code: "not_installed" | "workspace_missing" | "job_not_found" | "job_not_completed" | "company_mismatch" | "file_invalid", message: string) {
    super(message);
  }
}

function inside(file: string, root: string): boolean {
  return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

function websiteHost(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function readSafeJson(file: string, root: string, maxBytes: number): unknown {
  try {
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside");
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || st.size > maxBytes) throw new Error("unsafe file");
    const real = fs.realpathSync(file);
    if (!inside(real, root)) throw new Error("outside");
    return JSON.parse(fs.readFileSync(real, "utf8"));
  } catch {
    throw new CompanyResearchImportError("file_invalid", "Company Research data is missing, invalid or outside its workspace");
  }
}

function appRootOf(dataDir: string, botId: string): string {
  if (!/^[\w.-]{1,128}$/.test(botId)) throw new CompanyResearchImportError("not_installed", "Company Research bot id is invalid");
  const workspace = path.join(path.resolve(dataDir), "workspaces", botId);
  const appRoot = path.join(workspace, "app");
  try {
    const realWorkspace = fs.realpathSync(workspace);
    const workspaceStat = fs.lstatSync(workspace);
    const realApp = fs.realpathSync(appRoot);
    const appStat = fs.lstatSync(appRoot);
    if (workspaceStat.isSymbolicLink() || appStat.isSymbolicLink() || !appStat.isDirectory() || !inside(realApp, realWorkspace)) throw new Error("unsafe workspace");
    return realApp;
  } catch {
    throw new CompanyResearchImportError("workspace_missing", "Company Research workspace is not available on this installation");
  }
}

function parseSource(raw: unknown): CompanyResearchSource | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  if (typeof item.url !== "string" || item.url.length > 2048) return undefined;
  let url: URL;
  try { url = new URL(item.url); } catch { return undefined; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return undefined;
  const domain = ["financial", "news", "industry", "company"].includes(String(item.domain))
    ? item.domain as CompanyResearchSource["domain"]
    : undefined;
  const score = typeof item.score === "number" && Number.isFinite(item.score) && item.score >= 0 && item.score <= 1 ? item.score : undefined;
  return {
    url: url.toString(),
    title: typeof item.title === "string" ? item.title.trim().slice(0, 300) : "",
    ...(domain ? { domain } : {}),
    ...(score !== undefined ? { score } : {}),
    used: item.used !== false,
  };
}

function matchesCompany(job: Record<string, unknown>, company: Company): boolean {
  if (typeof job.company === "string" && normalizedName(job.company) === company.normalizedName) return true;
  const jobHost = typeof job.companyUrl === "string" ? websiteHost(job.companyUrl) : "";
  const companyHost = company.website ? websiteHost(company.website) : "";
  return !!jobHost && !!companyHost && jobHost === companyHost;
}

function completedJobs(appRoot: string): { state: Record<string, unknown>; root: string; jobs: Array<Record<string, unknown>> } {
  const state = readSafeJson(path.join(appRoot, "state.json"), appRoot, STATE_LIMIT);
  if (!state || typeof state !== "object" || Array.isArray(state) || !Array.isArray((state as any).jobs)) {
    throw new CompanyResearchImportError("file_invalid", "Company Research state does not match its expected structure");
  }
  const jobsRoot = path.join(appRoot, "jobs");
  let realJobsRoot: string;
  try {
    const st = fs.lstatSync(jobsRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("unsafe jobs directory");
    realJobsRoot = fs.realpathSync(jobsRoot);
    if (!inside(realJobsRoot, appRoot)) throw new Error("outside jobs directory");
  } catch {
    throw new CompanyResearchImportError("file_invalid", "Company Research jobs directory is missing or unsafe");
  }
  const jobs = (state as any).jobs.filter((job: unknown): job is Record<string, unknown> =>
    !!job && typeof job === "object" && !Array.isArray(job) && job.sample !== true && job.status === "completed" &&
    typeof job.id === "string" && JOB_ID.test(job.id),
  );
  return { state: state as Record<string, unknown>, root: realJobsRoot, jobs };
}

function loadSources(appRoot: string, jobsRoot: string, job: Record<string, unknown>): CompanyResearchSource[] {
  const id = String(job.id);
  const expectedReportPath = "app/jobs/" + id + "/report.md";
  if (job.reportPath && job.reportPath !== expectedReportPath) {
    throw new CompanyResearchImportError("file_invalid", "The report path does not match the selected research job");
  }
  const reportFile = path.join(jobsRoot, id, "report.md");
  try {
    const reportStat = fs.lstatSync(reportFile);
    const reportReal = fs.realpathSync(reportFile);
    if (reportStat.isSymbolicLink() || !reportStat.isFile() || reportStat.nlink !== 1 ||
        reportStat.size > 5_000_000 || !inside(reportReal, appRoot)) throw new Error("unsafe report");
  } catch {
    throw new CompanyResearchImportError("file_invalid", "The selected research report is missing or unsafe");
  }
  const expectedPath = "app/jobs/" + id + "/sources.json";
  if (job.sourcesPath && job.sourcesPath !== expectedPath) {
    throw new CompanyResearchImportError("file_invalid", "The report source path does not match the selected research job");
  }
  const jobDir = path.join(jobsRoot, id);
  try {
    const dirStat = fs.lstatSync(jobDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || !inside(fs.realpathSync(jobDir), jobsRoot)) throw new Error("unsafe job directory");
  } catch {
    throw new CompanyResearchImportError("file_invalid", "The selected research job directory is missing or unsafe");
  }
  const parsed = readSafeJson(path.join(jobDir, "sources.json"), appRoot, SOURCES_LIMIT);
  if (!Array.isArray(parsed) || parsed.length > SOURCES_MAX) {
    throw new CompanyResearchImportError("file_invalid", "The selected report has an invalid or oversized sources list");
  }
  const sources = parsed.map(parseSource).filter((item): item is CompanyResearchSource => !!item);
  if (!sources.length) throw new CompanyResearchImportError("file_invalid", "The selected report does not contain importable HTTP sources");
  return sources;
}

export function listCompanyResearchJobs(dataDir: string, botId: string, company: Company): CompanyResearchJob[] {
  const appRoot = appRootOf(dataDir, botId);
  const found = completedJobs(appRoot);
  return found.jobs.filter(job => matchesCompany(job, company)).flatMap(job => {
    try {
      const sources = loadSources(appRoot, found.root, job);
      return [{
        id: String(job.id),
        company: String(job.company ?? ""),
        ...(typeof job.companyUrl === "string" ? { companyUrl: job.companyUrl } : {}),
        ...(typeof job.updatedAt === "string" ? { updatedAt: job.updatedAt } : {}),
        sourceCount: sources.filter(source => source.used).length,
      }];
    } catch {
      // A single damaged or incomplete report must not hide other usable reports.
      return [];
    }
  }).sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function loadCompanyResearchSources(dataDir: string, botId: string, company: Company, jobId: string): { job: CompanyResearchJob; sources: CompanyResearchSource[] } {
  if (!JOB_ID.test(jobId)) throw new CompanyResearchImportError("job_not_found", "Invalid Company Research job id");
  const appRoot = appRootOf(dataDir, botId);
  const found = completedJobs(appRoot);
  const rawJob = found.jobs.find(item => item.id === jobId);
  if (!rawJob) throw new CompanyResearchImportError("job_not_completed", "Only completed, non-sample Company Research jobs can be imported");
  if (!matchesCompany(rawJob, company)) throw new CompanyResearchImportError("company_mismatch", "The selected research job does not match this CRM company");
  const sources = loadSources(appRoot, found.root, rawJob);
  return {
    job: {
      id: jobId,
      company: String(rawJob.company ?? ""),
      ...(typeof rawJob.companyUrl === "string" ? { companyUrl: rawJob.companyUrl } : {}),
      ...(typeof rawJob.updatedAt === "string" ? { updatedAt: rawJob.updatedAt } : {}),
      sourceCount: sources.filter(source => source.used).length,
    },
    sources,
  };
}
