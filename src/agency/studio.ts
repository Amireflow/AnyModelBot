import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ModelClient } from "../llm/client.js";
import { AgencyError } from "./errors.js";
import type { AgencyAgentRole, Contract, CreateProjectLotInput, Project, ProjectLot, StudioSnapshotEntry } from "./types.js";
import { STUDIO_XML_PROTOCOL_PROMPT, parseStudioActions, type StudioParsedAction } from "./studio-xml.js";
import { initProjectWorkspace, resolveSafeWorkspacePath } from "./workspace-runner.js";

export type StudioTemplateId =
  | "vite-react-tailwind"
  | "vitrine-html"
  | "webapp-node-preact"
  | "api-node-ts"
  | "saas-dashboard-app"
  | "ecommerce-storefront";
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

export function patchWorkspaceFile(
  dataDir: string,
  project: Project,
  relFilePath: string,
  search: string,
  replace: string,
): { path: string; size: number; replacements: number } {
  if (!search) {
    throw new AgencyError("VALIDATION_ERROR", "patch_file requires a non-empty search block");
  }
  const current = readWorkspaceFile(dataDir, project, relFilePath);
  const idx = current.content.indexOf(search);
  if (idx < 0) {
    throw new AgencyError("CONFLICT", `Search snippet not found in ${current.path}`);
  }
  const next = current.content.slice(0, idx) + replace + current.content.slice(idx + search.length);
  const saved = writeWorkspaceFile(dataDir, project, current.path, next);
  return { path: saved.path, size: saved.size, replacements: 1 };
}

export function searchWorkspaceFiles(
  dataDir: string,
  project: Project,
  query: string,
): Array<{ path: string; line: number; text: string }> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    throw new AgencyError("VALIDATION_ERROR", "search_files query is required");
  }
  const files = listWorkspaceFiles(dataDir, project);
  const hits: Array<{ path: string; line: number; text: string }> = [];
  for (const entry of files) {
    if (hits.length >= 30) break;
    let content = "";
    try {
      content = readWorkspaceFile(dataDir, project, entry.path).content;
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ path: entry.path, line: i + 1, text: lines[i].trim().slice(0, 160) });
        if (hits.length >= 30) break;
      }
    }
  }
  return hits;
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

  if (input.template === "vite-react-tailwind") {
    const files: Record<string, string> = {
      "index.html": `<!doctype html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-50 antialiased">
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`,
      "vite.config.js": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,
      "src/main.jsx": `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
      "src/index.css": `*, *::before, *::after { box-sizing: border-box; }
html, body, #root { min-height: 100%; margin: 0; }
`,
      "src/App.jsx": `import React from "react";

export default function App() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8 bg-slate-950 text-slate-100">
      <div className="max-w-xl w-full rounded-2xl border border-slate-800 bg-slate-900/70 p-8 shadow-xl space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">${safeTitle}</h1>
        <p className="text-sm text-slate-400">${(input.project.technicalSpecs || input.contract?.scopeSummary || "Workspace Vite + React + Tailwind prêt.").replace(/[<>&]/g, "")}</p>
      </div>
    </main>
  );
}
`,
      "package.json": JSON.stringify({
        name: slug,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "vite",
          build: "vite build",
          preview: "vite preview",
        },
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        devDependencies: {
          "@vitejs/plugin-react": "^4.3.4",
          vite: "^5.4.11",
        },
      }, null, 2),
    };
    for (const [rel, content] of Object.entries(files)) {
      writeWorkspaceFile(input.dataDir, input.project, rel, content);
      written.push(rel);
    }
  } else if (input.template === "vitrine-html") {
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
  } else if (input.template === "saas-dashboard-app") {
    const files: Record<string, string> = {
      "index.html": `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle} — Tableau de bord</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">${safeTitle}</div>
      <nav aria-label="Navigation principale">
        <button type="button" class="nav-btn active" data-view="overview">Vue d'ensemble</button>
        <button type="button" class="nav-btn" data-view="clients">Clients</button>
        <button type="button" class="nav-btn" data-view="settings">Paramètres</button>
      </nav>
    </aside>
    <main class="main">
      <header class="topbar">
        <h1 id="view-title">Vue d'ensemble</h1>
        <form id="record-form" class="inline-form">
          <input id="record-name" type="text" placeholder="Nouvelle entrée…" required />
          <input id="record-amount" type="number" min="0" placeholder="Montant" required />
          <button type="submit">Ajouter</button>
        </form>
      </header>
      <section id="kpi-row" class="kpi-grid" aria-label="Indicateurs"></section>
      <section class="card">
        <div class="card-head">
          <h2>Registre opérationnel</h2>
          <input id="filter-input" type="search" placeholder="Filtrer…" aria-label="Filtrer" />
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Libellé</th><th>Montant</th><th>Statut</th></tr></thead>
            <tbody id="records-body"></tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
  <script type="module" src="./app.js"></script>
</body>
</html>
`,
      "styles.css": `:root {
  --bg: #f4f6f9;
  --surface: #ffffff;
  --ink: #0f172a;
  --muted: #64748b;
  --accent: #0f766e;
  --line: #e2e8f0;
  --radius: 14px;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--ink); }
.layout { display: grid; grid-template-columns: 230px minmax(0, 1fr); min-height: 100vh; }
.sidebar { background: #0f172a; color: #f8fafc; padding: 24px 16px; display: grid; align-content: start; gap: 20px; }
.brand { font-weight: 700; font-size: 1.05rem; }
.sidebar nav { display: grid; gap: 6px; }
.nav-btn { text-align: start; border: 0; background: transparent; color: #cbd5e1; padding: 10px 12px; border-radius: 10px; cursor: pointer; }
.nav-btn.active, .nav-btn:hover { background: rgba(255,255,255,.12); color: #fff; }
.main { padding: 28px; display: grid; align-content: start; gap: 20px; }
.topbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.topbar h1 { margin: 0; font-size: 1.5rem; }
.inline-form { display: flex; gap: 8px; flex-wrap: wrap; }
input, button { padding: 9px 12px; border-radius: 10px; font: inherit; }
input { border: 1px solid var(--line); background: var(--surface); }
button[type="submit"] { border: 0; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
.kpi-card, .card { background: var(--surface); border-radius: var(--radius); padding: 18px; border: 1px solid var(--line); }
.kpi-card small { color: var(--muted); display: block; margin-bottom: 6px; }
.kpi-card strong { font-size: 1.45rem; font-variant-numeric: tabular-nums; }
.card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.card-head h2 { margin: 0; font-size: 1.05rem; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: start; font-size: 0.92rem; }
@media (max-width: 760px) { .layout { grid-template-columns: 1fr; } .main { padding: 16px; } }
`,
      "app.js": `const records = [
  { name: "Contrat Initial", amount: 1500000, status: "Actif" },
  { name: "Extension Portail", amount: 750000, status: "En cours" },
];
const kpiRow = document.getElementById("kpi-row");
const tbody = document.getElementById("records-body");
const form = document.getElementById("record-form");
const filterInput = document.getElementById("filter-input");
const viewTitle = document.getElementById("view-title");

function renderKpis(list) {
  const total = list.reduce((s, r) => s + Number(r.amount || 0), 0);
  const cards = [
    ["Total suivi", total.toLocaleString("fr-FR") + " XOF"],
    ["Dossiers", String(list.length)],
    ["Taux actif", Math.round((list.filter((r) => r.status === "Actif").length / Math.max(1, list.length)) * 100) + "%"],
  ];
  kpiRow.replaceChildren(...cards.map(([label, val]) => {
    const div = document.createElement("article");
    div.className = "kpi-card";
    const sm = document.createElement("small");
    sm.textContent = label;
    const st = document.createElement("strong");
    st.textContent = val;
    div.append(sm, st);
    return div;
  }));
}

function renderTable(query = "") {
  const needle = query.trim().toLowerCase();
  const filtered = needle ? records.filter((r) => r.name.toLowerCase().includes(needle)) : records;
  renderKpis(records);
  tbody.replaceChildren(...filtered.map((item) => {
    const tr = document.createElement("tr");
    for (const val of [item.name, Number(item.amount).toLocaleString("fr-FR") + " XOF", item.status]) {
      const td = document.createElement("td");
      td.textContent = val;
      tr.appendChild(td);
    }
    return tr;
  }));
}

form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const nameEl = document.getElementById("record-name");
  const amtEl = document.getElementById("record-amount");
  if (!nameEl?.value.trim()) return;
  records.unshift({ name: nameEl.value.trim(), amount: Number(amtEl?.value || 0), status: "Actif" });
  nameEl.value = "";
  if (amtEl) amtEl.value = "";
  renderTable(filterInput?.value || "");
});

filterInput?.addEventListener("input", () => renderTable(filterInput.value));
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (viewTitle) viewTitle.textContent = btn.textContent || "Vue d'ensemble";
  });
});
renderTable();
`,
      "package.json": JSON.stringify({
        name: slug,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { test: "node --test test/app.test.mjs" },
      }, null, 2),
      "test/app.test.mjs": `import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("SaaS dashboard has HTML, CSS and JS modules", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /kpi-row/);
  assert.ok(fs.existsSync("styles.css"));
  assert.ok(fs.existsSync("app.js"));
});
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      writeWorkspaceFile(input.dataDir, input.project, rel, content);
      written.push(rel);
    }
  } else if (input.template === "ecommerce-storefront") {
    const files: Record<string, string> = {
      "index.html": `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle} — Boutique</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <header class="header">
    <strong>${safeTitle}</strong>
    <div class="cart-pill" aria-live="polite">Panier : <span id="cart-count">0</span> · <span id="cart-total">0 XOF</span></div>
  </header>
  <main class="container">
    <section class="hero">
      <h1>Collection & Commandes en ligne</h1>
      <p>Catalogue clair, panier temps réel et prise de commande rapide sur mobile et ordinateur.</p>
    </section>
    <section id="product-grid" class="grid" aria-label="Catalogue produits"></section>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`,
      "styles.css": `:root {
  --bg: #fafaf9;
  --card: #ffffff;
  --ink: #1c1917;
  --muted: #57534e;
  --primary: #111827;
  --line: #e7e5e4;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--ink); }
.header { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: 0; }
.cart-pill { padding: 8px 14px; border-radius: 999px; background: #f5f5f4; font-weight: 600; font-size: 0.9rem; font-variant-numeric: tabular-nums; }
.container { max-width: 1020px; margin: 0 auto; padding: 28px 20px; display: grid; gap: 24px; }
.hero { padding: 28px; border-radius: 16px; background: var(--primary); color: #fff; }
.hero h1 { margin: 0 0 8px; font-size: 1.75rem; }
.hero p { margin: 0; opacity: 0.85; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.product { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px; display: grid; gap: 10px; }
.product h2 { margin: 0; font-size: 1.05rem; }
.product p { margin: 0; color: var(--muted); font-size: 0.9rem; }
.price { font-weight: 700; font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.btn { border: 0; border-radius: 999px; padding: 10px 14px; background: var(--primary); color: #fff; font-weight: 600; cursor: pointer; }
@media (max-width: 600px) { .header { flex-direction: column; gap: 8px; align-items: flex-start; } }
`,
      "app.js": `const products = [
  { id: "p1", name: "Pack Essentiel", desc: "Solution clé en main prête à l'emploi.", price: 45000 },
  { id: "p2", name: "Pack Pro", desc: "Fonctionnalités avancées et support prioritaire.", price: 95000 },
  { id: "p3", name: "Extension Mobile", desc: "Accès mobile rapide et notifications.", price: 65000 },
];
let count = 0;
let total = 0;
const grid = document.getElementById("product-grid");
const countEl = document.getElementById("cart-count");
const totalEl = document.getElementById("cart-total");

function updateCart() {
  if (countEl) countEl.textContent = String(count);
  if (totalEl) totalEl.textContent = total.toLocaleString("fr-FR") + " XOF";
}

grid?.replaceChildren(...products.map((p) => {
  const card = document.createElement("article");
  card.className = "product";
  const h2 = document.createElement("h2");
  h2.textContent = p.name;
  const desc = document.createElement("p");
  desc.textContent = p.desc;
  const price = document.createElement("div");
  price.className = "price";
  price.textContent = p.price.toLocaleString("fr-FR") + " XOF";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn";
  btn.textContent = "Ajouter au panier";
  btn.addEventListener("click", () => {
    count += 1;
    total += p.price;
    updateCart();
  });
  card.append(h2, desc, price, btn);
  return card;
}));
updateCart();
`,
      "package.json": JSON.stringify({
        name: slug,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { test: "node --test test/store.test.mjs" },
      }, null, 2),
      "test/store.test.mjs": `import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("ecommerce storefront assets exist", () => {
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /product-grid/);
  assert.ok(fs.existsSync("styles.css"));
  assert.ok(fs.existsSync("app.js"));
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
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { cwd, timeout: 90_000, maxBuffer: 1_048_576, shell: false, windowsHide: true, encoding: "utf8", ...(signal ? { signal } : {}) },
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
  signal?: AbortSignal;
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

  const res = await execStudioCmd(spec.command, spec.args, workspaceDir, input.signal);
  const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n") || `exitCode=${res.exitCode}`;
  return { action: input.action, exitCode: res.exitCode, output: output.slice(0, 8000) };
}

async function ensureStudioGitRepo(workspaceDir: string): Promise<void> {
  if (!fs.existsSync(path.join(workspaceDir, ".git"))) {
    const init = await execStudioCmd("git", ["init"], workspaceDir);
    if (init.exitCode !== 0) {
      throw new AgencyError("CONFLICT", `git init failed: ${init.stderr}`);
    }
  }
  await execStudioCmd("git", ["config", "user.email", "studio@anymodelbot.local"], workspaceDir);
  await execStudioCmd("git", ["config", "user.name", "AnyModelBot Studio"], workspaceDir);
}

export async function createStudioSnapshot(
  dataDir: string,
  project: Project,
  label = "checkpoint",
): Promise<{ commitHash: string; created: boolean; message: string }> {
  const { workspaceDir } = resolveSafeWorkspacePath(dataDir, project.workspacePath);
  fs.mkdirSync(workspaceDir, { recursive: true });
  await ensureStudioGitRepo(workspaceDir);
  await execStudioCmd("git", ["add", "-A"], workspaceDir);
  const statusRes = await execStudioCmd("git", ["status", "--porcelain"], workspaceDir);
  const headRes = await execStudioCmd("git", ["rev-parse", "--verify", "HEAD"], workspaceDir);
  const hasHead = headRes.exitCode === 0;
  const cleanLabel = label.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "checkpoint";
  const commitMessage = `studio: ${cleanLabel}`;

  if (!statusRes.stdout.trim() && hasHead) {
    return { commitHash: headRes.stdout.trim(), created: false, message: commitMessage };
  }
  const commitArgs = statusRes.stdout.trim()
    ? ["commit", "-m", commitMessage]
    : ["commit", "--allow-empty", "-m", commitMessage];
  const commitRes = await execStudioCmd("git", commitArgs, workspaceDir);
  if (commitRes.exitCode !== 0) {
    throw new AgencyError("CONFLICT", `Snapshot commit failed: ${commitRes.stderr || commitRes.stdout}`);
  }
  const newHead = await execStudioCmd("git", ["rev-parse", "--verify", "HEAD"], workspaceDir);
  return { commitHash: newHead.stdout.trim(), created: true, message: commitMessage };
}

export async function listStudioSnapshots(
  dataDir: string,
  project: Project,
  limit = 15,
): Promise<StudioSnapshotEntry[]> {
  const { workspaceDir } = resolveSafeWorkspacePath(dataDir, project.workspacePath);
  if (!fs.existsSync(path.join(workspaceDir, ".git"))) return [];
  const safeLimit = Math.max(1, Math.min(50, Math.round(limit)));
  const res = await execStudioCmd("git", ["log", "-n", String(safeLimit), "--pretty=format:%H|%ct|%s"], workspaceDir);
  if (res.exitCode !== 0 || !res.stdout.trim()) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [commitHash = "", sec = "0", ...rest] = line.split("|");
      return {
        commitHash,
        timestamp: (Number(sec) || 0) * 1000,
        message: rest.join("|") || "studio snapshot",
      };
    })
    .filter((entry) => /^[0-9a-f]{7,40}$/i.test(entry.commitHash));
}


export interface StudioDiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "type-changed";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface StudioDiffResult {
  baseCommit: string;
  headCommit: string;
  files: StudioDiffFile[];
  totalFiles: number;
  truncated: boolean;
  diff?: { path: string; status: StudioDiffFile["status"]; additions: number; deletions: number; binary: boolean; patch: string; patchTruncated: boolean };
}

const MAX_STUDIO_DIFF_FILES = 120;
const MAX_STUDIO_DIFF_CHARS = 120_000;

/** Compare two verified snapshots and optionally return one bounded, workspace-scoped patch. */
export async function getStudioDiff(
  dataDir: string,
  project: Project,
  baseCommit: string,
  headCommit: string,
  selectedFile?: string,
): Promise<StudioDiffResult> {
  const { workspaceDir } = resolveSafeWorkspacePath(dataDir, project.workspacePath);
  if (!fs.existsSync(path.join(workspaceDir, ".git"))) {
    throw new AgencyError("CONFLICT", "No studio snapshot history exists yet for this project");
  }
  const resolveCommit = async (raw: string): Promise<string> => {
    const value = String(raw || "").trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(value)) {
      throw new AgencyError("VALIDATION_ERROR", "Invalid snapshot commit hash");
    }
    const result = await execStudioCmd("git", ["rev-parse", "--verify", value + "^{commit}"], workspaceDir);
    if (result.exitCode !== 0) throw new AgencyError("NOT_FOUND", "Studio snapshot commit not found");
    return result.stdout.trim();
  };
  const [base, head] = await Promise.all([resolveCommit(baseCommit), resolveCommit(headCommit)]);
  if (base === head) return { baseCommit: base, headCommit: head, files: [], totalFiles: 0, truncated: false };
  const nameResult = await execStudioCmd(
    "git", ["diff", "--no-ext-diff", "--no-color", "--no-renames", "--name-status", "-z", base, head, "--"], workspaceDir,
  );
  if (nameResult.exitCode !== 0) throw new AgencyError("CONFLICT", "Unable to compare Studio snapshots: " + nameResult.stderr.slice(0, 300));
  const statusMap = new Map<string, StudioDiffFile["status"]>();
  const nameTokens = nameResult.stdout.split("\0").filter(Boolean);
  for (let i = 0; i + 1 < nameTokens.length; i += 2) {
    const code = nameTokens[i];
    const relPath = nameTokens[i + 1].replaceAll("\\", "/");
    if (!relPath || relPath.split("/").some((part) => part === ".git" || part === "..")) continue;
    const status: StudioDiffFile["status"] = code === "A" ? "added" : code === "D" ? "deleted" : code === "T" ? "type-changed" : "modified";
    statusMap.set(relPath, status);
  }
  const numstatResult = await execStudioCmd(
    "git", ["diff", "--no-ext-diff", "--no-color", "--no-renames", "--numstat", "-z", base, head, "--"], workspaceDir,
  );
  if (numstatResult.exitCode !== 0) throw new AgencyError("CONFLICT", "Unable to read Studio diff statistics");
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const record of numstatResult.stdout.split("\0").filter(Boolean)) {
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const addText = record.slice(0, first);
    const deleteText = record.slice(first + 1, second);
    const relPath = record.slice(second + 1).replaceAll("\\", "/");
    stats.set(relPath, {
      additions: /^\d+$/.test(addText) ? Number(addText) : 0,
      deletions: /^\d+$/.test(deleteText) ? Number(deleteText) : 0,
      binary: addText === "-" || deleteText === "-",
    });
  }
  const allFiles = [...statusMap.entries()].map(([relPath, status]) => {
    const stat = stats.get(relPath) || { additions: 0, deletions: 0, binary: false };
    return { path: relPath, status, ...stat };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const files = allFiles.slice(0, MAX_STUDIO_DIFF_FILES);
  const result: StudioDiffResult = { baseCommit: base, headCommit: head, files, totalFiles: allFiles.length, truncated: allFiles.length > files.length };
  if (selectedFile !== undefined) {
    const safePath = resolveWorkspaceFile(dataDir, project.workspacePath, selectedFile).relPath;
    const metadata = allFiles.find((entry) => entry.path === safePath);
    if (!metadata) throw new AgencyError("NOT_FOUND", "File is not part of this snapshot diff");
    const patchResult = await execStudioCmd(
      "git", ["diff", "--no-ext-diff", "--no-color", "--no-renames", "--unified=4", base, head, "--", safePath], workspaceDir,
    );
    if (patchResult.exitCode !== 0) throw new AgencyError("CONFLICT", "Unable to read file diff: " + patchResult.stderr.slice(0, 300));
    const patch = patchResult.stdout.slice(0, MAX_STUDIO_DIFF_CHARS);
    result.diff = { ...metadata, patch, patchTruncated: patchResult.stdout.length > patch.length };
  }
  return result;
}
export async function rollbackStudioSnapshot(
  dataDir: string,
  project: Project,
  commitHash?: string,
): Promise<{ restoredCommit: string; files: StudioFileEntry[] }> {
  const { workspaceDir } = resolveSafeWorkspacePath(dataDir, project.workspacePath);
  if (!fs.existsSync(path.join(workspaceDir, ".git"))) {
    throw new AgencyError("CONFLICT", "No studio snapshot history exists yet for this project");
  }
  let targetRef = (commitHash ?? "").trim();
  if (targetRef) {
    if (!/^[0-9a-f]{7,40}$/i.test(targetRef)) {
      throw new AgencyError("VALIDATION_ERROR", "Invalid commit hash format");
    }
  } else {
    const statusRes = await execStudioCmd("git", ["status", "--porcelain"], workspaceDir);
    if (statusRes.stdout.trim()) {
      targetRef = "HEAD";
    } else {
      const parentRes = await execStudioCmd("git", ["rev-parse", "--verify", "HEAD~1"], workspaceDir);
      if (parentRes.exitCode === 0 && parentRes.stdout.trim()) {
        targetRef = parentRes.stdout.trim();
      } else {
        targetRef = "HEAD";
      }
    }
  }
  const verify = await execStudioCmd("git", ["rev-parse", "--verify", targetRef], workspaceDir);
  if (verify.exitCode !== 0) {
    throw new AgencyError("NOT_FOUND", `Snapshot commit not found: ${targetRef}`);
  }
  const resolved = verify.stdout.trim();
  const reset = await execStudioCmd("git", ["reset", "--hard", resolved], workspaceDir);
  if (reset.exitCode !== 0) {
    throw new AgencyError("CONFLICT", `Rollback failed: ${reset.stderr || reset.stdout}`);
  }
  await execStudioCmd("git", ["clean", "-fd"], workspaceDir);
  return {
    restoredCommit: resolved,
    files: listWorkspaceFiles(dataDir, project),
  };
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
    for (const alt of ["public/index.html", "dist/index.html"]) {
      const fallback = path.join(workspaceDir, ...alt.split("/"));
      if (fs.existsSync(fallback) && fs.statSync(fallback).isFile()) {
        targetAbs = fallback;
        targetRel = alt;
        break;
      }
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
  template?: StudioTemplateId | "";
  files?: ReadonlyArray<{
    name: string;
    mimeType?: string;
    textContent?: string;
    base64Content?: string;
  }>;
}): Promise<{ writtenFiles: string[]; briefUpdated: boolean }> {
  const validTemplates = new Set<StudioTemplateId>([
    "vite-react-tailwind",
    "vitrine-html",
    "webapp-node-preact",
    "api-node-ts",
    "saas-dashboard-app",
    "ecommerce-storefront",
  ]);
  const writtenFiles: string[] = [];

  if (input.template && validTemplates.has(input.template)) {
    const scaf = scaffoldProjectTemplate({
      dataDir: input.dataDir,
      project: input.project,
      contract: input.contract,
      lots: input.lots ?? [],
      template: input.template,
    });
    writtenFiles.push(...scaf.files);
  } else {
    initProjectWorkspace({
      dataDir: input.dataDir,
      project: input.project,
      contract: input.contract,
      lots: input.lots ?? [],
    });
  }

  const cleanSpecs = (input.cahierDesCharges ?? "").trim();
  if (cleanSpecs) {
    const savedSpec = writeWorkspaceFile(
      input.dataDir,
      input.project,
      "docs/CAHIER-DES-CHARGES.md",
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
    const relTarget = `docs/sources/${base}`;
    if (typeof file.textContent === "string" && file.textContent.length > 0) {
      const saved = writeWorkspaceFile(input.dataDir, input.project, relTarget, file.textContent.slice(0, MAX_READ_BYTES));
      writtenFiles.push(saved.path);
      ingestedSources.push(saved.path);
      continue;
    }
    if (typeof file.base64Content === "string" && file.base64Content.trim()) {
      const buf = Buffer.from(file.base64Content.trim(), "base64");
      if (buf.length > 2 * 1024 * 1024) {
        throw new AgencyError("VALIDATION_ERROR", `Uploaded file "${base}" exceeds 2 MB limit`);
      }
      const { absPath, relPath } = resolveWorkspaceFile(input.dataDir, input.project.workspacePath, relTarget);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, buf);
      writtenFiles.push(relPath);
      ingestedSources.push(relPath);
      const isPdf = (file.mimeType || "").toLowerCase().includes("pdf") || base.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        const extracted = extractReadablePdfText(buf);
        if (extracted) {
          const txtRel = `${relTarget}.txt`;
          writeWorkspaceFile(input.dataDir, input.project, txtRel, extracted);
          writtenFiles.push(txtRel);
        }
      }
    }
  }

  let briefUpdated = false;
  if (cleanSpecs || ingestedSources.length > 0) {
    const currentBrief = readWorkspaceFile(input.dataDir, input.project, "BRIEF.md").content;
    const sectionLines = [
      "",
      "## Cahier des charges & Documents sources",
      ...(cleanSpecs ? ["- `docs/CAHIER-DES-CHARGES.md`"] : []),
      ...ingestedSources.map((s) => `- \`${s}\``),
    ];
    writeWorkspaceFile(input.dataDir, input.project, "BRIEF.md", `${currentBrief.trimEnd()}\n${sectionLines.join("\n")}\n`);
    briefUpdated = true;
  }

  await createStudioSnapshot(input.dataDir, input.project, "initial-cahier-des-charges").catch(() => undefined);
  return { writtenFiles: [...new Set(writtenFiles)], briefUpdated };
}

export async function installStudioDependencies(
  dataDir: string,
  project: Project,
  packages: readonly string[],
  signal?: AbortSignal,
): Promise<{ packages: string[]; exitCode: number; output: string }> {
  const { workspaceDir } = resolveSafeWorkspacePath(dataDir, project.workspacePath);
  if (!fs.existsSync(workspaceDir)) {
    throw new AgencyError("CONFLICT", "Project workspace is not initialized yet");
  }
  const clean = packages
    .map((p) => p.trim())
    .filter((p) => /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9.^~>=<_-]+)?$/i.test(p))
    .slice(0, 12);
  if (clean.length === 0) {
    throw new AgencyError("VALIDATION_ERROR", "At least one valid npm package name is required");
  }
  let command = "npm";
  let args = ["install", "--no-audit", "--no-fund", ...clean];
  if (process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCli)) {
      command = process.execPath;
      args = [npmCli, ...args];
    }
  }
  const res = await execStudioCmd(command, args, workspaceDir, signal);
  const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n") || `exitCode=${res.exitCode}`;
  return { packages: clean, exitCode: res.exitCode, output: output.slice(0, 8000) };
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
  onStep?: (step: StudioAgentStep) => void;
  signal?: AbortSignal;
}): Promise<{
  summary: string;
  ok: boolean;
  cancelled?: boolean;
  modifiedFiles: string[];
  steps: StudioAgentStep[];
  model: string;
  snapshotBefore?: string;
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
  const snapshotBefore = await createStudioSnapshot(input.dataDir, input.project, "avant-agent-ia")
    .then((s) => s.commitHash)
    .catch(() => undefined);
  const maxSteps = Math.max(1, Math.min(20, Math.round(input.maxSteps ?? 8)));
  const steps: StudioAgentStep[] = [];
  const modified = new Set<string>();

  const systemPrompt = [
    `You are an autonomous software developer working strictly inside the confined workspace of project "${input.project.title}".`,
    `Target stack: ${input.project.targetStack.join(", ") || "web / node"}.`,
    input.lot ? `Active lot: #${input.lot.lotOrder} ${input.lot.title} — ${input.lot.description}` : "",
    input.agentInstructions?.trim() ? `Configured developer instructions: ${input.agentInstructions.trim()}` : "",
    input.agentRules?.length ? `Configured agency rules:\n${input.agentRules.map((r) => `- ${r}`).join("\n")}` : "",
    STUDIO_XML_PROTOCOL_PROMPT,
    `Prefer search/read then patch or write; batch related <studio-write> tags in a single turn; run <studio-run action="npm_test" /> or npm_build when package.json scripts exist; finish cleanly with <studio-done>...</studio-done>.`,
  ].filter(Boolean).join("\n\n");

  const history: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Task: ${cleanInstruction}\nCurrent files: ${listWorkspaceFiles(input.dataDir, input.project).map((f) => f.path).join(", ") || "(empty)"}`,
    },
  ];

  let finalSummary = "";
  let consecutiveNoAction = 0;

  const cancelledResult = () => ({
    summary: "Agent interrompu à la demande ; les modifications déjà réalisées sont conservées.",
    ok: false,
    cancelled: true,
    modifiedFiles: [...modified],
    steps,
    model,
    ...(snapshotBefore ? { snapshotBefore } : {}),
  });

  for (let turn = 1; turn <= maxSteps; turn++) {
    if (input.signal?.aborted) return cancelledResult();
    let reply: string;
    try {
      reply = await input.modelClient.streamChat({ model, messages: history, signal: input.signal }, () => {});
    } catch (error) {
      if (!input.signal?.aborted) throw error;
      return cancelledResult();
    }
    if (input.signal?.aborted) return cancelledResult();
    history.push({ role: "assistant", content: reply });

    const parsed = parseStudioActions(reply);
    if (parsed.actions.length === 0) {
      consecutiveNoAction += 1;
      if (modified.size > 0 || consecutiveNoAction >= 2 || (steps.length > 0 && parsed.prose.length > 40)) {
        finalSummary = parsed.prose.slice(0, 1200) || `Agent exécuté (${modified.size} fichier(s) modifié(s)).`;
        const finishStep: StudioAgentStep = {
          step: steps.length + 1,
          tool: "finish",
          target: "",
          ok: true,
          summary: finalSummary.slice(0, 240),
        };
        steps.push(finishStep);
        input.onStep?.(finishStep);
        break;
      }
      const noActionStep: StudioAgentStep = {
        step: steps.length + 1,
        tool: "no_action",
        target: "",
        ok: false,
        summary: "Réponse sans balise d'action — relance guidée",
      };
      steps.push(noActionStep);
      input.onStep?.(noActionStep);
      history.push({
        role: "user",
        content: "Émets tes actions avec <studio-write path=\"...\">...</studio-write> (ou <studio-read path=\"...\" />) et termine par <studio-done>résumé</studio-done>.",
      });
      continue;
    }

    consecutiveNoAction = 0;
    const observations: string[] = [];
    let finished = false;

    for (const action of parsed.actions) {
      if (input.signal?.aborted) return cancelledResult();
      const stepNum = steps.length + 1;
      if (action.tool === "finish") {
        finalSummary = action.summary || "Completed workspace updates.";
        const finishStep: StudioAgentStep = {
          step: stepNum,
          tool: "finish",
          target: "",
          ok: true,
          summary: finalSummary.slice(0, 240),
        };
        steps.push(finishStep);
        input.onStep?.(finishStep);
        finished = true;
        break;
      }

      let observation = "";
      let ok = true;
      let target = "";
      try {
        observation = await executeParsedAction({
          dataDir: input.dataDir,
          project: input.project,
          action,
          modified,
          onTarget: (t) => { target = t; },
          onOk: (flag) => { ok = flag; },
          signal: input.signal,
        });
      } catch (error) {
        ok = false;
        observation = (error as Error).message || "Tool execution failed";
      }

      const stepEntry: StudioAgentStep = { step: stepNum, tool: action.tool, target, ok, summary: observation.slice(0, 240) };
      steps.push(stepEntry);
      input.onStep?.(stepEntry);
      if (input.signal?.aborted) return cancelledResult();
      observations.push(`[${action.tool}${target ? ` ${target}` : ""}] ${observation}`);
    }

    if (finished) break;
    history.push({
      role: "user",
      content: `Résultats des actions :\n${observations.join("\n\n")}\nContinue ou termine avec <studio-done>...</studio-done>.`,
    });
  }

  if (!finalSummary) {
    finalSummary = `Agent exécuté (${steps.length} étape(s), ${modified.size} fichier(s) modifié(s)).`;
  }
  const criticalTools = new Set(["write_file", "patch_file", "delete_file", "add_dependency", "run_check"]);
  const criticalFailure = steps.some((step) => !step.ok && criticalTools.has(step.tool));
  const explicitlyFinished = steps.some((step) => step.tool === "finish" && step.ok);
  return {
    summary: finalSummary,
    ok: explicitlyFinished && !criticalFailure,
    modifiedFiles: [...modified],
    steps,
    model,
    ...(snapshotBefore ? { snapshotBefore } : {}),
  };
}

async function executeParsedAction(ctx: {
  dataDir: string;
  project: Project;
  action: Exclude<StudioParsedAction, { tool: "finish" }>;
  modified: Set<string>;
  onTarget: (target: string) => void;
  onOk: (ok: boolean) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { action } = ctx;
  switch (action.tool) {
    case "list_files": {
      const list = listWorkspaceFiles(ctx.dataDir, ctx.project);
      return JSON.stringify(list.map((f) => ({ path: f.path, size: f.size })));
    }
    case "search_files": {
      ctx.onTarget(action.query);
      const hits = searchWorkspaceFiles(ctx.dataDir, ctx.project, action.query);
      return hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n") : "(no matches)";
    }
    case "read_file": {
      ctx.onTarget(action.path);
      const file = readWorkspaceFile(ctx.dataDir, ctx.project, action.path);
      return file.content.slice(0, 8000);
    }
    case "patch_file": {
      ctx.onTarget(action.path);
      const patched = patchWorkspaceFile(ctx.dataDir, ctx.project, action.path, action.search, action.replace);
      ctx.modified.add(patched.path);
      return `Patched ${patched.path} (${patched.size} bytes)`;
    }
    case "write_file": {
      ctx.onTarget(action.path);
      const saved = writeWorkspaceFile(ctx.dataDir, ctx.project, action.path, action.content);
      ctx.modified.add(saved.path);
      return `Wrote ${saved.path} (${saved.size} bytes)`;
    }
    case "delete_file": {
      ctx.onTarget(action.path);
      const removed = deleteWorkspaceFile(ctx.dataDir, ctx.project, action.path);
      ctx.modified.add(removed.deleted);
      return `Deleted ${removed.deleted}`;
    }
    case "add_dependency": {
      ctx.onTarget(action.packages.join(", "));
      const depRes = await installStudioDependencies(ctx.dataDir, ctx.project, action.packages, ctx.signal);
      ctx.onOk(depRes.exitCode === 0);
      if (depRes.exitCode === 0) ctx.modified.add("package.json");
      return `npm install (${depRes.packages.join(", ")}) exitCode=${depRes.exitCode}\n${depRes.output.slice(0, 3000)}`;
    }
    case "run_check": {
      const cmd = (action.action || "npm_test") as StudioCommandAction;
      ctx.onTarget(cmd);
      const result = await runStudioCommand({ dataDir: ctx.dataDir, project: ctx.project, action: cmd, signal: ctx.signal });
      ctx.onOk(result.exitCode === 0);
      return `exitCode=${result.exitCode}\n${result.output.slice(0, 4000)}`;
    }
  }
}
