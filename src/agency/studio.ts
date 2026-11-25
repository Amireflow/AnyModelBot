import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ModelClient } from "../llm/client.js";
import { AgencyError } from "./errors.js";
import type { AgencyAgentRole, Contract, CreateProjectLotInput, Project, ProjectLot } from "./types.js";
import { initProjectWorkspace, resolveSafeWorkspacePath } from "./workspace-runner.js";

export type StudioTemplateId = "vitrine-html" | "webapp-node-preact" | "api-node-ts";
export type StudioCommandAction = "npm_test" | "npm_typecheck" | "npm_build" | "git_status" | "npm_install";

export interface StudioFileEntry {
  path: string;
  size: number;
  updatedAt: number;
}

export interface StudioAgentStep {
  step: number;
  tool: string;
  target: string;
  ok: boolean;
  summary: string;
}

const MAX_LIST_FILES = 500;
const MAX_READ_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const ALLOWED_PREVIEW_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export function resolveWorkspaceFile(
  dataDir: string,
  workspacePath: string,
  relFilePath: string,
): { workspaceDir: string; absPath: string; relPath: string } {
  const { workspaceDir } = resolveSafeWorkspacePath(dataDir, workspacePath);
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
    throw new AgencyError("FORBIDDEN", "Disallowed path segment inside project workspace");
  }
  const relPath = segments.join("/");
  const absPath = path.resolve(workspaceDir, ...segments);
  if (absPath !== workspaceDir && !absPath.startsWith(workspaceDir + path.sep)) {
    throw new AgencyError("FORBIDDEN", "File path escapes confined project workspace");
  }
  let cur = workspaceDir;
  for (const seg of segments) {
    cur = path.join(cur, seg);
    if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) {
      throw new AgencyError("FORBIDDEN", "Symbolic links are not allowed inside project workspace");
    }
  }
  return { workspaceDir, absPath, relPath };
}

export function listWorkspaceFiles(dataDir: string, project: Project): StudioFileEntry[] {
  const { workspaceDir } = resolveSafeWorkspacePath(dataDir, project.workspacePath);
  if (!fs.existsSync(workspaceDir)) return [];
  const entries: StudioFileEntry[] = [];
  const walk = (dir: string, relBase: string) => {
    if (entries.length >= MAX_LIST_FILES) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entries.length >= MAX_LIST_FILES) break;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) {
          walk(path.join(dir, item.name), relBase ? `${relBase}/${item.name}` : item.name);
        }
        continue;
      }
      if (!item.isFile()) continue;
      const abs = path.join(dir, item.name);
      const stat = fs.statSync(abs);
      entries.push({
        path: relBase ? `${relBase}/${item.name}` : item.name,
        size: stat.size,
        updatedAt: Math.round(stat.mtimeMs),
      });
    }
  };
  walk(workspaceDir, "");
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function readWorkspaceFile(dataDir: string, project: Project, relFilePath: string): {
  path: string;
  content: string;
  size: number;
  updatedAt: number;
} {
  const { absPath, relPath } = resolveWorkspaceFile(dataDir, project.workspacePath, relFilePath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    throw new AgencyError("NOT_FOUND", `File not found: ${relPath}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.size > MAX_READ_BYTES) {
    throw new AgencyError("VALIDATION_ERROR", `File exceeds ${MAX_READ_BYTES} bytes preview/edit limit`);
  }
  return {
    path: relPath,
    content: fs.readFileSync(absPath, "utf8"),
    size: stat.size,
    updatedAt: Math.round(stat.mtimeMs),
  };
}

export function writeWorkspaceFile(
  dataDir: string,
  project: Project,
  relFilePath: string,
  content: string,
): { path: string; size: number; updatedAt: number } {
  const { workspaceDir, absPath, relPath } = resolveWorkspaceFile(dataDir, project.workspacePath, relFilePath);
  if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
    throw new AgencyError("VALIDATION_ERROR", "File content exceeds maximum size (512 KB)");
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
  const stat = fs.statSync(absPath);
  return { path: relPath, size: stat.size, updatedAt: Math.round(stat.mtimeMs) };
}

export function deleteWorkspaceFile(dataDir: string, project: Project, relFilePath: string): { deleted: string } {
  const { absPath, relPath } = resolveWorkspaceFile(dataDir, project.workspacePath, relFilePath);
  if (!fs.existsSync(absPath)) {
    throw new AgencyError("NOT_FOUND", `File not found: ${relPath}`);
  }
  if (fs.statSync(absPath).isDirectory()) {
    fs.rmSync(absPath, { recursive: true, force: true });
  } else {
    fs.rmSync(absPath, { force: true });
  }
  return { deleted: relPath };
}

export function scaffoldProjectTemplate(input: {
  dataDir: string;
  project: Project;
  contract?: Contract;
  lots: readonly ProjectLot[];
  template: StudioTemplateId;
}): { template: StudioTemplateId; files: string[] } {
  initProjectWorkspace({
    dataDir: input.dataDir,
    project: input.project,
    contract: input.contract,
    lots: input.lots,
  });

  const safeTitle = input.project.title.replace(/[<>&"']/g, "");
  const slug = input.project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client-app";
  const written: string[] = [];

  if (input.template === "vitrine-html") {
    const files: Record<string, string> = {
      "index.html": `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <header class="hero">
    <nav class="nav"><strong>${safeTitle}</strong><a class="cta" href="#contact">Contact</a></nav>
    <div class="hero-body">
      <h1>${safeTitle}</h1>
      <p>${(input.project.technicalSpecs || input.contract?.scopeSummary || "Solution numérique conçue sur mesure.").replace(/[<>&]/g, "")}</p>
      <a class="btn" href="#offre">Découvrir</a>
    </div>
  </header>
  <main id="offre" class="grid">
    <section class="card"><h2>Expertise</h2><p>Architecture claire, rapide et accessible sur mobile et desktop.</p></section>
    <section class="card"><h2>Fiabilité</h2><p>Contrôle qualité multi-axes et suivi continu.</p></section>
    <section id="contact" class="card"><h2>Contact</h2><p>Parlons de votre projet et planifions votre lancement.</p></section>
  </main>
  <script src="./app.js"></script>
</body>
</html>
`,
      "styles.css": `*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #111827; background: #f8fafc; line-height: 1.6; }
.hero { padding: 24px 20px 56px; background: #0f172a; color: #f8fafc; }
.nav { max-width: 960px; margin: 0 auto 36px; display: flex; justify-content: space-between; align-items: center; }
.nav a, .btn { color: #0f172a; background: #d7ff00; padding: 10px 18px; border-radius: 999px; text-decoration: none; font-weight: 600; display: inline-block; }
.hero-body { max-width: 960px; margin: 0 auto; }
.grid { max-width: 960px; margin: 32px auto; padding: 0 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.card { background: #ffffff; border-radius: 14px; padding: 20px; box-shadow: 0 2px 10px rgba(15, 23, 42, 0.06); }
@media (max-width: 640px) { .hero { padding: 20px 16px 40px; } }
`,
      "app.js": `document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (e) => {
    const target = document.querySelector(link.getAttribute("href"));
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: "smooth" }); }
  });
});
`,
      "package.json": JSON.stringify({
        name: slug,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: {
          test: "node test/site.test.mjs",
        },
      }, null, 2),
      "test/site.test.mjs": `import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("index.html has lang, viewport, and main content", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /<html[^>]+lang=/i);
  assert.match(html, /<meta[^>]+name=["']viewport["']/i);
  assert.match(html, /<main\\b/i);
});
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      writeWorkspaceFile(input.dataDir, input.project, rel, content);
      written.push(rel);
    }
  } else if (input.template === "webapp-node-preact") {
    const files: Record<string, string> = {
      "index.html": `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main class="shell">
    <header><h1>${safeTitle}</h1><p>Application web interactive</p></header>
    <section class="panel">
      <form id="item-form">
        <input id="item-input" type="text" placeholder="Nouvel élément…" required />
        <button type="submit">Ajouter</button>
      </form>
      <ul id="item-list"></ul>
    </section>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`,
      "styles.css": `body { margin: 0; font-family: system-ui, sans-serif; background: #f3f4f6; color: #111827; }
.shell { max-width: 720px; margin: 40px auto; padding: 0 20px; }
.panel { background: #fff; border-radius: 16px; padding: 20px; display: grid; gap: 16px; }
form { display: flex; gap: 8px; }
input { flex: 1; padding: 10px 12px; border-radius: 10px; border: 1px solid #d1d5db; }
button { padding: 10px 16px; border-radius: 999px; border: 0; background: #111827; color: #fff; cursor: pointer; }
@media (max-width: 600px) { form { flex-direction: column; } }
`,
      "app.js": `const form = document.getElementById("item-form");
const input = document.getElementById("item-input");
const list = document.getElementById("item-list");
const items = [];
function render() {
  list.replaceChildren(...items.map((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    return li;
  }));
}
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = input.value.trim();
  if (!v) return;
  items.push(v);
  input.value = "";
  render();
});
`,
      "package.json": JSON.stringify({
        name: slug,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { test: "node test/app.test.mjs" },
      }, null, 2),
      "test/app.test.mjs": `import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("web app entrypoint and script exist", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /app\\.js/);
  assert.ok(fs.existsSync("app.js"));
});
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      writeWorkspaceFile(input.dataDir, input.project, rel, content);
      written.push(rel);
    }
  } else if (input.template === "api-node-ts") {
    const files: Record<string, string> = {
      "src/server.mjs": `import http from "node:http";

export function createApp() {
  return http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: ${JSON.stringify(slug)} }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: ${JSON.stringify(safeTitle)} }));
  });
}
`,
      "package.json": JSON.stringify({
        name: slug,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { test: "node --test test/server.test.mjs" },
      }, null, 2),
      "test/server.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server.mjs";

test("healthz returns ok", async () => {
  const srv = createApp();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const { port } = srv.address();
    const res = await fetch(\`http://127.0.0.1:\${port}/healthz\`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: ${JSON.stringify(slug)} });
  } finally {
    srv.close();
  }
});
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      writeWorkspaceFile(input.dataDir, input.project, rel, content);
      written.push(rel);
    }
  } else {
    throw new AgencyError("VALIDATION_ERROR", `Unsupported starter template: ${String(input.template)}`);
  }

  return { template: input.template, files: written };
}

function execStudioCmd(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { cwd, timeout: 90_000, maxBuffer: 1_048_576, shell: false, windowsHide: true, encoding: "utf8" },
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

export async function runStudioCommand(input: {
  dataDir: string;
  project: Project;
  action: StudioCommandAction;
}): Promise<{ action: StudioCommandAction; exitCode: number; output: string }> {
  const { workspaceDir } = resolveSafeWorkspacePath(input.dataDir, input.project.workspacePath);
  if (!fs.existsSync(workspaceDir)) {
    throw new AgencyError("CONFLICT", "Project workspace is not initialized yet");
  }
  const npm = (subArgs: string[]) => {
    if (process.platform === "win32") {
      const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      if (fs.existsSync(npmCli)) return { command: process.execPath, args: [npmCli, ...subArgs] };
    }
    return { command: "npm", args: subArgs };
  };

  let spec: { command: string; args: string[] };
  switch (input.action) {
    case "git_status":
      spec = { command: "git", args: ["status", "--short"] };
      break;
    case "npm_test":
      spec = npm(["test"]);
      break;
    case "npm_typecheck":
      spec = npm(["run", "typecheck"]);
      break;
    case "npm_build":
      spec = npm(["run", "build"]);
      break;
    case "npm_install":
      spec = npm(["install", "--ignore-scripts"]);
      break;
    default:
      throw new AgencyError("VALIDATION_ERROR", `Unsupported studio command: ${String(input.action)}`);
  }

  const res = await execStudioCmd(spec.command, spec.args, workspaceDir);
  const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n") || `exitCode=${res.exitCode}`;
  return { action: input.action, exitCode: res.exitCode, output: output.slice(0, 8000) };
}

export function resolveStudioPreviewAsset(
  dataDir: string,
  project: Project,
  requestedPath: string,
): { mimeType: string; data: Buffer; relPath: string } {
  const clean = requestedPath.replace(/^\/+/, "") || "index.html";
  const { workspaceDir, absPath, relPath } = resolveWorkspaceFile(dataDir, project.workspacePath, clean);
  let targetAbs = absPath;
  let targetRel = relPath;
  if ((!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) && clean === "index.html") {
    const fallback = path.join(workspaceDir, "public", "index.html");
    if (fs.existsSync(fallback) && fs.statSync(fallback).isFile()) {
      targetAbs = fallback;
      targetRel = "public/index.html";
    }
  }
  if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) {
    throw new AgencyError("NOT_FOUND", `Preview asset not found: ${targetRel}`);
  }
  const ext = path.extname(targetAbs).toLowerCase();
  const mimeType = ALLOWED_PREVIEW_MIME[ext];
  if (!mimeType) {
    throw new AgencyError("FORBIDDEN", `Preview file type not allowed: ${ext || "(none)"}`);
  }
  const stat = fs.statSync(targetAbs);
  if (stat.size > 4 * 1024 * 1024) {
    throw new AgencyError("VALIDATION_ERROR", "Preview asset exceeds 4 MB limit");
  }
  return { mimeType, data: fs.readFileSync(targetAbs), relPath: targetRel };
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
        /* fallback cleanly to deterministic plan */
      }
    }
  }

  const totalHours = Math.max(8, input.project.estimatedDays * 6);
  const lots: CreateProjectLotInput[] = [
    {
      lotOrder: 1,
      title: "Architecture & Socle technique",
      description: `Initialisation du workspace et socle ${input.project.targetStack.join(", ") || "web"}.`,
      acceptanceCriteria: ["Workspace initialisé avec BRIEF.md", "Structure et scripts de test prêts"],
      ownerRole: "architect",
      estimatedHours: Math.max(2, Math.round(totalHours * 0.15)),
    },
    ...deliverables.slice(0, 4).map((deliv, idx) => ({
      lotOrder: idx + 2,
      title: deliv.slice(0, 200),
      description: `Réalisation fonctionnelle et tests du livrable : ${deliv}`,
      acceptanceCriteria: ["Code implémenté dans le workspace", "Tests unitaires passés"],
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

export async function runStudioAiAgent(input: {
  dataDir: string;
  project: Project;
  instruction: string;
  lot?: ProjectLot;
  maxSteps?: number;
  modelClient?: ModelClient;
  defaultModel?: string;
  hasLlmEndpoint?: boolean;
  agentInstructions?: string;
  agentRules?: readonly string[];
}): Promise<{
  summary: string;
  modifiedFiles: string[];
  steps: StudioAgentStep[];
  model: string;
}> {
  if (!input.hasLlmEndpoint || !input.modelClient) {
    throw new AgencyError("VALIDATION_ERROR", "No AI model endpoint is configured in Settings");
  }
  const cleanInstruction = input.instruction.trim();
  if (!cleanInstruction) {
    throw new AgencyError("VALIDATION_ERROR", "Agent instruction is required");
  }
  let model = input.defaultModel?.trim() || "";
  if (!model) model = (await input.modelClient.listModels())[0] ?? "";
  if (!model) {
    throw new AgencyError("VALIDATION_ERROR", "No available AI models returned by the configured endpoint");
  }

  initProjectWorkspace({ dataDir: input.dataDir, project: input.project, lots: input.lot ? [input.lot] : [] });
  const maxSteps = Math.max(1, Math.min(20, Math.round(input.maxSteps ?? 8)));
  const steps: StudioAgentStep[] = [];
  const modified = new Set<string>();

  const systemPrompt = [
    `You are an autonomous software developer working strictly inside the confined workspace of project "${input.project.title}".`,
    `Target stack: ${input.project.targetStack.join(", ") || "web / node"}.`,
    input.lot ? `Active lot: #${input.lot.lotOrder} ${input.lot.title} — ${input.lot.description}` : "",
    input.agentInstructions?.trim() ? `Configured developer instructions: ${input.agentInstructions.trim()}` : "",
    input.agentRules?.length ? `Configured agency rules:\n${input.agentRules.map((r) => `- ${r}`).join("\n")}` : "",
    `You MUST respond with a single JSON object representing your next tool action:`,
    `1) {"tool":"list_files"}`,
    `2) {"tool":"read_file","path":"relative/path"}`,
    `3) {"tool":"write_file","path":"relative/path","content":"full file content"}`,
    `4) {"tool":"delete_file","path":"relative/path"}`,
    `5) {"tool":"run_check","action":"npm_test"|"npm_typecheck"|"npm_build"|"git_status"}`,
    `6) {"tool":"finish","summary":"concise factual summary of work done and verified"}`,
    `Return ONLY valid JSON without markdown code fences.`,
  ].filter(Boolean).join("\n");

  const history: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Task: ${cleanInstruction}\nCurrent files: ${listWorkspaceFiles(input.dataDir, input.project).map((f) => f.path).join(", ") || "(empty)"}`,
    },
  ];

  let finalSummary = "";
  for (let step = 1; step <= maxSteps; step++) {
    const reply = await input.modelClient.streamChat({ model, messages: history }, () => {});
    history.push({ role: "assistant", content: reply });

    let action: Record<string, unknown>;
    try {
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      action = JSON.parse(jsonMatch ? jsonMatch[0] : reply) as Record<string, unknown>;
    } catch {
      steps.push({ step, tool: "parse_error", target: "", ok: false, summary: "Invalid JSON tool response" });
      history.push({ role: "user", content: "Error: reply must be a single valid JSON object with a 'tool' field." });
      continue;
    }

    const tool = String(action.tool || "");
    if (tool === "finish") {
      finalSummary = String(action.summary || "Completed workspace updates.").trim();
      steps.push({ step, tool, target: "", ok: true, summary: finalSummary });
      break;
    }

    let observation = "";
    let ok = true;
    let target = "";
    try {
      if (tool === "list_files") {
        const list = listWorkspaceFiles(input.dataDir, input.project);
        observation = JSON.stringify(list.map((f) => ({ path: f.path, size: f.size })));
      } else if (tool === "read_file") {
        target = String(action.path || "");
        const file = readWorkspaceFile(input.dataDir, input.project, target);
        observation = file.content.slice(0, 8000);
      } else if (tool === "write_file") {
        target = String(action.path || "");
        const content = String(action.content ?? "");
        const saved = writeWorkspaceFile(input.dataDir, input.project, target, content);
        modified.add(saved.path);
        observation = `Wrote ${saved.path} (${saved.size} bytes)`;
      } else if (tool === "delete_file") {
        target = String(action.path || "");
        const removed = deleteWorkspaceFile(input.dataDir, input.project, target);
        modified.add(removed.deleted);
        observation = `Deleted ${removed.deleted}`;
      } else if (tool === "run_check") {
        const cmd = String(action.action || "npm_test") as StudioCommandAction;
        target = cmd;
        const result = await runStudioCommand({ dataDir: input.dataDir, project: input.project, action: cmd });
        ok = result.exitCode === 0;
        observation = `exitCode=${result.exitCode}\n${result.output.slice(0, 4000)}`;
      } else {
        ok = false;
        observation = `Unsupported tool: ${tool}`;
      }
    } catch (error) {
      ok = false;
      observation = (error as Error).message || "Tool execution failed";
    }

    steps.push({ step, tool, target, ok, summary: observation.slice(0, 240) });
    history.push({ role: "user", content: `Tool result (${tool}):\n${observation}` });
  }

  if (!finalSummary) {
    finalSummary = `Agent exécuté (${steps.length} étape(s), ${modified.size} fichier(s) modifié(s)).`;
  }
  return {
    summary: finalSummary,
    modifiedFiles: [...modified],
    steps,
    model,
  };
}
