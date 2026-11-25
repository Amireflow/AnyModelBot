import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgencyError } from "./errors.js";
import { getProjectEvolutionSnapshot, resolveProjectFile, syncProjectBriefToDisk } from "./project-tracker.js";
import type { Contract, Project, ProjectLot } from "./types.js";
import { resolveProjectDirectory } from "./workspace-runner.js";

export type IdeCategory = "ide" | "cli_agent";

export interface CustomIdeProfileRecord {
  id: string;
  name: string;
  category: IdeCategory;
  executable: string;
  openDirArgs: string[];
  openFileArgs: string[];
  promptArgs?: string[];
}

export interface DetectedIdeProfile {
  id: string;
  name: string;
  category: IdeCategory;
  executable: string;
  available: boolean;
  detectedPath: string;
  openDirArgs: string[];
  openFileArgs: string[];
  promptArgs: string[];
  custom: boolean;
}

export interface IdeTaskRun {
  id: string;
  projectId: string;
  ideId: string;
  ideName: string;
  mode: "cli" | "ide";
  title: string;
  status: "running" | "completed" | "failed" | "cancelled" | "dispatched_to_ide";
  missionFile: string;
  promptPreview: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  logs: string[];
  changedFiles: string[];
  summary?: string;
}

interface BuiltinIdeSpec {
  id: string;
  name: string;
  category: IdeCategory;
  commands: string[];
  winPaths?: () => string[];
  macPaths?: string[];
  openDirArgs: string[];
  openFileArgs: string[];
  promptArgs?: string[];
}

const DETECTION_TTL_MS = 30_000;
let cachedDetection: { key: string; at: number; items: DetectedIdeProfile[] } | null = null;

interface ActiveRunEntry {
  run: IdeTaskRun;
  child: ChildProcess | null;
  dataDir: string;
  project: Project;
}

const activeRuns = new Map<string, ActiveRunEntry>();
const runsByProject = new Map<string, IdeTaskRun[]>();

function localAppDataPaths(...subPaths: string[]): string[] {
  const roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
  const out: string[] = [];
  for (const root of roots) {
    for (const sub of subPaths) {
      out.push(path.join(root, sub));
    }
  }
  return out;
}

const BUILTIN_IDE_SPECS: readonly BuiltinIdeSpec[] = [
  {
    id: "antigravity",
    name: "Antigravity IDE",
    category: "ide",
    commands: process.platform === "win32" ? ["antigravity.cmd", "agy.cmd", "antigravity", "agy"] : ["antigravity", "agy"],
    winPaths: () => localAppDataPaths("Programs\\antigravity\\Antigravity.exe", "antigravity\\Antigravity.exe"),
    macPaths: ["/Applications/Antigravity.app/Contents/MacOS/Electron"],
    openDirArgs: ["{dir}"],
    openFileArgs: ["-g", "{file}:{line}"],
  },
  {
    id: "vscode",
    name: "VS Code",
    category: "ide",
    commands: process.platform === "win32" ? ["code.cmd", "code"] : ["code"],
    winPaths: () => localAppDataPaths("Programs\\Microsoft VS Code\\Code.exe", "Microsoft VS Code\\Code.exe"),
    macPaths: ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"],
    openDirArgs: ["{dir}"],
    openFileArgs: ["-g", "{file}:{line}"],
  },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    category: "ide",
    commands: process.platform === "win32" ? ["code-insiders.cmd", "code-insiders"] : ["code-insiders"],
    winPaths: () => localAppDataPaths("Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe"),
    macPaths: ["/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"],
    openDirArgs: ["{dir}"],
    openFileArgs: ["-g", "{file}:{line}"],
  },
  {
    id: "cursor",
    name: "Cursor",
    category: "ide",
    commands: process.platform === "win32" ? ["cursor.cmd", "cursor"] : ["cursor"],
    winPaths: () => localAppDataPaths("Programs\\cursor\\Cursor.exe", "cursor\\Cursor.exe"),
    macPaths: ["/Applications/Cursor.app/Contents/MacOS/Cursor"],
    openDirArgs: ["{dir}"],
    openFileArgs: ["-g", "{file}:{line}"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    category: "ide",
    commands: process.platform === "win32" ? ["windsurf.cmd", "windsurf"] : ["windsurf"],
    winPaths: () => localAppDataPaths("Programs\\Windsurf\\Windsurf.exe"),
    macPaths: ["/Applications/Windsurf.app/Contents/MacOS/Windsurf"],
    openDirArgs: ["{dir}"],
    openFileArgs: ["-g", "{file}:{line}"],
  },
  {
    id: "kiro",
    name: "Kiro IDE",
    category: "ide",
    commands: process.platform === "win32" ? ["kiro.cmd", "kiro"] : ["kiro"],
    winPaths: () => localAppDataPaths("Programs\\Kiro\\Kiro.exe"),
    openDirArgs: ["{dir}"],
    openFileArgs: ["-g", "{file}:{line}"],
  },
  {
    id: "trae",
    name: "Trae IDE",
    category: "ide",
    commands: process.platform === "win32" ? ["trae.cmd", "trae"] : ["trae"],
    winPaths: () => localAppDataPaths("Programs\\Trae\\Trae.exe"),
    openDirArgs: ["{dir}"],
    openFileArgs: ["-g", "{file}:{line}"],
  },
  {
    id: "zed",
    name: "Zed",
    category: "ide",
    commands: process.platform === "win32" ? ["zed.exe", "zed"] : ["zed"],
    openDirArgs: ["{dir}"],
    openFileArgs: ["{file}:{line}"],
  },
  {
    id: "idea",
    name: "IntelliJ IDEA",
    category: "ide",
    commands: process.platform === "win32" ? ["idea64.exe", "idea.cmd", "idea"] : ["idea"],
    openDirArgs: ["{dir}"],
    openFileArgs: ["--line", "{line}", "{file}"],
  },
  {
    id: "webstorm",
    name: "WebStorm",
    category: "ide",
    commands: process.platform === "win32" ? ["webstorm64.exe", "webstorm.cmd", "webstorm"] : ["webstorm"],
    openDirArgs: ["{dir}"],
    openFileArgs: ["--line", "{line}", "{file}"],
  },
  {
    id: "pycharm",
    name: "PyCharm",
    category: "ide",
    commands: process.platform === "win32" ? ["pycharm64.exe", "pycharm.cmd", "pycharm"] : ["pycharm"],
    openDirArgs: ["{dir}"],
    openFileArgs: ["--line", "{line}", "{file}"],
  },
  {
    id: "claude",
    name: "Claude Code CLI",
    category: "cli_agent",
    commands: process.platform === "win32" ? ["claude.cmd", "claude"] : ["claude"],
    openDirArgs: [],
    openFileArgs: [],
    promptArgs: ["-p", "{prompt}"],
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    category: "cli_agent",
    commands: process.platform === "win32" ? ["codex.cmd", "codex"] : ["codex"],
    openDirArgs: [],
    openFileArgs: [],
    promptArgs: ["exec", "{prompt}"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    category: "cli_agent",
    commands: process.platform === "win32" ? ["gemini.cmd", "gemini"] : ["gemini"],
    openDirArgs: [],
    openFileArgs: [],
    promptArgs: ["-p", "{prompt}"],
  },
  {
    id: "aider",
    name: "Aider",
    category: "cli_agent",
    commands: process.platform === "win32" ? ["aider.exe", "aider"] : ["aider"],
    openDirArgs: [],
    openFileArgs: [],
    promptArgs: ["--message", "{prompt}", "--yes"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    category: "cli_agent",
    commands: process.platform === "win32" ? ["opencode.cmd", "opencode"] : ["opencode"],
    openDirArgs: [],
    openFileArgs: [],
    promptArgs: ["run", "{prompt}"],
  },
];

function customProfilesFile(dataDir: string): string {
  return path.join(dataDir, "agency-ide-profiles.json");
}

function sanitizeArgList(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out = raw
    .map((x) => String(x ?? "").replace(/\0/g, "").trim())
    .filter(Boolean)
    .slice(0, 16);
  return out;
}

export function listCustomIdeProfiles(dataDir: string): CustomIdeProfileRecord[] {
  const file = customProfilesFile(dataDir);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        id: String(item.id || "").trim(),
        name: String(item.name || "").trim(),
        category: (item.category === "cli_agent" ? "cli_agent" : "ide") as IdeCategory,
        executable: String(item.executable || "").trim(),
        openDirArgs: sanitizeArgList(item.openDirArgs, ["{dir}"]),
        openFileArgs: sanitizeArgList(item.openFileArgs, ["{file}"]),
        promptArgs: item.promptArgs ? sanitizeArgList(item.promptArgs, []) : undefined,
      }))
      .filter((item) => item.id && item.name && item.executable);
  } catch {
    return [];
  }
}

function saveCustomIdeProfiles(dataDir: string, profiles: CustomIdeProfileRecord[]): void {
  const file = customProfilesFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(profiles, null, 2), "utf8");
  fs.renameSync(tmp, file);
  cachedDetection = null;
}

export function upsertCustomIdeProfile(
  dataDir: string,
  input: {
    id?: string;
    name: string;
    category: IdeCategory;
    executable: string;
    openDirArgs?: string[];
    openFileArgs?: string[];
    promptArgs?: string[];
  },
): CustomIdeProfileRecord {
  const name = String(input.name ?? "").replace(/\0/g, "").trim().slice(0, 80);
  const executable = String(input.executable ?? "").replace(/\0/g, "").trim().slice(0, 320);
  if (!name) throw new AgencyError("VALIDATION_ERROR", "IDE profile name is required");
  if (!executable) throw new AgencyError("VALIDATION_ERROR", "IDE executable command or path is required");
  if (/[;&|`$<>()\n\r]/.test(executable)) {
    throw new AgencyError("VALIDATION_ERROR", "IDE executable cannot contain shell operators");
  }
  const category: IdeCategory = input.category === "cli_agent" ? "cli_agent" : "ide";
  const slug = (input.id || name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const id = slug.startsWith("custom-") ? slug : `custom-${slug || crypto.randomUUID().slice(0, 8)}`;

  const record: CustomIdeProfileRecord = {
    id,
    name,
    category,
    executable,
    openDirArgs: sanitizeArgList(input.openDirArgs, ["{dir}"]),
    openFileArgs: sanitizeArgList(input.openFileArgs, ["{file}"]),
    promptArgs: input.promptArgs ? sanitizeArgList(input.promptArgs, []) : undefined,
  };

  const current = listCustomIdeProfiles(dataDir);
  const idx = current.findIndex((p) => p.id === id);
  if (idx >= 0) current[idx] = record;
  else current.push(record);
  saveCustomIdeProfiles(dataDir, current);
  return record;
}

export function deleteCustomIdeProfile(dataDir: string, id: string): { deleted: boolean } {
  const clean = String(id ?? "").trim();
  const current = listCustomIdeProfiles(dataDir);
  const next = current.filter((p) => p.id !== clean);
  if (next.length === current.length) return { deleted: false };
  saveCustomIdeProfiles(dataDir, next);
  return { deleted: true };
}

function locateExecutableOnHost(candidate: string): string | null {
  const clean = candidate.trim();
  if (!clean) return null;
  if (clean.includes("/") || clean.includes("\\") || /^[a-zA-Z]:/.test(clean)) {
    return fs.existsSync(clean) ? clean : null;
  }
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(locator, [clean], {
      timeout: 1500,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first && fs.existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

export function detectInstalledIdes(dataDir: string, forceRefresh = false): DetectedIdeProfile[] {
  const cacheKey = path.resolve(dataDir);
  const now = Date.now();
  if (!forceRefresh && cachedDetection && cachedDetection.key === cacheKey && now - cachedDetection.at < DETECTION_TTL_MS) {
    return cachedDetection.items;
  }

  const results: DetectedIdeProfile[] = [];

  for (const spec of BUILTIN_IDE_SPECS) {
    let detectedPath = "";
    for (const cmd of spec.commands) {
      const hit = locateExecutableOnHost(cmd);
      if (hit) {
        detectedPath = hit;
        break;
      }
    }
    if (!detectedPath && process.platform === "win32" && spec.winPaths) {
      for (const p of spec.winPaths()) {
        if (fs.existsSync(p)) {
          detectedPath = p;
          break;
        }
      }
    }
    if (!detectedPath && process.platform === "darwin" && spec.macPaths) {
      for (const p of spec.macPaths) {
        if (fs.existsSync(p)) {
          detectedPath = p;
          break;
        }
      }
    }
    results.push({
      id: spec.id,
      name: spec.name,
      category: spec.category,
      executable: detectedPath || spec.commands[0] || spec.id,
      available: Boolean(detectedPath),
      detectedPath,
      openDirArgs: spec.openDirArgs,
      openFileArgs: spec.openFileArgs,
      promptArgs: spec.promptArgs ?? [],
      custom: false,
    });
  }

  for (const custom of listCustomIdeProfiles(dataDir)) {
    const located = locateExecutableOnHost(custom.executable) ?? "";
    results.push({
      id: custom.id,
      name: custom.name,
      category: custom.category,
      executable: located || custom.executable,
      available: Boolean(located),
      detectedPath: located,
      openDirArgs: custom.openDirArgs,
      openFileArgs: custom.openFileArgs,
      promptArgs: custom.promptArgs ?? [],
      custom: true,
    });
  }

  cachedDetection = { key: cacheKey, at: now, items: results };
  return results;
}

export function buildIdeInvocationArgs(
  templateArgs: readonly string[],
  vars: {
    dir?: string;
    file?: string;
    line?: number;
    prompt?: string;
    missionFile?: string;
  },
): string[] {
  const safeLine = String(Math.max(1, Math.round(vars.line ?? 1)));
  return templateArgs
    .map((arg) =>
      arg
        .replaceAll("{dir}", (vars.dir ?? "").replace(/\0/g, ""))
        .replaceAll("{file}", (vars.file ?? "").replace(/\0/g, ""))
        .replaceAll("{line}", safeLine)
        .replaceAll("{prompt}", (vars.prompt ?? "").replace(/\0/g, ""))
        .replaceAll("{missionFile}", (vars.missionFile ?? "").replace(/\0/g, "")),
    )
    .filter((arg) => arg.length > 0);
}

function spawnIdeProcess(
  executable: string,
  args: string[],
  cwd: string,
  opts: { detached: boolean },
): ChildProcess {
  const isWinCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
  if (isWinCmd) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", executable, ...args], {
      cwd,
      shell: false,
      detached: opts.detached,
      stdio: opts.detached ? "ignore" : ["ignore", "pipe", "pipe"],
      windowsHide: !opts.detached,
    });
  }
  return spawn(executable, args, {
    cwd,
    shell: false,
    detached: opts.detached,
    stdio: opts.detached ? "ignore" : ["ignore", "pipe", "pipe"],
    windowsHide: !opts.detached,
  });
}

function resolveIdeProfile(dataDir: string, ideId?: string): DetectedIdeProfile {
  const all = detectInstalledIdes(dataDir);
  if (ideId?.trim()) {
    const match = all.find((x) => x.id === ideId.trim());
    if (!match) throw new AgencyError("NOT_FOUND", `IDE profile not found: ${ideId}`);
    if (!match.available) {
      throw new AgencyError("CONFLICT", `${match.name} is not installed or unavailable on this machine (${match.executable})`);
    }
    return match;
  }
  const firstAvailable = all.find((x) => x.available && x.category === "ide") ?? all.find((x) => x.available);
  if (!firstAvailable) {
    throw new AgencyError("CONFLICT", "No supported IDE or coding CLI detected on this machine. Add a custom IDE profile.");
  }
  return firstAvailable;
}

export function openWorkspaceInIde(input: {
  dataDir: string;
  project: Project;
  ideId?: string;
  relPath?: string;
  line?: number;
  contract?: Contract;
  lots?: readonly ProjectLot[];
}): {
  ok: true;
  ideId: string;
  ideName: string;
  directory: string;
  briefPath: string;
  openedTarget: string;
} {
  const profile = resolveIdeProfile(input.dataDir, input.ideId);
  const { workspaceDir } = resolveProjectDirectory(input.dataDir, input.project);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const brief = syncProjectBriefToDisk({
    dataDir: input.dataDir,
    project: input.project,
    contract: input.contract,
    lots: input.lots ?? [],
  });

  let args: string[];
  let openedTarget = workspaceDir;
  if (input.relPath?.trim()) {
    const fileResolved = resolveProjectFile(input.dataDir, input.project, input.relPath);
    if (!fs.existsSync(fileResolved.absPath)) {
      throw new AgencyError("NOT_FOUND", `File not found: ${fileResolved.relPath}`);
    }
    const tpl = profile.openFileArgs.length ? profile.openFileArgs : profile.openDirArgs;
    args = [
      ...buildIdeInvocationArgs(profile.openDirArgs, { dir: workspaceDir }),
      ...buildIdeInvocationArgs(tpl, { dir: workspaceDir, file: fileResolved.absPath, line: input.line ?? 1 }),
    ];
    openedTarget = fileResolved.relPath;
  } else {
    const tpl = profile.openDirArgs.length ? profile.openDirArgs : ["{dir}"];
    args = buildIdeInvocationArgs(tpl, { dir: workspaceDir });
  }

  const exe = profile.detectedPath || profile.executable;
  const child = spawnIdeProcess(exe, args, workspaceDir, { detached: true });
  child.unref();

  return {
    ok: true,
    ideId: profile.id,
    ideName: profile.name,
    directory: workspaceDir,
    briefPath: brief.path,
    openedTarget,
  };
}

function recordRunForProject(projectId: string, run: IdeTaskRun): void {
  const list = runsByProject.get(projectId) ?? [];
  const next = [run, ...list.filter((r) => r.id !== run.id)].slice(0, 30);
  runsByProject.set(projectId, next);
}

function appendRunLog(run: IdeTaskRun, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    run.logs.push(line.slice(0, 600));
    if (run.logs.length > 150) run.logs.shift();
  }
}

export async function dispatchIdeTask(input: {
  dataDir: string;
  project: Project;
  ideId?: string;
  title?: string;
  instruction: string;
  lot?: ProjectLot;
  contract?: Contract;
  lots?: readonly ProjectLot[];
  agentInstructions?: string;
  agentRules?: readonly string[];
}): Promise<{ run: IdeTaskRun; promptText: string }> {
  const cleanInstruction = String(input.instruction ?? "").trim();
  if (!cleanInstruction) {
    throw new AgencyError("VALIDATION_ERROR", "Task instruction for IDE is required");
  }
  const profile = resolveIdeProfile(input.dataDir, input.ideId);
  const { workspaceDir, mode } = resolveProjectDirectory(input.dataDir, input.project);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const brief = syncProjectBriefToDisk({
    dataDir: input.dataDir,
    project: input.project,
    contract: input.contract,
    lots: input.lots ?? (input.lot ? [input.lot] : []),
  });

  const runId = `run-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const missionRel = mode === "linked" ? `.anymodelbot/missions/${runId}.md` : `missions/${runId}.md`;
  const missionAbs = path.join(workspaceDir, missionRel);
  fs.mkdirSync(path.dirname(missionAbs), { recursive: true });

  const promptSections = [
    `# Mission AnyModelBot — ${input.title?.trim() || input.project.title}`,
    `- Projet : ${input.project.title} (${input.project.id})`,
    `- Dossier : ${workspaceDir}`,
    `- Stack cible : ${input.project.targetStack.join(", ") || "standard"}`,
    `- Brief complet : ${brief.path}`,
    input.lot
      ? `\n## Lot #${input.lot.lotOrder} — ${input.lot.title}\n${input.lot.description || ""}\nCritères d'acceptation :\n${(input.lot.acceptanceCriteria ?? []).map((c) => `- ${c}`).join("\n")}`
      : "",
    input.agentInstructions?.trim() ? `\n## Rôle & Instructions\n${input.agentInstructions.trim()}` : "",
    input.agentRules?.length ? `\n## Règles\n${input.agentRules.map((r) => `- ${r}`).join("\n")}` : "",
    `\n## Demande à implémenter\n${cleanInstruction}`,
    `\n## Exigence de validation\nExécute les vérifications appropriées (typecheck, tests, build) dans le dossier du projet avant de conclure.`,
  ].filter(Boolean);

  const promptText = promptSections.join("\n");
  fs.writeFileSync(missionAbs, promptText, "utf8");

  const useCliRunner = profile.category === "cli_agent" && profile.promptArgs.length > 0;
  const run: IdeTaskRun = {
    id: runId,
    projectId: input.project.id,
    ideId: profile.id,
    ideName: profile.name,
    mode: useCliRunner ? "cli" : "ide",
    title: input.title?.trim() || input.lot?.title || cleanInstruction.slice(0, 90),
    status: useCliRunner ? "running" : "dispatched_to_ide",
    missionFile: missionRel,
    promptPreview: cleanInstruction.slice(0, 240),
    startedAt: Date.now(),
    logs: [],
    changedFiles: [],
  };

  recordRunForProject(input.project.id, run);

  const exe = profile.detectedPath || profile.executable;
  if (!useCliRunner) {
    // GUI IDE: open both the project folder and the generated mission brief file directly inside the IDE
    const dirArgs = buildIdeInvocationArgs(profile.openDirArgs.length ? profile.openDirArgs : ["{dir}"], {
      dir: workspaceDir,
    });
    const fileArgs = profile.openFileArgs.length
      ? buildIdeInvocationArgs(profile.openFileArgs, { dir: workspaceDir, file: missionAbs, line: 1 })
      : [missionAbs];
    const child = spawnIdeProcess(exe, [...dirArgs, ...fileArgs], workspaceDir, { detached: true });
    child.unref();
    run.finishedAt = Date.now();
    run.summary = `Projet et brief de mission (${missionRel}) ouverts dans ${profile.name}.`;
    appendRunLog(run, run.summary);
    return { run, promptText };
  }

  // CLI coding agent: execute asynchronously with live log streaming + stop support
  const cliArgs = buildIdeInvocationArgs(profile.promptArgs, {
    dir: workspaceDir,
    file: missionAbs,
    missionFile: missionRel,
    prompt: promptText,
  });

  const child = spawnIdeProcess(exe, cliArgs, workspaceDir, { detached: false });
  activeRuns.set(runId, { run, child, dataDir: input.dataDir, project: input.project });
  appendRunLog(run, `$ ${path.basename(exe)} ... (mission: ${missionRel})`);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => appendRunLog(run, chunk));
  child.stderr?.on("data", (chunk: string) => appendRunLog(run, chunk));

  let finalizeStarted = false;
  const finalize = async (exitCode: number) => {
    if (finalizeStarted || run.status === "cancelled") return;
    finalizeStarted = true;
    run.exitCode = exitCode;
    try {
      const snap = await getProjectEvolutionSnapshot(input.dataDir, input.project);
      run.changedFiles = snap.git.changes.map((c) => c.path);
    } catch {
      /* optional git status */
    }
    const finalStatus = exitCode === 0 ? "completed" : "failed";
    run.summary =
      finalStatus === "completed"
        ? `${profile.name} terminé (code 0, ${run.changedFiles.length} fichier(s) modifié(s)).`
        : `${profile.name} terminé avec le code ${exitCode}.`;
    run.finishedAt = Date.now();
    run.status = finalStatus;
    activeRuns.delete(runId);
  };

  child.on("error", (err) => {
    appendRunLog(run, err.message || "Process error");
    void finalize(1);
  });
  child.on("close", (code) => {
    void finalize(typeof code === "number" ? code : 1);
  });

  return { run, promptText };
}

export function listIdeTaskRuns(projectId: string): IdeTaskRun[] {
  return [...(runsByProject.get(projectId) ?? [])];
}

export function stopIdeTaskRun(runId: string): IdeTaskRun | null {
  const entry = activeRuns.get(runId);
  if (!entry) return null;
  entry.run.status = "cancelled";
  entry.run.finishedAt = Date.now();
  entry.run.summary = "Exécution IDE/CLI interrompue par l'opérateur.";
  appendRunLog(entry.run, entry.run.summary);
  if (entry.child && !entry.child.killed) {
    try {
      if (process.platform === "win32" && entry.child.pid) {
        execFile("taskkill", ["/pid", String(entry.child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else {
        entry.child.kill("SIGTERM");
      }
    } catch {
      /* best effort */
    }
  }
  activeRuns.delete(runId);
  return entry.run;
}
