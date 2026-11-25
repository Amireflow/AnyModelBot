import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgencyError } from "./errors.js";
import type { Contract, Project, ProjectLot, QaCategory } from "./types.js";
import { resolveSafeWorkspacePath } from "./workspace-runner.js";

export interface FourAxisQaItem {
  category: QaCategory;
  title: string;
  status: "passed" | "failed";
  evidence: string;
  findings: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "qa", "missions"]);
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|html|css|json)$/i;
const JS_SYNTAX_EXT = /\.(js|mjs|cjs)$/i;

function execCmd(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 1_048_576, shell: false, windowsHide: true, encoding: "utf8" },
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

function npmCmd(subArgs: string[]): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCli)) return { command: process.execPath, args: [npmCli, ...subArgs] };
  }
  return { command: "npm", args: subArgs };
}

function collectFiles(workspaceDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, relBase: string) => {
    if (out.length >= 300) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 300) break;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) walk(path.join(dir, item.name), relBase ? `${relBase}/${item.name}` : item.name);
      } else if (item.isFile()) {
        out.push(relBase ? `${relBase}/${item.name}` : item.name);
      }
    }
  };
  walk(workspaceDir, "");
  return out.sort();
}

const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "OpenAI-style secret key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Private key block", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "eval() usage", regex: /\beval\s*\(/ },
  { label: "new Function() usage", regex: /\bnew\s+Function\s*\(/ },
];

/**
 * Runs an independent 4-axis automated QA audit (technical, security, ui_ux, functional)
 * on the confined project workspace and stores reproducible evidence files under `qa/`.
 */
export async function runFourAxisQaAudit(input: {
  dataDir: string;
  project: Project;
  contract?: Contract;
  lots: readonly ProjectLot[];
}): Promise<{
  items: FourAxisQaItem[];
  reportPath: string;
  summary: string;
}> {
  const { workspaceDir } = resolveSafeWorkspacePath(input.dataDir, input.project.workspacePath);
  if (!fs.existsSync(workspaceDir)) {
    throw new AgencyError("CONFLICT", "Project workspace is not initialized yet. Initialize or scaffold the workspace first.");
  }

  fs.mkdirSync(path.join(workspaceDir, "qa"), { recursive: true });
  const files = collectFiles(workspaceDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportRel = `qa/qa-audit-${stamp}.md`;
  const reportSections: string[] = [`# 4-Axis QA Audit — ${input.project.title}`, `Timestamp: ${new Date().toISOString()}`, ""];

  // 1. Technical axis
  const techIssues: string[] = [];
  const techLogs: string[] = [];
  const hasBrief = fs.existsSync(path.join(workspaceDir, "BRIEF.md"));
  techLogs.push(`BRIEF.md present: ${hasBrief}`);
  if (!hasBrief) techIssues.push("Missing BRIEF.md");

  for (const rel of files.filter((f) => JS_SYNTAX_EXT.test(f)).slice(0, 40)) {
    const abs = path.join(workspaceDir, ...rel.split("/"));
    const res = await execCmd(process.execPath, ["--check", abs], workspaceDir, 10_000);
    if (res.exitCode !== 0) {
      techIssues.push(`Syntax error in ${rel}`);
      techLogs.push(`node --check ${rel} FAILED:\n${res.stderr}`);
    }
  }

  const pkgPath = path.join(workspaceDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      if (typeof scripts.typecheck === "string" && scripts.typecheck.trim()) {
        const spec = npmCmd(["run", "typecheck"]);
        const res = await execCmd(spec.command, spec.args, workspaceDir);
        techLogs.push(`npm run typecheck -> exit ${res.exitCode}\n${res.stdout}\n${res.stderr}`.trim());
        if (res.exitCode !== 0) techIssues.push("npm run typecheck failed");
      }
      if (typeof scripts.test === "string" && scripts.test.trim()) {
        const spec = npmCmd(["test"]);
        const res = await execCmd(spec.command, spec.args, workspaceDir);
        techLogs.push(`npm test -> exit ${res.exitCode}\n${res.stdout}\n${res.stderr}`.trim());
        if (res.exitCode !== 0) techIssues.push("npm test failed");
      }
    } catch {
      techIssues.push("Invalid package.json JSON");
    }
  }

  const techPassed = techIssues.length === 0 && files.length > 0;
  const technicalItem: FourAxisQaItem = {
    category: "technical",
    title: "Audit technique (syntaxe, build, tests)",
    status: techPassed ? "passed" : "failed",
    evidence: `${reportRel} (${files.length} fichiers inspectés)`,
    findings: techIssues.join(" ; "),
  };

  // 2. Security axis
  const secIssues: string[] = [];
  if (files.some((f) => path.basename(f) === ".env")) {
    secIssues.push("Fichier .env détecté dans le workspace");
  }
  for (const rel of files.filter((f) => CODE_EXT.test(f))) {
    const abs = path.join(workspaceDir, ...rel.split("/"));
    let content = "";
    try {
      const stat = fs.statSync(abs);
      if (stat.size > 512 * 1024) continue;
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const pat of SECRET_PATTERNS) {
      if (pat.regex.test(content)) {
        secIssues.push(`${pat.label} dans ${rel}`);
      }
    }
    if (/\binnerHTML\s*=/.test(content) && !/escapeHtml|sanitize/i.test(content)) {
      secIssues.push(`innerHTML non échappé dans ${rel}`);
    }
  }
  const securityItem: FourAxisQaItem = {
    category: "security",
    title: "Audit sécurité (secrets, XSS, code dangereux)",
    status: secIssues.length === 0 ? "passed" : "failed",
    evidence: `${reportRel} (${files.filter((f) => CODE_EXT.test(f)).length} fichiers scannés)`,
    findings: secIssues.join(" ; "),
  };

  // 3. UI/UX axis
  const uiIssues: string[] = [];
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f));
  const cssFiles = files.filter((f) => /\.css$/i.test(f));
  if (htmlFiles.length > 0) {
    for (const rel of htmlFiles.slice(0, 20)) {
      const html = fs.readFileSync(path.join(workspaceDir, ...rel.split("/")), "utf8");
      if (!/<meta\b[^>]*name=["']viewport["']/i.test(html)) uiIssues.push(`${rel}: viewport mobile manquant`);
      if (!/<html\b[^>]*lang=/i.test(html)) uiIssues.push(`${rel}: attribut lang manquant`);
      if (/<img\b(?![^>]*\balt=)[^>]*>/i.test(html)) uiIssues.push(`${rel}: image sans attribut alt`);
    }
    if (cssFiles.length === 0 && !htmlFiles.some((f) => /<style\b/i.test(fs.readFileSync(path.join(workspaceDir, ...f.split("/")), "utf8")))) {
      uiIssues.push("Aucune feuille de style CSS détectée");
    }
  } else {
    const hasReadme = files.some((f) => f.toLowerCase() === "readme.md");
    if (!hasReadme) uiIssues.push("README.md manquant pour un projet sans interface HTML");
  }
  const uiItem: FourAxisQaItem = {
    category: "ui_ux",
    title: "Audit UI/UX (responsive, accessibilité, ergonomie)",
    status: uiIssues.length === 0 ? "passed" : "failed",
    evidence: `${reportRel} (${htmlFiles.length} HTML, ${cssFiles.length} CSS)`,
    findings: uiIssues.join(" ; "),
  };

  // 4. Functional axis
  const funcIssues: string[] = [];
  const deliverableFiles = files.filter((f) => !["BRIEF.md", "README.md"].includes(f));
  if (deliverableFiles.length === 0) {
    funcIssues.push("Aucun livrable applicatif détecté dans le workspace");
  }
  if (input.lots.length === 0) {
    funcIssues.push("Aucun lot projet défini");
  } else {
    const pendingLots = input.lots.filter((l) => l.status !== "verified" && l.status !== "done");
    if (pendingLots.length > 0) {
      funcIssues.push(`${pendingLots.length} lot(s) non encore vérifié(s)`);
    }
  }
  const functionalItem: FourAxisQaItem = {
    category: "functional",
    title: "Audit fonctionnel (livrables, lots, couverture contrat)",
    status: funcIssues.length === 0 ? "passed" : "failed",
    evidence: `${reportRel} (${deliverableFiles.length} fichiers livrables, ${input.lots.length} lots)`,
    findings: funcIssues.join(" ; "),
  };

  const items = [technicalItem, securityItem, uiItem, functionalItem];
  for (const item of items) {
    reportSections.push(`## ${item.category.toUpperCase()} — ${item.status.toUpperCase()}`, `- Titre : ${item.title}`, `- Preuve : ${item.evidence}`, item.findings ? `- Constats : ${item.findings}` : "- Constats : Aucun défaut bloquant", "");
  }
  if (techLogs.length > 0) {
    reportSections.push("## Technical Command Output", "```", techLogs.join("\n\n"), "```");
  }
  fs.writeFileSync(path.join(workspaceDir, reportRel), reportSections.join("\n"), "utf8");

  const passedCount = items.filter((i) => i.status === "passed").length;
  return {
    items,
    reportPath: reportRel,
    summary: `Audit QA 4 axes : ${passedCount}/4 validés (${reportRel})`,
  };
}
