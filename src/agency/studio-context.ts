import fs from "node:fs";
import path from "node:path";
import type { Project } from "./types.js";
import { listWorkspaceFiles, readWorkspaceFile } from "./studio.js";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".html"]);

function priorityScore(relPath: string): number {
  if (relPath === "package.json" || relPath === "tsconfig.json" || relPath === "index.html") return 0;
  if (/^(vite|next|tailwind|postcss)\.config\./i.test(relPath)) return 1;
  if (/^(BRIEF\.md|docs\/CAHIER-DES-CHARGES\.md)$/i.test(relPath)) return 2;
  if (/^src\/(main|index|App|router|routes)\./i.test(relPath)) return 3;
  if (relPath.startsWith("src/")) return 4;
  if (relPath.startsWith("docs/")) return 6;
  return 5;
}

function extractFileSymbols(relPath: string, content: string): string[] {
  const ext = path.extname(relPath).toLowerCase();
  const hints: string[] = [];

  if (ext === ".css") {
    const vars = [...content.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]);
    const uniqueVars = [...new Set(vars)].slice(0, 10);
    if (uniqueVars.length > 0) hints.push(`tokens: ${uniqueVars.join(", ")}`);
    return hints;
  }

  if (ext === ".html") {
    const title = content.match(/<title>([^<]{1,80})<\/title>/i)?.[1]?.trim();
    const scripts = [...content.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 4);
    if (title) hints.push(`title: "${title}"`);
    if (scripts.length > 0) hints.push(`scripts: ${scripts.join(", ")}`);
    return hints;
  }

  const exportsList: string[] = [];
  for (const m of content.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/gm)) {
    exportsList.push(m[1]);
    if (exportsList.length >= 10) break;
  }
  if (/^\s*export\s+default\b/m.test(content) && !exportsList.includes("default")) {
    exportsList.unshift("default");
  }
  if (exportsList.length > 0) {
    hints.push(`exports: ${exportsList.join(", ")}`);
  }

  const routes = [...content.matchAll(/(?:path\s*[:=]\s*["']([^"']+)["'])/g)]
    .map((m) => m[1])
    .filter((r) => r.startsWith("/"));
  if (routes.length > 0) {
    hints.push(`routes: ${[...new Set(routes)].slice(0, 8).join(", ")}`);
  }

  return hints;
}

export function buildWorkspaceRepoMap(dataDir: string, project: Project, maxChars = 7500): string {
  const files = listWorkspaceFiles(dataDir, project);
  if (files.length === 0) return "(workspace vide)";

  const sorted = [...files].sort((a, b) => {
    const sa = priorityScore(a.path);
    const sb = priorityScore(b.path);
    if (sa !== sb) return sa - sb;
    return a.path.localeCompare(b.path);
  });

  const sections: string[] = [];
  const pkgEntry = sorted.find((f) => f.path === "package.json");
  if (pkgEntry) {
    try {
      const pkg = JSON.parse(readWorkspaceFile(dataDir, project, "package.json").content) as {
        name?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = Object.keys(pkg.scripts ?? {});
      const deps = Object.keys(pkg.dependencies ?? {});
      const devDeps = Object.keys(pkg.devDependencies ?? {});
      sections.push(
        [
          `package.json (${pkg.name || "app"}):`,
          scripts.length ? `  scripts: ${scripts.join(", ")}` : "",
          deps.length ? `  deps: ${deps.join(", ")}` : "",
          devDeps.length ? `  devDeps: ${devDeps.slice(0, 14).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch {
      /* ignore malformed package.json */
    }
  }

  const symbolLines: string[] = [];
  for (const entry of sorted) {
    if (symbolLines.length >= 65) break;
    const ext = path.extname(entry.path).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext) && !entry.path.startsWith("docs/") && entry.path !== "BRIEF.md") {
      symbolLines.push(`- ${entry.path} (${entry.size} B)`);
      continue;
    }
    if (entry.path.startsWith("docs/") || entry.path === "BRIEF.md") {
      symbolLines.push(`- ${entry.path} (${entry.size} B, doc)`);
      continue;
    }
    try {
      const raw = readWorkspaceFile(dataDir, project, entry.path).content;
      const lineCount = raw ? raw.split(/\r?\n/).length : 0;
      const hints = extractFileSymbols(entry.path, raw);
      symbolLines.push(`- ${entry.path} (${lineCount} L)${hints.length ? ` — ${hints.join(" | ")}` : ""}`);
    } catch {
      symbolLines.push(`- ${entry.path} (${entry.size} B)`);
    }
  }

  if (files.length > symbolLines.length) {
    symbolLines.push(`- ... (${files.length - symbolLines.length} autre(s) fichier(s))`);
  }

  sections.push(`Carte des fichiers (${files.length} au total) :\n${symbolLines.join("\n")}`);
  const out = sections.join("\n\n");
  return out.length <= maxChars ? out : `${out.slice(0, maxChars)}\n... [carte tronquée]`;
}

export type StudioChatMsg = { role: "system" | "user" | "assistant"; content: string };

export function compactAgentHistory(messages: StudioChatMsg[], maxTotalChars = 48_000): StudioChatMsg[] {
  const totalChars = messages.reduce((acc, m) => acc + m.content.length, 0);
  if (totalChars <= maxTotalChars || messages.length <= 8) {
    return messages.map((m) => ({ ...m }));
  }

  const keepTailCount = 6;
  const splitIdx = Math.max(2, messages.length - keepTailCount);
  const out: StudioChatMsg[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (i < 2 || i >= splitIdx) {
      out.push({ ...msg });
      continue;
    }
    if (msg.role === "assistant") {
      const compacted = msg.content.replace(
        /<studio-write\b([^>]*)>([\s\S]*?)<\/studio-write>/gi,
        (_full, attrs: string, body: string) =>
          body.length > 260 ? `<studio-write${attrs}>[contenu écrit — ${body.length} car.]</studio-write>` : _full,
      );
      out.push({
        role: "assistant",
        content: compacted.length > 1400 ? `${compacted.slice(0, 1200)}\n... [réponse précédente compactée]` : compacted,
      });
      continue;
    }
    const hasError = /exitCode=[1-9]|error TS|Error:|FAILED|not found/i.test(msg.content);
    const limit = hasError ? 1400 : 420;
    out.push({
      role: msg.role,
      content:
        msg.content.length > limit
          ? `${msg.content.slice(0, limit)}\n... [observation compactée, ${msg.content.length} car.]`
          : msg.content,
    });
  }
  return out;
}
