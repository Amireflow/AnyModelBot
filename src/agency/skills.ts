import fs from "node:fs";
import path from "node:path";

export interface AgencySkill {
  slug: string;
  name: string;
  description: string;
  category: string;
  roles: string[];
  body: string;
}

const DEFAULT_SKILLS_DIR = path.resolve(process.cwd(), "agency-skills");
const MAX_SKILL_BLOCK_CHARS = 8000;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) meta[key] = val;
  }
  return { meta, body: match[2].trim() };
}

export function listAgencySkills(rootDir = DEFAULT_SKILLS_DIR): AgencySkill[] {
  if (!fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const skills: AgencySkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const filePath = path.join(rootDir, entry.name, "SKILL.md");
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      skills.push({
        slug: entry.name,
        name: meta.name || entry.name,
        description: meta.description || "",
        category: meta.category || "general",
        roles: (meta.roles || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        body,
      });
    } catch {
      /* skip malformed skill file */
    }
  }
  return skills.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getAgencySkill(slug: string, rootDir = DEFAULT_SKILLS_DIR): AgencySkill | undefined {
  const clean = slug.trim();
  if (!clean || clean.includes("..") || clean.includes("/") || clean.includes("\\")) return undefined;
  return listAgencySkills(rootDir).find((s) => s.slug === clean);
}

/**
 * Progressive skill loading: returns only the full Markdown bodies of the skills
 * explicitly enabled for an agent, keeping LLM prompts focused and bounded.
 */
export function resolveSkillsPromptBlock(
  slugs: readonly string[],
  rootDir = DEFAULT_SKILLS_DIR,
): string {
  if (!slugs.length) return "";
  const all = new Map(listAgencySkills(rootDir).map((s) => [s.slug, s]));
  const sections: string[] = [];
  let total = 0;
  for (const slug of slugs) {
    const skill = all.get(slug);
    if (!skill || !skill.body) continue;
    const block = `### Skill: ${skill.name}\n${skill.body}`;
    if (total + block.length > MAX_SKILL_BLOCK_CHARS) break;
    sections.push(block);
    total += block.length;
  }
  if (!sections.length) return "";
  return `Active Agent Skills:\n${sections.join("\n\n")}`;
}
