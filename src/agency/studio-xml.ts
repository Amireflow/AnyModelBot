/**
 * Dyad-inspired XML action parser for AnyModelBot Studio.
 *
 * Replaces fragile single-JSON-object tool responses (which frequently fail
 * with `parse_error` when models emit quotes, JSX, CSS, or multi-file edits)
 * with resilient streaming-safe XML blocks:
 *   <studio-write path="src/App.tsx">...full content...</studio-write>
 *   <studio-patch path="src/App.tsx"><search>...</search><replace>...</replace></studio-patch>
 *   <studio-delete path="old.js" />
 *   <studio-read path="BRIEF.md" />
 *   <studio-search query="keyword" />
 *   <studio-list />
 *   <studio-add-dep packages="lucide-react" />
 *   <studio-run action="npm_build" />
 *   <studio-done>Summary of work</studio-done>
 *
 * Falls back cleanly to legacy JSON tool objects so existing tests and
 * older prompts keep working without breaking.
 */

export type StudioParsedAction =
  | { tool: "list_files" }
  | { tool: "search_files"; query: string }
  | { tool: "glob_files"; pattern: string }
  | { tool: "grep_files"; query: string; path?: string }
  | { tool: "read_file"; path: string; startLine?: number; endLine?: number }
  | { tool: "write_file"; path: string; content: string }
  | { tool: "patch_file"; path: string; search: string; replace: string }
  | { tool: "delete_file"; path: string }
  | { tool: "add_dependency"; packages: string[] }
  | { tool: "run_check"; action: string }
  | { tool: "diagnostics" }
  | { tool: "run_command"; command: string }
  | { tool: "finish"; summary: string };

export interface ParsedStudioReply {
  actions: StudioParsedAction[];
  prose: string;
  format: "xml" | "json" | "prose";
}

function getAttr(attrText: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>/]+))`, "i");
  const m = attrText.match(re);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

function stripWrapperNewlines(s: string): string {
  return s.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

const VALID_NPM_PKG_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9.^~>=<_-]+)?$/i;

function parsePackageList(raw: string): string[] {
  const beforeShellOp = raw.split(/[;|&$`<>()]/)[0] ?? "";
  return beforeShellOp
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => VALID_NPM_PKG_RE.test(p))
    .slice(0, 12);
}

const XML_TAG_PATTERN =
  /<studio-(write|patch|delete|read|search|glob|grep|list|add-dep|run|diagnostics|cmd|done)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/studio-\1>)/gi;

function getIntAttr(attrText: string, name: string): number | undefined {
  const raw = getAttr(attrText, name);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function hasTruncatedStudioTag(reply: string): string | null {
  const text = String(reply ?? "");
  const openMatches = [...text.matchAll(/<studio-(write|patch|cmd)\b[^>]*>/gi)];
  if (openMatches.length === 0) return null;
  const last = openMatches[openMatches.length - 1];
  const tag = last[1].toLowerCase();
  const tail = text.slice((last.index ?? 0) + last[0].length);
  const closeRe = new RegExp(`</studio-${tag}>`, "i");
  return closeRe.test(tail) ? null : tag;
}

export function parseStudioActions(reply: string): ParsedStudioReply {
  const text = String(reply ?? "");
  const actions: StudioParsedAction[] = [];

  let match: RegExpExecArray | null;
  XML_TAG_PATTERN.lastIndex = 0;

  while ((match = XML_TAG_PATTERN.exec(text)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? "";
    const body = match[3] ?? "";

    switch (tag) {
      case "list":
        actions.push({ tool: "list_files" });
        break;
      case "read": {
        const p = getAttr(attrs, "path") || body.trim();
        const startLine = getIntAttr(attrs, "start") ?? getIntAttr(attrs, "startLine");
        const endLine = getIntAttr(attrs, "end") ?? getIntAttr(attrs, "endLine");
        if (p) actions.push({ tool: "read_file", path: p, ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}) });
        break;
      }
      case "search": {
        const q = getAttr(attrs, "query") || body.trim();
        if (q) actions.push({ tool: "search_files", query: q });
        break;
      }
      case "glob": {
        const pattern = getAttr(attrs, "pattern") || body.trim();
        if (pattern) actions.push({ tool: "glob_files", pattern });
        break;
      }
      case "grep": {
        const query = getAttr(attrs, "query") || body.trim();
        const subPath = getAttr(attrs, "path") || undefined;
        if (query) actions.push({ tool: "grep_files", query, ...(subPath ? { path: subPath } : {}) });
        break;
      }
      case "write": {
        const p = getAttr(attrs, "path");
        if (p) {
          actions.push({ tool: "write_file", path: p, content: stripWrapperNewlines(body) });
        }
        break;
      }
      case "patch": {
        const p = getAttr(attrs, "path");
        const searchMatch = body.match(/<search>([\s\S]*?)<\/search>/i);
        const replaceMatch = body.match(/<replace>([\s\S]*?)<\/replace>/i);
        if (p && searchMatch && replaceMatch) {
          actions.push({
            tool: "patch_file",
            path: p,
            search: stripWrapperNewlines(searchMatch[1]),
            replace: stripWrapperNewlines(replaceMatch[1]),
          });
        }
        break;
      }
      case "delete": {
        const p = getAttr(attrs, "path") || body.trim();
        if (p) actions.push({ tool: "delete_file", path: p });
        break;
      }
      case "add-dep": {
        const raw = getAttr(attrs, "packages") || getAttr(attrs, "package") || body.trim();
        const packages = parsePackageList(raw);
        if (packages.length > 0) actions.push({ tool: "add_dependency", packages });
        break;
      }
      case "run": {
        const action = getAttr(attrs, "action") || body.trim() || "npm_test";
        actions.push({ tool: "run_check", action });
        break;
      }
      case "diagnostics":
        actions.push({ tool: "diagnostics" });
        break;
      case "cmd": {
        const command = getAttr(attrs, "command") || body.trim();
        if (command) actions.push({ tool: "run_command", command });
        break;
      }
      case "done":
        actions.push({ tool: "finish", summary: body.trim() || "Completed workspace updates." });
        break;
    }
  }

  if (actions.length > 0) {
    const prose = text.replace(XML_TAG_PATTERN, "").trim();
    return { actions, prose, format: "xml" };
  }

  const jsonCandidate = extractJsonCandidate(text);
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.tool === "string") {
        const action = normalizeLegacyJsonAction(parsed);
        if (action) {
          return { actions: [action], prose: "", format: "json" };
        }
      }
    } catch {
      /* fall through to prose */
    }
  }

  return { actions: [], prose: text.trim(), format: "prose" };
}

function extractJsonCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced) return fenced[1];
  const brace = raw.match(/\{[\s\S]*\}/);
  return brace ? brace[0] : null;
}

function normalizeLegacyJsonAction(obj: Record<string, unknown>): StudioParsedAction | null {
  const tool = String(obj.tool || "").trim();
  switch (tool) {
    case "list_files":
      return { tool: "list_files" };
    case "search_files":
      return { tool: "search_files", query: String(obj.query ?? "") };
    case "read_file":
      return { tool: "read_file", path: String(obj.path ?? "") };
    case "write_file":
      return { tool: "write_file", path: String(obj.path ?? ""), content: String(obj.content ?? "") };
    case "patch_file":
      return {
        tool: "patch_file",
        path: String(obj.path ?? ""),
        search: String(obj.search ?? ""),
        replace: String(obj.replace ?? ""),
      };
    case "delete_file":
      return { tool: "delete_file", path: String(obj.path ?? "") };
    case "run_check":
      return { tool: "run_check", action: String(obj.action ?? "npm_test") };
    case "finish":
      return { tool: "finish", summary: String(obj.summary ?? "Completed workspace updates.").trim() };
    default:
      return null;
  }
}

export const STUDIO_XML_PROTOCOL_PROMPT = [
  `PROTOCOLE D'ACTIONS XML (STYLE DYAD — TU PEUX ÉMETTRE PLUSIEURS BALISES EN UN SEUL TOUR) :`,
  `- Écrire/créer un fichier complet :`,
  `  <studio-write path="chemin/relatif.ext">`,
  `  ...contenu complet du fichier...`,
  `  </studio-write>`,
  `- Modifier une portion précise d'un fichier existant :`,
  `  <studio-patch path="chemin/relatif.ext"><search>extrait exact</search><replace>nouveau code</replace></studio-patch>`,
  `- Supprimer un fichier : <studio-delete path="chemin/relatif.ext" />`,
  `- Lire un fichier (optionnellement par plage de lignes) : <studio-read path="chemin/relatif.ext" start="1" end="250" />`,
  `- Lister les fichiers : <studio-list />`,
  `- Trouver des fichiers par motif glob : <studio-glob pattern="src/**/*.tsx" />`,
  `- Rechercher texte/regex avec numéros de ligne : <studio-grep query="motif" path="src" />`,
  `- Rechercher simple dans le workspace : <studio-search query="mot-clé" />`,
  `- Installer des packages npm : <studio-add-dep packages="lucide-react" />`,
  `- Vérifier TypeScript (erreurs exactes fichier:ligne) : <studio-diagnostics />`,
  `- Exécuter une vérification : <studio-run action="npm_build" /> (actions: npm_test, npm_typecheck, npm_build, git_status, npm_install)`,
  `- Exécuter une commande dev autorisée : <studio-cmd>npx tsc --noEmit</studio-cmd>`,
  `- Terminer : <studio-done>Résumé factuel et concis des modifications réalisées</studio-done>`,
  `RÈGLES IMPORTANTES :`,
  `- N'enveloppe JAMAIS les balises <studio-*> dans du JSON ni dans des blocs markdown \`\`\`.`,
  `- Émets le code complet sans ellipses ni "// ... reste du code". Pour créer ou modifier plusieurs fichiers cohérents, émets plusieurs <studio-write> / <studio-patch> dans le MÊME message.`,
  `- Avant de terminer (<studio-done>), vérifie toujours avec <studio-diagnostics /> et <studio-run action="npm_build" /> si le projet a un package.json.`,
].join("\n");
