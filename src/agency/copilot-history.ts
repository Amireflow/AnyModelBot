/**
 * Persistent Copilot conversation history, stored per organization on local disk
 * (dataDir/agency/copilot-history/<orgId>.json). Survives page reloads, tab switches
 * and daemon restarts. Attachments are referenced by name only (no file content).
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const COPILOT_HISTORY_MAX = 200;

export interface CopilotHistoryAction {
  tool: string;
  summary: string;
  ok: boolean;
}

export interface CopilotHistoryMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
  files?: string[];
  mode?: string;
  model?: string;
  actions?: CopilotHistoryAction[];
}

function historyFile(dataDir: string, organizationId: string): string {
  const safe = organizationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "default";
  return path.join(dataDir, "agency", "copilot-history", `${safe}.json`);
}

function sanitize(raw: unknown): CopilotHistoryMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return null;
  const msg: CopilotHistoryMessage = {
    role: m.role,
    text: m.text.slice(0, 40_000),
    at: typeof m.at === "string" ? m.at : new Date().toISOString(),
  };
  if (Array.isArray(m.files)) msg.files = m.files.filter((f): f is string => typeof f === "string").slice(0, 10);
  if (typeof m.mode === "string") msg.mode = m.mode;
  if (typeof m.model === "string") msg.model = m.model;
  if (Array.isArray(m.actions)) {
    msg.actions = m.actions
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .slice(0, 20)
      .map((a) => ({ tool: String(a.tool ?? ""), summary: String(a.summary ?? "").slice(0, 500), ok: a.ok === true }));
  }
  return msg;
}

export async function loadCopilotHistory(dataDir: string, organizationId: string): Promise<CopilotHistoryMessage[]> {
  try {
    const parsed = JSON.parse(await readFile(historyFile(dataDir, organizationId), "utf8")) as unknown;
    const items = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { items?: unknown })?.items) ? (parsed as { items: unknown[] }).items : [];
    return items.map(sanitize).filter((x): x is CopilotHistoryMessage => x !== null).slice(-COPILOT_HISTORY_MAX);
  } catch {
    return [];
  }
}

export async function appendCopilotHistory(
  dataDir: string,
  organizationId: string,
  messages: CopilotHistoryMessage[],
): Promise<CopilotHistoryMessage[]> {
  const file = historyFile(dataDir, organizationId);
  const next = [...(await loadCopilotHistory(dataDir, organizationId)), ...messages.map(sanitize).filter((x): x is CopilotHistoryMessage => x !== null)]
    .slice(-COPILOT_HISTORY_MAX);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, items: next }, null, 2), "utf8");
  await rename(tmp, file);
  return next;
}

export async function clearCopilotHistory(dataDir: string, organizationId: string): Promise<void> {
  await rm(historyFile(dataDir, organizationId), { force: true });
}
