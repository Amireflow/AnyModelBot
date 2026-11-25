import fs from "node:fs";
import path from "node:path";
import { AgencyError } from "./errors.js";
import type { Company, Lead } from "./types.js";

export interface AgencyBackupEntry {
  filename: string;
  sizeBytes: number;
  createdAt: number;
  path: string;
}

export interface LlmUsageRecord {
  timestamp: number;
  organizationId: string;
  projectId?: string;
  feature: string;
  model: string;
  inputChars: number;
  outputChars: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
}

export interface LlmUsageSummary {
  totalCalls: number;
  totalTokens: number;
  estimatedCostUsd: number;
  byFeature: Record<string, { calls: number; tokens: number; costUsd: number }>;
  byModel: Record<string, { calls: number; tokens: number; costUsd: number }>;
}

const DEFAULT_COST_PER_TOKEN_USD = 0.0000015;

export function createAgencyBackup(dataDir: string): AgencyBackupEntry {
  const sourceDb = path.join(path.resolve(dataDir), "agency.db");
  if (!fs.existsSync(sourceDb)) {
    throw new AgencyError("NOT_FOUND", "Agency database file agency.db does not exist yet");
  }
  const backupsDir = path.join(path.resolve(dataDir), "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const ts = Date.now();
  const stamp = new Date(ts).toISOString().replace(/[:.]/g, "-");
  const filename = `agency-backup-${stamp}-${ts}.db`;
  const target = path.join(backupsDir, filename);
  fs.copyFileSync(sourceDb, target);
  const stat = fs.statSync(target);
  return {
    filename,
    sizeBytes: stat.size,
    createdAt: ts,
    path: `backups/${filename}`,
  };
}

export function listAgencyBackups(dataDir: string): AgencyBackupEntry[] {
  const backupsDir = path.join(path.resolve(dataDir), "backups");
  if (!fs.existsSync(backupsDir)) return [];
  const entries: AgencyBackupEntry[] = [];
  for (const name of fs.readdirSync(backupsDir)) {
    if (!/^agency-backup-.*\.db$/i.test(name)) continue;
    const full = path.join(backupsDir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      entries.push({
        filename: name,
        sizeBytes: st.size,
        createdAt: Math.round(st.mtimeMs),
        path: `backups/${name}`,
      });
    } catch {
      /* ignore unreadable backup entries */
    }
  }
  entries.sort((a, b) => b.createdAt - a.createdAt);
  return entries.slice(0, 20);
}

/**
 * RFC-4180 CSV encoder with formula-injection neutralization (=, +, -, @, tab, CR).
 */
export function toSafeCsvCell(value: unknown): string {
  let str = value == null ? "" : String(value);
  str = str.replace(/\r\n|\r|\n/g, " ");
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",]/.test(str)) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export function exportCompaniesCsv(companies: readonly Company[]): string {
  const header = ["id", "name", "website", "industry", "countryCode", "city", "status", "createdAt"];
  const rows = companies.map((c) =>
    [c.id, c.name, c.website, c.industry, c.countryCode, c.city, c.status, new Date(c.createdAt).toISOString()]
      .map(toSafeCsvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\r\n");
}

export function exportLeadsCsv(leads: readonly Lead[], companies: readonly Company[]): string {
  const companyMap = new Map(companies.map((c) => [c.id, c]));
  const header = ["id", "companyName", "stage", "source", "notes", "createdAt", "updatedAt"];
  const rows = leads.map((l) =>
    [
      l.id,
      companyMap.get(l.companyId)?.name ?? l.companyId,
      l.stage,
      l.source,
      l.notes,
      new Date(l.createdAt).toISOString(),
      new Date(l.updatedAt).toISOString(),
    ]
      .map(toSafeCsvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\r\n");
}

function usageLedgerFile(dataDir: string): string {
  return path.join(path.resolve(dataDir), "agency-llm-usage.jsonl");
}

export function recordLlmUsage(
  dataDir: string,
  input: Omit<LlmUsageRecord, "timestamp" | "estimatedTokens" | "estimatedCostUsd">,
): LlmUsageRecord {
  const inputChars = Math.max(0, Math.round(Number(input.inputChars) || 0));
  const outputChars = Math.max(0, Math.round(Number(input.outputChars) || 0));
  const estimatedTokens = Math.max(1, Math.ceil((inputChars + outputChars) / 4));
  const estimatedCostUsd = Number((estimatedTokens * DEFAULT_COST_PER_TOKEN_USD).toFixed(6));
  const rec: LlmUsageRecord = {
    timestamp: Date.now(),
    organizationId: input.organizationId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    feature: input.feature || "agency",
    model: input.model || "default",
    inputChars,
    outputChars,
    estimatedTokens,
    estimatedCostUsd,
  };
  const file = usageLedgerFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, "utf8");
  return rec;
}

export function getLlmUsageSummary(dataDir: string, organizationId: string): LlmUsageSummary {
  const summary: LlmUsageSummary = {
    totalCalls: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    byFeature: {},
    byModel: {},
  };
  const file = usageLedgerFile(dataDir);
  if (!fs.existsSync(file)) return summary;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as LlmUsageRecord;
      if (rec.organizationId !== organizationId) continue;
      summary.totalCalls += 1;
      summary.totalTokens += Number(rec.estimatedTokens) || 0;
      summary.estimatedCostUsd = Number((summary.estimatedCostUsd + (Number(rec.estimatedCostUsd) || 0)).toFixed(6));

      const fKey = rec.feature || "agency";
      summary.byFeature[fKey] ??= { calls: 0, tokens: 0, costUsd: 0 };
      summary.byFeature[fKey].calls += 1;
      summary.byFeature[fKey].tokens += Number(rec.estimatedTokens) || 0;
      summary.byFeature[fKey].costUsd = Number(
        (summary.byFeature[fKey].costUsd + (Number(rec.estimatedCostUsd) || 0)).toFixed(6),
      );

      const mKey = rec.model || "default";
      summary.byModel[mKey] ??= { calls: 0, tokens: 0, costUsd: 0 };
      summary.byModel[mKey].calls += 1;
      summary.byModel[mKey].tokens += Number(rec.estimatedTokens) || 0;
      summary.byModel[mKey].costUsd = Number(
        (summary.byModel[mKey].costUsd + (Number(rec.estimatedCostUsd) || 0)).toFixed(6),
      );
    } catch {
      /* ignore corrupt ledger line */
    }
  }
  return summary;
}
