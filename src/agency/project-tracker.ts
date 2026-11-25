import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelClient } from "../llm/client.js";
import { AgencyError } from "./errors.js";
import type { AgencyAgentRole, Contract, CreateProjectLotInput, Project, ProjectLot } from "./types.js";
import { initProjectWorkspace, resolveProjectDirectory, validateLocalProductDirectory } from "./workspace-runner.js";

export type ProjectCommandAction = "git_status" | "npm_install" | "npm_typecheck" | "npm_test" | "npm_build";

export interface MachineDirectoryEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasPackageJson: boolean;
}

export interface ProjectFileItem {
  path: string;
  size: number;
  updatedAt: number;
  ext: string;
}

export interface ProjectFileContent {
  path: string;
  content: string;
  size: number;
  updatedAt: number;
  lines: number;
  isBinary: boolean;
}

export interface ProjectGitChange {
  code: string;
  path: string;
}

export interface ProjectGitCommit {
  hash: string;
  shortHash: string;
  date: string;
  author: string;
  subject: string;
}

export interface ProjectEvolutionSnapshot {
  directory: string;
  mode: "linked" | "managed";
  exists: boolean;
  stack: string[];
  scripts: string[];
  stats: {
    fileCount: number;
    totalBytes: number;
    byExtension: Array<{ ext: string; count: number; bytes: number }>;
  };
  recentFiles: ProjectFileItem[];
  git: {
    isRepo: boolean;
    branch: string;
    changes: ProjectGitChange[];
    recentCommits: ProjectGitCommit[];
    diffStat: string;
  };
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".turbo",
  "coverage",
]);

const MAX_LIST_FILES = 600;
const MAX_READ_BYTES = 512 * 1024;

function execProjectCmd(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          ...(signal ? { signal } : {}),
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
            return;
          }
          const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
          resolve({ exitCode: code, stdout: stdout ?? "", stderr: stderr || err.message || "command failed" });
        },
      );
    } catch (error) {
      resolve({ exitCode: 1, stdout: "", stderr: (error as Error).message || "spawn failed" });
    }
  });
}

function listWindowsRoots(): MachineDirectoryEntry[] {
  const entries: MachineDirectoryEntry[] = [];
  for (let code = 67; code <= 90; code++) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(drive)) {
        entries.push({
          name: drive,
          path: drive,
          isGitRepo: false,
          hasPackageJson: false,
        });
      }
    } catch {
      /* ignore inaccessible drives */
    }
  }
  return entries;
}

export function browseMachineDirectories(dirPath?: string): {
  currentPath: string;
  parentPath: string | null;
  homePath: string;
  entries: MachineDirectoryEntry[];
} {
  const homePath = os.homedir();
  const raw = String(dirPath ?? "").trim();

  if (!raw) {
    if (process.platform === "win32") {
      return {
        currentPath: "",
        parentPath: null,
        homePath,
        entries: listWindowsRoots(),
      };
    }
    return browseMachineDirectories(homePath || "/");
  }

  if (raw.split(/[\\/]+/).some((seg) => seg === "..")) {
    throw new AgencyError("FORBIDDEN", "Parent traversal segments are not allowed");
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new AgencyError("NOT_FOUND", `Directory not found: ${resolved}`);
  }

  const parsed = path.parse(resolved);
  const parent = resolved === parsed.root ? (process.platform === "win32" ? "" : null) : path.dirname(resolved);

  const entries: MachineDirectoryEntry[] = [];
  try {
    const dirents = fs.readdirSync(resolved, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name === "System Volume Information" || dirent.name === "$Recycle.Bin") continue;
      const childPath = path.join(resolved, dirent.name);
      let isGitRepo = false;
      let hasPackageJson = false;
      try {
        isGitRepo = fs.existsSync(path.join(childPath, ".git"));
        hasPackageJson = fs.existsSync(path.join(childPath, "package.json"));
      } catch {
        /* ignore permission errors */
      }
      entries.push({
        name: dirent.name,
        path: childPath,
        isGitRepo,
        hasPackageJson,
      });
    }
  } catch (err) {
    throw new AgencyError("FORBIDDEN", (err as Error).message || "Directory unreadable");
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return {
    currentPath: resolved,
    parentPath: parent,
    homePath,
    entries: entries.slice(0, 250),
  };
}

export function resolveProjectFile(
  dataDir: string,
  project: Pick<Project, "workspacePath" | "localPath">,
  relFilePath: string,
): { workspaceDir: string; absPath: string; relPath: string } {
  const { workspaceDir } = resolveProjectDirectory(dataDir, project);
  const raw = String(relFilePath ?? "").trim();
  if (!raw || raw.includes("\0")) {
    throw new AgencyError("VALIDATION_ERROR", "File path is required");
  }
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    throw new AgencyError("FORBIDDEN", "Absolute file paths are not allowed");
  }
  const normalized = raw.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === "." || s === ".." || s === ".git")) {
    throw new AgencyError("FORBIDDEN", "Disallowed path segment inside project directory");
  }
  const relPath = segments.join("/");
  const absPath = path.resolve(workspaceDir, ...segments);
  if (absPath !== workspaceDir && !absPath.startsWith(workspaceDir + path.sep)) {
    throw new AgencyError("FORBIDDEN", "File path escapes project directory");
  }
  let cur = workspaceDir;
  for (const seg of segments) {
    cur = path.join(cur, seg);
    if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) {
      throw new AgencyError("FORBIDDEN", "Symbolic links are not allowed inside project directory");
    }
  }
  return { workspaceDir, absPath, relPath };
}

export function listProjectFiles(
  dataDir: string,
  project: Pick<Project, "workspacePath" | "localPath">,
  options?: { query?: string; limit?: number },
): ProjectFileItem[] {
  const { workspaceDir } = resolveProjectDirectory(dataDir, project);
  if (!fs.existsSync(workspaceDir)) return [];
  const limit = Math.max(1, Math.min(MAX_LIST_FILES, options?.limit ?? MAX_LIST_FILES));
  const query = (options?.query ?? "").trim().toLowerCase();
  const results: ProjectFileItem[] = [];

  const walk = (dir: string, relBase: string) => {
    if (results.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (query && !rel.toLowerCase().includes(query)) continue;
      try {
        const stat = fs.statSync(abs);
        results.push({
          path: rel,
          size: stat.size,
          updatedAt: Math.round(stat.mtimeMs),
          ext: path.extname(entry.name).toLowerCase() || "(none)",
        });
      } catch {
        /* ignore unreadable file */
      }
    }
  };

  walk(workspaceDir, "");
  return results;
}

export function readProjectFile(
  dataDir: string,
  project: Pick<Project, "workspacePath" | "localPath">,
  relFilePath: string,
): ProjectFileContent {
  const { absPath, relPath } = resolveProjectFile(dataDir, project, relFilePath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    throw new AgencyError("NOT_FOUND", `File not found: ${relPath}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.size > MAX_READ_BYTES) {
    throw new AgencyError("VALIDATION_ERROR", `File "${relPath}" exceeds preview limit (512 KB)`);
  }
  const buf = fs.readFileSync(absPath);
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  const isBinary = sample.includes(0);
  if (isBinary) {
    return {
      path: relPath,
      content: "(Fichier binaire)",
      size: stat.size,
      updatedAt: Math.round(stat.mtimeMs),
      lines: 0,
      isBinary: true,
    };
  }
  const content = buf.toString("utf8");
  return {
    path: relPath,
    content,
    size: stat.size,
    updatedAt: Math.round(stat.mtimeMs),
    lines: content ? content.split(/\r?\n/).length : 0,
    isBinary: false,
  };
}

export function writeProjectMetaFile(
  dataDir: string,
  project: Pick<Project, "workspacePath" | "localPath">,
  relFilePath: string,
  content: string,
): { path: string; size: number; updatedAt: number } {
  const { workspaceDir, absPath, relPath } = resolveProjectFile(dataDir, project, relFilePath);
  if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
    throw new AgencyError("VALIDATION_ERROR", "File content exceeds maximum size (512 KB)");
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
  const stat = fs.statSync(absPath);
  return { path: relPath, size: stat.size, updatedAt: Math.round(stat.mtimeMs) };
}

function detectStackAndScripts(workspaceDir: string): { stack: string[]; scripts: string[] } {
  const stack = new Set<string>();
  const scripts: string[] = [];
  const pkgPath = path.join(workspaceDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    stack.add("Node.js");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const s of Object.keys(pkg.scripts ?? {})) scripts.push(s);
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps.react) stack.add("React");
      if (deps.preact) stack.add("Preact");
      if (deps.next) stack.add("Next.js");
      if (deps.vue) stack.add("Vue");
      if (deps.svelte) stack.add("Svelte");
      if (deps.vite) stack.add("Vite");
      if (deps.typescript) stack.add("TypeScript");
      if (deps.tailwindcss) stack.add("Tailwind CSS");
      if (deps.express || deps.fastify || deps.hono) stack.add("Node API");
    } catch {
      /* ignore malformed package.json */
    }
  }
  if (fs.existsSync(path.join(workspaceDir, "tsconfig.json"))) stack.add("TypeScript");
  if (fs.existsSync(path.join(workspaceDir, "pyproject.toml")) || fs.existsSync(path.join(workspaceDir, "requirements.txt"))) {
    stack.add("Python");
  }
  if (fs.existsSync(path.join(workspaceDir, "Cargo.toml"))) stack.add("Rust");
  if (fs.existsSync(path.join(workspaceDir, "go.mod"))) stack.add("Go");
  if (fs.existsSync(path.join(workspaceDir, "pubspec.yaml"))) stack.add("Flutter");
  if (fs.existsSync(path.join(workspaceDir, "composer.json"))) stack.add("PHP");
  return { stack: [...stack], scripts };
}

export async function getProjectEvolutionSnapshot(
  dataDir: string,
  project: Project,
): Promise<ProjectEvolutionSnapshot> {
  const resolved = resolveProjectDirectory(dataDir, project);
  const workspaceDir = resolved.workspaceDir;
  if (!fs.existsSync(workspaceDir)) {
    return {
      directory: workspaceDir,
      mode: resolved.mode,
      exists: false,
      stack: project.targetStack,
      scripts: [],
      stats: { fileCount: 0, totalBytes: 0, byExtension: [] },
      recentFiles: [],
      git: { isRepo: false, branch: "", changes: [], recentCommits: [], diffStat: "" },
    };
  }

  const allFiles = listProjectFiles(dataDir, project, { limit: MAX_LIST_FILES });
  let totalBytes = 0;
  const extAgg = new Map<string, { count: number; bytes: number }>();
  for (const f of allFiles) {
    totalBytes += f.size;
    const prev = extAgg.get(f.ext) ?? { count: 0, bytes: 0 };
    prev.count += 1;
    prev.bytes += f.size;
    extAgg.set(f.ext, prev);
  }
  const byExtension = [...extAgg.entries()]
    .map(([ext, v]) => ({ ext, count: v.count, bytes: v.bytes }))
    .sort((a, b) => b.count - a.count || b.bytes - a.bytes)
    .slice(0, 10);

  const recentFiles = [...allFiles]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);

  const { stack, scripts } = detectStackAndScripts(workspaceDir);

  let isRepo = false;
  let branch = "";
  const changes: ProjectGitChange[] = [];
  const recentCommits: ProjectGitCommit[] = [];
  let diffStat = "";

  const probe = await execProjectCmd("git", ["rev-parse", "--is-inside-work-tree"], workspaceDir, undefined, 8_000);
  if (probe.exitCode === 0 && probe.stdout.trim() === "true") {
    isRepo = true;
    const [brRes, stRes, logRes, diffRes] = await Promise.all([
      execProjectCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], workspaceDir, undefined, 8_000),
      execProjectCmd("git", ["status", "--porcelain"], workspaceDir, undefined, 10_000),
      execProjectCmd("git", ["log", "-n", "15", "--pretty=format:%H%x1f%h%x1f%aI%x1f%an%x1f%s"], workspaceDir, undefined, 10_000),
      execProjectCmd("git", ["diff", "--shortstat"], workspaceDir, undefined, 10_000),
    ]);
    if (brRes.exitCode === 0) branch = brRes.stdout.trim();
    if (stRes.exitCode === 0) {
      for (const rawLine of stRes.stdout.split(/\r?\n/)) {
        if (!rawLine.trim()) continue;
        const code = rawLine.slice(0, 2).trim() || "M";
        const filePath = rawLine.slice(3).trim();
        if (filePath) changes.push({ code, path: filePath });
      }
    }
    if (logRes.exitCode === 0 && logRes.stdout.trim()) {
      for (const line of logRes.stdout.split(/\r?\n/)) {
        const [hash, shortHash, date, author, subject] = line.split("\x1f");
        if (hash && subject !== undefined) {
          recentCommits.push({ hash, shortHash: shortHash || hash.slice(0, 7), date: date || "", author: author || "", subject });
        }
      }
    }
    if (diffRes.exitCode === 0) diffStat = diffRes.stdout.trim();
  }

  return {
    directory: workspaceDir,
    mode: resolved.mode,
    exists: true,
    stack: stack.length ? stack : project.targetStack,
    scripts,
    stats: {
      fileCount: allFiles.length,
      totalBytes,
      byExtension,
    },
    recentFiles,
    git: {
      isRepo,
      branch,
      changes: changes.slice(0, 80),
      recentCommits,
      diffStat,
    },
  };
}

export async function getProjectGitDiff(
  dataDir: string,
  project: Project,
  relPath?: string,
): Promise<{ patch: string; truncated: boolean }> {
  const { workspaceDir } = resolveProjectDirectory(dataDir, project);
  if (!fs.existsSync(workspaceDir)) {
    throw new AgencyError("CONFLICT", "Project directory does not exist on disk");
  }
  const args = ["diff", "--no-color"];
  if (relPath && relPath.trim()) {
    const { relPath: safeRel } = resolveProjectFile(dataDir, project, relPath);
    args.push("--", safeRel);
  }
  const res = await execProjectCmd("git", args, workspaceDir, undefined, 15_000);
  let patch = res.stdout || "";
  if (!patch && relPath && relPath.trim()) {
    // Check untracked file preview cleanly
    try {
      const { absPath, relPath: safeRel } = resolveProjectFile(dataDir, project, relPath);
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        const content = readProjectFile(dataDir, project, safeRel);
        if (!content.isBinary) {
          patch = `--- /dev/null\n+++ b/${safeRel}\n${content.content.split(/\r?\n/).slice(0, 200).map((l) => `+${l}`).join("\n")}`;
        }
      }
    } catch {
      /* ignore */
    }
  }
  const limit = 120_000;
  const truncated = patch.length > limit;
  return {
    patch: truncated ? `${patch.slice(0, limit)}\n... [diff tronqué]` : patch,
    truncated,
  };
}

export function syncProjectBriefToDisk(input: {
  dataDir: string;
  project: Project;
  contract?: Contract;
  lots: readonly ProjectLot[];
}): { path: string; directory: string; mode: "linked" | "managed" } {
  const init = initProjectWorkspace(input);
  return {
    path: init.files[0] || ".anymodelbot/BRIEF.md",
    directory: init.directory,
    mode: init.mode,
  };
}

export async function runProjectCommand(input: {
  dataDir: string;
  project: Project;
  action: ProjectCommandAction;
  signal?: AbortSignal;
}): Promise<{ action: ProjectCommandAction; exitCode: number; output: string }> {
  const { workspaceDir } = resolveProjectDirectory(input.dataDir, input.project);
  if (!fs.existsSync(workspaceDir)) {
    throw new AgencyError("CONFLICT", "Project directory is not initialized yet");
  }
  const npm = (subArgs: string[]) => {
    if (process.platform === "win32") {
      const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      if (fs.existsSync(npmCli)) return { command: process.execPath, args: [npmCli, ...subArgs] };
    }
    return { command: "npm", args: subArgs };
  };

  let spec: { command: string; args: string[]; timeoutMs?: number };
  switch (input.action) {
    case "git_status":
      spec = { command: "git", args: ["status", "--short"], timeoutMs: 30_000 };
      break;
    case "npm_test":
      spec = { ...npm(["test"]), timeoutMs: 180_000 };
      break;
    case "npm_typecheck":
      spec = { ...npm(["run", "typecheck"]), timeoutMs: 120_000 };
      break;
    case "npm_build":
      spec = { ...npm(["run", "build"]), timeoutMs: 180_000 };
      break;
    case "npm_install":
      spec = { ...npm(["install", "--no-audit", "--no-fund"]), timeoutMs: 240_000 };
      break;
    default:
      throw new AgencyError("VALIDATION_ERROR", `Unsupported command action: ${String(input.action)}`);
  }

  const res = await execProjectCmd(spec.command, spec.args, workspaceDir, input.signal, spec.timeoutMs ?? 120_000);
  const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n") || `exitCode=${res.exitCode}`;
  return { action: input.action, exitCode: res.exitCode, output: output.slice(0, 12_000) };
}

export async function planProjectLotsWithAi(input: {
  project: Project;
  contract?: Contract;
  modelClient?: ModelClient;
  defaultModel?: string;
  hasLlmEndpoint?: boolean;
  agentInstructions?: string;
  agentRules?: readonly string[];
}): Promise<{ lots: CreateProjectLotInput[]; mode: "llm" | "deterministic" }> {
  const deliverables = input.contract?.deliverables?.length
    ? input.contract.deliverables
    : [input.project.title];

  if (input.hasLlmEndpoint && input.modelClient) {
    let model = input.defaultModel?.trim() || "";
    if (!model) model = (await input.modelClient.listModels().catch(() => []))[0] ?? "";
    if (model) {
      const prompt = [
        `Project: ${input.project.title}`,
        `Stack: ${input.project.targetStack.join(", ") || "web"}`,
        `Estimated days: ${input.project.estimatedDays}`,
        `Specs: ${input.project.technicalSpecs || input.contract?.scopeSummary || "standard"}`,
        `Deliverables: ${deliverables.join("; ")}`,
        `Return ONLY a JSON array of 3 to 6 project lots with fields: title, description, acceptanceCriteria (string[]), ownerRole (one of architect, developer, ui_ux, qa_functional, qa_technical, qa_security), estimatedHours (number).`,
      ].join("\n");
      try {
        const agentDirective = [
          input.agentInstructions?.trim() ? `Agent instructions: ${input.agentInstructions.trim()}` : "",
          input.agentRules?.length ? `Agent rules:\n${input.agentRules.map((r) => `- ${r}`).join("\n")}` : "",
        ].filter(Boolean).join("\n");
        const raw = await input.modelClient.streamChat(
          {
            model,
            messages: [
              {
                role: "system",
                content: ["You are an agency Project Manager. Return strictly valid JSON array, no markdown.", agentDirective]
                  .filter(Boolean)
                  .join("\n"),
              },
              { role: "user", content: prompt },
            ],
          },
          () => {},
        );
        const match = raw.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(match ? match[0] : raw) as Array<Record<string, unknown>>;
        const validRoles = new Set<AgencyAgentRole>(["architect", "developer", "ui_ux", "qa_functional", "qa_technical", "qa_security"]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const lots: CreateProjectLotInput[] = parsed.slice(0, 8).map((item, idx) => ({
            lotOrder: idx + 1,
            title: String(item.title || `Lot ${idx + 1}`).slice(0, 200),
            description: String(item.description || "").slice(0, 2000),
            acceptanceCriteria: Array.isArray(item.acceptanceCriteria)
              ? item.acceptanceCriteria.map((c) => String(c).slice(0, 280)).filter(Boolean).slice(0, 10)
              : ["Tests unitaires et revue OK"],
            ownerRole: validRoles.has(item.ownerRole as AgencyAgentRole) ? (item.ownerRole as AgencyAgentRole) : "developer",
            estimatedHours: Math.max(1, Math.min(200, Number(item.estimatedHours) || 8)),
          }));
          return { lots, mode: "llm" };
        }
      } catch {
        /* fallback to deterministic plan */
      }
    }
  }

  const totalHours = Math.max(8, input.project.estimatedDays * 6);
  const lots: CreateProjectLotInput[] = [
    {
      lotOrder: 1,
      title: "Architecture & Socle technique",
      description: `Initialisation et architecture ${input.project.targetStack.join(", ") || "web"}.`,
      acceptanceCriteria: ["Brief technique validé", "Structure et scripts de test prêts"],
      ownerRole: "architect",
      estimatedHours: Math.max(2, Math.round(totalHours * 0.15)),
    },
    ...deliverables.slice(0, 4).map((deliv, idx) => ({
      lotOrder: idx + 2,
      title: deliv.slice(0, 200),
      description: `Réalisation fonctionnelle et tests du livrable : ${deliv}`,
      acceptanceCriteria: ["Code implémenté dans le dépôt", "Tests unitaires passés"],
      ownerRole: (idx === 0 ? "ui_ux" : "developer") as AgencyAgentRole,
      estimatedHours: Math.max(4, Math.round((totalHours * 0.65) / Math.max(1, Math.min(4, deliverables.length)))),
    })),
    {
      lotOrder: deliverables.slice(0, 4).length + 2,
      title: "Validation QA 4 axes & Préparation livraison",
      description: "Audit fonctionnel, technique, UI/UX et sécurité avant recette.",
      acceptanceCriteria: ["Audit QA 4 axes validé avec preuves", "Rapport de livraison généré"],
      ownerRole: "qa_technical",
      estimatedHours: Math.max(2, Math.round(totalHours * 0.2)),
    },
  ];
  return { lots, mode: "deterministic" };
}

export function extractReadablePdfText(buf: Buffer): string {
  const latin = buf.toString("latin1");
  const runs = latin.match(/[\x20-\x7e\u00c0-\u00ff]{4,}/g) ?? [];
  return runs
    .filter((r) => !/^(%PDF-|endobj|endstream|stream|xref|trailer|startxref|\/Type|\/Filter|\/Length)/.test(r))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18_000);
}

export async function ingestProjectDocuments(input: {
  dataDir: string;
  project: Project;
  contract?: Contract;
  lots?: readonly ProjectLot[];
  cahierDesCharges?: string;
  files?: ReadonlyArray<{
    name: string;
    mimeType?: string;
    textContent?: string;
    base64Content?: string;
  }>;
}): Promise<{ writtenFiles: string[]; briefUpdated: boolean }> {
  const init = initProjectWorkspace({
    dataDir: input.dataDir,
    project: input.project,
    contract: input.contract,
    lots: input.lots ?? [],
  });
  const writtenFiles: string[] = [];
  const docRoot = init.mode === "linked" ? ".anymodelbot" : "docs";
  const briefRel = init.mode === "linked" ? ".anymodelbot/BRIEF.md" : "BRIEF.md";

  const cleanSpecs = (input.cahierDesCharges ?? "").trim();
  if (cleanSpecs) {
    const savedSpec = writeProjectMetaFile(
      input.dataDir,
      input.project,
      `${docRoot}/CAHIER-DES-CHARGES.md`,
      `# Cahier des charges — ${input.project.title}\n\n${cleanSpecs}\n`,
    );
    writtenFiles.push(savedSpec.path);
  }

  const docFiles = (input.files ?? []).slice(0, 10);
  const ingestedSources: string[] = [];
  for (const file of docFiles) {
    const base = path.basename(String(file.name || "document.txt"))
      .replace(/[^\w.-]/g, "_")
      .slice(0, 120) || "document.txt";
    const relTarget = `${docRoot}/sources/${base}`;
    if (typeof file.textContent === "string" && file.textContent.length > 0) {
      const saved = writeProjectMetaFile(input.dataDir, input.project, relTarget, file.textContent.slice(0, MAX_READ_BYTES));
      writtenFiles.push(saved.path);
      ingestedSources.push(saved.path);
      continue;
    }
    if (typeof file.base64Content === "string" && file.base64Content.trim()) {
      const buf = Buffer.from(file.base64Content.trim(), "base64");
      if (buf.length > 2 * 1024 * 1024) {
        throw new AgencyError("VALIDATION_ERROR", `Uploaded file "${base}" exceeds 2 MB limit`);
      }
      const { absPath, relPath } = resolveProjectFile(input.dataDir, input.project, relTarget);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, buf);
      writtenFiles.push(relPath);
      ingestedSources.push(relPath);
      const isPdf = (file.mimeType || "").toLowerCase().includes("pdf") || base.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        const extracted = extractReadablePdfText(buf);
        if (extracted) {
          const txtRel = `${relTarget}.txt`;
          writeProjectMetaFile(input.dataDir, input.project, txtRel, extracted);
          writtenFiles.push(txtRel);
        }
      }
    }
  }

  let briefUpdated = false;
  if (cleanSpecs || ingestedSources.length > 0) {
    const currentBrief = readProjectFile(input.dataDir, input.project, briefRel).content;
    const sectionLines = [
      "",
      "## Cahier des charges & Documents sources",
      ...(cleanSpecs ? [`- \`${docRoot}/CAHIER-DES-CHARGES.md\``] : []),
      ...ingestedSources.map((s) => `- \`${s}\``),
    ];
    writeProjectMetaFile(input.dataDir, input.project, briefRel, `${currentBrief.trimEnd()}\n${sectionLines.join("\n")}\n`);
    briefUpdated = true;
  }

  return { writtenFiles: [...new Set(writtenFiles)], briefUpdated };
}

export { validateLocalProductDirectory };
