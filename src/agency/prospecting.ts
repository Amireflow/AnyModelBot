import dns from "node:dns/promises";
import net from "node:net";
import { createHash } from "node:crypto";
import type { ModelClient } from "../llm/client.js";
import type { SearchService, WebSource } from "../tools/search.js";
import { AgencyError } from "./errors.js";
import type {
  ProspectCandidate,
  ProspectResearchReport,
  ProspectResearchStep,
  QualificationProfile,
  WebsiteAuditResult,
} from "./types.js";
import { normalizedName, websiteUrl } from "./validation.js";

const MAX_AUDIT_BYTES = 512 * 1024;
const AUDIT_TIMEOUT_MS = 8_000;
const DEEP_AUDIT_TIMEOUT_MS = 5_500;
const MAX_REDIRECTS = 3;

const NOISE_HOSTS = new Set([
  "wikipedia.org",
  "youtube.com",
  "youtu.be",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "pinterest.com",
  "reddit.com",
  "amazon.com",
  "amazon.fr",
  "tripadvisor.com",
  "tripadvisor.fr",
  "yelp.com",
  "indeed.com",
  "glassdoor.com",
  "medium.com",
]);

const MOCK_TLDS = [".example", ".test", ".invalid", ".localhost"];

export function isPrivateOrReservedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const norm = ip.toLowerCase();
    if (norm === "::" || norm === "::1") return true;
    if (norm.startsWith("::ffff:")) {
      return isPrivateOrReservedIp(norm.slice(7));
    }
    if (norm.startsWith("fc") || norm.startsWith("fd")) return true; // ULA fc00::/7
    if (norm.startsWith("fe8") || norm.startsWith("fe9") || norm.startsWith("fea") || norm.startsWith("feb")) return true; // link-local fe80::/10
    if (norm.startsWith("ff")) return true; // multicast
    return false;
  }
  return true;
}

export async function assertSafePublicUrl(
  rawUrl: string,
  lookup: (hostname: string) => Promise<Array<{ address: string }>> = (hostname) =>
    dns.lookup(hostname, { all: true }),
): Promise<URL> {
  const normalized = websiteUrl(rawUrl);
  if (!normalized) {
    throw new AgencyError("VALIDATION_ERROR", "A valid http(s) website URL is required");
  }
  const parsed = new URL(normalized);
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new AgencyError("FORBIDDEN", "Private or local hostnames are blocked for website audit");
  }
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new AgencyError("FORBIDDEN", "Private or loopback IP addresses are blocked for website audit");
    }
    return parsed;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host);
  } catch {
    throw new AgencyError("CONFLICT", `Could not resolve hostname: ${host}`);
  }
  if (!records.length || records.some((r) => isPrivateOrReservedIp(r.address))) {
    throw new AgencyError("FORBIDDEN", "Target resolves to a private or reserved network address");
  }
  return parsed;
}

function deriveCompanyNameFromSource(src: WebSource, domain: string): string {
  const rawTitle = (src.title ?? "").trim();
  if (rawTitle) {
    const first = rawTitle.split(/\s+[|\-–—:]\s+/)[0]?.trim();
    if (first && first.length >= 2 && first.length <= 120) return first;
  }
  const bare = domain.replace(/^www\./i, "").split(".")[0] ?? domain;
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractReadablePageExcerpt(html: string, limit = 700): string {
  if (!html) return "";
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const target = bodyMatch ? bodyMatch[1] : html;
  const cleaned = target
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeHtml(cleaned).slice(0, limit);
}

export async function auditWebsiteSafely(input: {
  url: string;
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<{
  audit: WebsiteAuditResult;
  evidenceSummary: string;
  contentHash: string;
  confidence: number;
}> {
  const fetchFn = input.fetchImpl ?? fetch;
  const now = (input.now ?? Date.now)();
  const timeoutMs = Math.max(1_000, Math.min(20_000, Math.round(input.timeoutMs ?? AUDIT_TIMEOUT_MS)));
  let currentUrl = await assertSafePublicUrl(input.url, input.lookup);
  const started = Date.now();
  let res: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetchFn(currentUrl.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": "AnyModelBot-AgencyAudit/1.0",
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      const next = new URL(location, currentUrl);
      currentUrl = await assertSafePublicUrl(next.toString(), input.lookup);
      continue;
    }
    break;
  }

  if (!res) {
    throw new AgencyError("CONFLICT", "Website audit received no response");
  }

  const responseTimeMs = Math.max(1, Date.now() - started);
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  let html = "";
  if (res.body && (!contentType || contentType.includes("text/html") || contentType.includes("application/xhtml"))) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const take = Math.min(value.byteLength, MAX_AUDIT_BYTES - total);
        if (take > 0) {
          chunks.push(value.subarray(0, take));
          total += take;
        }
        if (total >= MAX_AUDIT_BYTES) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
    html = Buffer.concat(chunks).toString("utf8");
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeHtml(titleMatch[1]).slice(0, 200) : "";

  const metaDescMatch =
    /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html) ??
    /<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html);
  const metaDescription = metaDescMatch ? decodeHtml(metaDescMatch[1]).slice(0, 400) : "";

  const generatorMatch =
    /<meta\b[^>]*name=["']generator["'][^>]*content=["']([^"']*)["']/i.exec(html) ??
    /<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']generator["']/i.exec(html);
  const generatorMeta = generatorMatch ? decodeHtml(generatorMatch[1]).slice(0, 120) : "";

  const hasViewportMeta = /<meta\b[^>]*name=["']viewport["']/i.test(html);
  const usesHttps = currentUrl.protocol === "https:";
  const pageExcerpt = extractReadablePageExcerpt(html, 700);

  const emailMatches = new Set<string>();
  for (const m of html.matchAll(/mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)) {
    emailMatches.add(m[1].toLowerCase());
  }
  const phoneMatches = new Set<string>();
  for (const m of html.matchAll(/tel:([+\d][\d\s().-]{6,20})/gi)) {
    phoneMatches.add(m[1].trim());
  }
  const socialLinks = new Set<string>();
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?(?:linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|github\.com)\/[^\s"'<>]+/gi)) {
    socialLinks.add(m[0].slice(0, 200));
  }

  const issues: string[] = [];
  if (res.status >= 400) issues.push(`http_status_${res.status}`);
  if (!usesHttps) issues.push("missing_https");
  if (!title) issues.push("missing_title");
  if (!metaDescription) issues.push("missing_meta_description");
  if (!hasViewportMeta) issues.push("missing_viewport_meta");

  const audit: WebsiteAuditResult = {
    requestedUrl: input.url,
    finalUrl: currentUrl.toString(),
    statusCode: res.status,
    usesHttps,
    responseTimeMs,
    title,
    metaDescription,
    hasViewportMeta,
    generatorMeta,
    detectedEmails: [...emailMatches].slice(0, 10),
    detectedPhones: [...phoneMatches].slice(0, 10),
    socialLinks: [...socialLinks].slice(0, 10),
    issues,
    pageExcerpt,
    observedAt: now,
  };

  const summaryParts = [
    `Audit HTTP ${audit.statusCode} (${audit.responseTimeMs}ms) sur ${audit.finalUrl}.`,
    audit.title ? `Titre observé : "${audit.title}".` : "Balise <title> absente.",
    `HTTPS : ${audit.usesHttps ? "oui" : "non"} ; Viewport mobile : ${audit.hasViewportMeta ? "oui" : "non"} ; Meta description : ${audit.metaDescription ? "présente" : "absente"}.`,
    audit.generatorMeta ? `Générateur détecté : ${audit.generatorMeta}.` : "",
    audit.issues.length ? `Points factuels relevés : ${audit.issues.join(", ")}.` : "Aucun défaut technique basique détecté.",
  ].filter(Boolean);

  const evidenceSummary = summaryParts.join(" ");
  const contentHash = createHash("sha256")
    .update(`website-audit:v1:${audit.finalUrl}:${audit.statusCode}:${audit.issues.join(",")}`)
    .digest("hex");

  return {
    audit,
    evidenceSummary,
    contentHash,
    confidence: res.status < 400 ? 0.9 : 0.6,
  };
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const unfenced = withoutThink.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  for (let start = 0; start < unfenced.length; start++) {
    if (unfenced[start] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < unfenced.length; i++) {
      const ch = unfenced[i];
      if (inStr) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const slice = unfenced.slice(start, i + 1);
          try {
            const parsed = JSON.parse(slice);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

async function resolveProspectingModel(
  modelClient?: Pick<ModelClient, "listModels" | "streamChat">,
  preferredModel?: string,
  defaultModel?: string,
): Promise<string> {
  const preferred = String(preferredModel ?? "").trim();
  const fallback = String(defaultModel ?? "").trim();
  if (!modelClient) return preferred || fallback;
  try {
    const available = await modelClient.listModels();
    if (preferred && available.includes(preferred)) return preferred;
    if (fallback && available.includes(fallback)) return fallback;
    if (available.length > 0) return available[0];
  } catch {
    /* ignore listModels errors cleanly */
  }
  return preferred || fallback;
}

function isNoiseDomain(domain: string, rawQuery: string): boolean {
  const clean = domain.toLowerCase().replace(/^www\./, "");
  const queryLower = rawQuery.toLowerCase();
  for (const host of NOISE_HOSTS) {
    if (clean === host || clean.endsWith(`.${host}`)) {
      if (queryLower.includes(host.split(".")[0])) return false;
      return true;
    }
  }
  return false;
}

function isMockTld(domain: string): boolean {
  const clean = domain.toLowerCase();
  return MOCK_TLDS.some((tld) => clean.endsWith(tld));
}

function buildDeterministicQueries(baseTerms: string, industry?: string, city?: string): string[] {
  const out = [baseTerms];
  const lower = baseTerms.toLowerCase();
  if (!lower.includes("site officiel") && !lower.includes("official")) {
    out.push(`${baseTerms} site officiel`);
  }
  if (!lower.includes("contact")) {
    const focused = [industry?.trim(), city?.trim()].filter(Boolean).join(" ") || baseTerms;
    out.push(`${focused} contact services`.trim());
  }
  return [...new Set(out.map((q) => q.trim()).filter((q) => q.length >= 2))].slice(0, 3);
}

function formatQualificationContext(profile?: QualificationProfile): string {
  if (!profile) return "Aucun profil client idéal spécifique renseigné.";
  const parts: string[] = [];
  if (profile.targetIndustries.length) parts.push(`Secteurs cibles : ${profile.targetIndustries.join(", ")}`);
  if (profile.targetCountries.length) parts.push(`Pays cibles : ${profile.targetCountries.join(", ")}`);
  if (profile.excludedIndustries.length) parts.push(`Secteurs exclus : ${profile.excludedIndustries.join(", ")}`);
  parts.push(`Site web requis : ${profile.requireWebsite ? "oui" : "non"}`);
  return parts.join(" | ");
}

function computeDeterministicScore(
  candidate: ProspectCandidate,
  auditData: WebsiteAuditResult | undefined,
  input: { industry?: string; city?: string; qualificationProfile?: QualificationProfile },
): {
  fitScore: number;
  relevance: "high" | "medium" | "low";
  signals: string[];
  summary: string;
  opportunity: string;
  recommendedAngle: string;
} {
  let score = 46;
  const signals: string[] = [];

  const textBlob = `${candidate.name} ${candidate.domain} ${candidate.snippet} ${auditData?.title ?? ""} ${auditData?.metaDescription ?? ""}`.toLowerCase();
  if (input.city && textBlob.includes(input.city.toLowerCase())) {
    score += 12;
    signals.push(`Présence confirmée à ${input.city}`);
  }
  if (input.industry && textBlob.includes(input.industry.toLowerCase())) {
    score += 10;
    signals.push(`Secteur aligné (${input.industry})`);
  }
  const icp = input.qualificationProfile;
  if (icp?.targetIndustries.some((ind) => textBlob.includes(ind.toLowerCase()))) {
    score += 8;
    signals.push("Correspond à l'ICP cible");
  }
  if (icp?.excludedIndustries.some((ind) => textBlob.includes(ind.toLowerCase()))) {
    score -= 25;
    signals.push("Risque secteur exclu par l'ICP");
  }

  let opportunity = "Audit numérique complet : présence web, SEO local et tunnel de conversion.";
  let recommendedAngle = `Proposer un diagnostic concret du site ${candidate.domain} et une démonstration rapide d'amélioration.`;

  if (auditData) {
    if (auditData.statusCode >= 200 && auditData.statusCode < 400) {
      score += 10;
      signals.push(`HTTP ${auditData.statusCode} (${auditData.responseTimeMs}ms)`);
    } else {
      score -= 12;
      signals.push(`Erreur HTTP ${auditData.statusCode}`);
      opportunity = "Site en erreur technique — refonte urgente et remise en ligne sécurisée.";
    }
    if (auditData.usesHttps) {
      score += 4;
    } else {
      score += 6; // commercial digital agency opportunity
      signals.push("HTTPS absent");
      opportunity = "Site sans HTTPS : opportunité de modernisation, sécurisation SSL et refonte conversion.";
    }
    if (!auditData.hasViewportMeta) {
      score += 6;
      signals.push("Non optimisé mobile");
      opportunity = "Site non responsive mobile : refonte UI mobile-first et capture de leads.";
    }
    if (!auditData.metaDescription) {
      signals.push("Meta description manquante (SEO)");
    }
    if (auditData.detectedEmails.length || auditData.detectedPhones.length) {
      score += 10;
      signals.push("Contacts directs détectés");
    }
    if (auditData.generatorMeta) {
      signals.push(`Tech : ${auditData.generatorMeta}`);
    }
  } else {
    if (candidate.snippet) {
      score += 6;
      signals.push("Signal web pertinent");
    }
  }

  if (candidate.duplicateCompanyId) {
    signals.push("Déjà présent dans le CRM");
  }

  const fitScore = Math.max(10, Math.min(98, Math.round(score)));
  const relevance: "high" | "medium" | "low" = fitScore >= 72 ? "high" : fitScore >= 48 ? "medium" : "low";
  const summary = auditData?.metaDescription || candidate.snippet || candidate.website;

  return {
    fitScore,
    relevance,
    signals: signals.slice(0, 5),
    summary,
    opportunity,
    recommendedAngle,
  };
}

export async function prospectWebCompanies(input: {
  search: Pick<SearchService, "search">;
  query: string;
  industry?: string;
  city?: string;
  countryCode?: string;
  maxResults?: number;
  mode?: "deep" | "quick";
  modelClient?: Pick<ModelClient, "listModels" | "streamChat">;
  preferredModel?: string;
  defaultModel?: string;
  hasLlmEndpoint?: boolean;
  qualificationProfile?: QualificationProfile;
  agentInstructions?: string;
  agentRules?: string[];
  agentSkillsPrompt?: string;
  auditTopSites?: boolean;
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
  findDuplicate?: (normalized: string, website: string) => string | undefined;
}): Promise<{
  query: string;
  backend: string;
  candidates: ProspectCandidate[];
  research: ProspectResearchReport;
}> {
  const startedAt = Date.now();
  const terms = [input.query.trim(), input.industry?.trim(), input.city?.trim(), input.countryCode?.trim()]
    .filter(Boolean)
    .join(" ");
  if (!terms || terms.length < 2) {
    throw new AgencyError("VALIDATION_ERROR", "Prospecting query must contain at least 2 characters");
  }

  const maxResults = Math.max(1, Math.min(20, Math.round(input.maxResults ?? 10)));
  const requestedMode: "deep" | "quick" = input.mode ?? (input.modelClient ? "deep" : "quick");
  const canUseLlm = Boolean(
    requestedMode === "deep" && input.hasLlmEndpoint !== false && input.modelClient,
  );
  const resolvedModel = canUseLlm
    ? await resolveProspectingModel(input.modelClient, input.preferredModel, input.defaultModel)
    : "";
  const llmActive = Boolean(canUseLlm && resolvedModel && input.modelClient);

  const steps: ProspectResearchStep[] = [];
  let queries: string[] = [terms];
  let planSummary = "";

  // ---------------- Stage 1: Query Planning ----------------
  if (requestedMode === "deep") {
    if (llmActive && input.modelClient) {
      try {
        const planPrompt = [
          "Tu es un stratège B2B expert en prospection et Deep Search Web.",
          "Analyse la demande de l'agence et planifie 3 à 4 requêtes de recherche web complémentaires pour trouver de VRAIES entreprises cibles (sites officiels, pages contact/services), en évitant annuaires génériques, blogs et articles d'actualité.",
          input.agentInstructions ? `Instructions agent :\n${input.agentInstructions.slice(0, 1200)}` : "",
          input.agentRules?.length ? `Règles :\n- ${input.agentRules.slice(0, 6).join("\n- ")}` : "",
          input.agentSkillsPrompt ? input.agentSkillsPrompt.slice(0, 1500) : "",
          `Profil client idéal (ICP) : ${formatQualificationContext(input.qualificationProfile)}`,
          "Réponds UNIQUEMENT par un objet JSON valide sans texte autour :",
          '{"planSummary":"résumé stratégique en français (1-2 phrases)","queries":["requête 1","requête 2","requête 3"],"excludeHints":["indice bruit"]}',
        ]
          .filter(Boolean)
          .join("\n\n");

        const rawPlan = await input.modelClient.streamChat(
          {
            model: resolvedModel,
            messages: [
              { role: "system", content: planPrompt },
              {
                role: "user",
                content: `Demande brute : ${input.query.trim()}\nSecteur : ${input.industry?.trim() || "non précisé"}\nVille : ${input.city?.trim() || "non précisée"}\nPays : ${input.countryCode?.trim() || "non précisé"}`,
              },
            ],
          },
          () => {},
        );
        const parsedPlan = extractJsonObject(rawPlan);
        const plannedQueries = Array.isArray(parsedPlan?.queries)
          ? parsedPlan.queries
              .map((q) => String(q ?? "").trim())
              .filter((q) => q.length >= 2 && q.length <= 160)
          : [];
        if (plannedQueries.length > 0) {
          queries = [...new Set(plannedQueries)].slice(0, 4);
          planSummary = typeof parsedPlan?.planSummary === "string" ? parsedPlan.planSummary.trim().slice(0, 400) : "";
          steps.push({
            label: "Planification IA",
            detail: `${queries.length} angle(s) de recherche générés par ${resolvedModel}.`,
            status: "done",
          });
        }
      } catch {
        /* fallback cleanly to deterministic multi-angle queries */
      }
    }
    if (steps.length === 0) {
      queries = buildDeterministicQueries(terms, input.industry, input.city);
      steps.push({
        label: "Planification multi-requêtes",
        detail: `${queries.length} requête(s) ciblée(s) préparée(s).`,
        status: "done",
      });
    }
  } else {
    queries = [terms];
    steps.push({
      label: "Recherche directe",
      detail: `1 requête directe : "${terms}".`,
      status: "done",
    });
  }

  // ---------------- Stage 2: Multi-Query Web Search & Noise Filtering ----------------
  const perQueryLimit = requestedMode === "deep" ? Math.min(12, Math.max(6, maxResults)) : maxResults;
  const queryOutcomes: Array<{ query: string; backend: string; sources: WebSource[] }> = [];
  let firstSearchError: unknown;

  for (let i = 0; i < queries.length; i += 2) {
    const batch = queries.slice(i, i + 2);
    const settled = await Promise.allSettled(
      batch.map(async (q) => ({ query: q, res: await input.search.search(q, perQueryLimit) })),
    );
    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        queryOutcomes.push({
          query: entry.value.query,
          backend: entry.value.res.backend,
          sources: entry.value.res.sources,
        });
      } else if (!firstSearchError) {
        firstSearchError = entry.reason;
      }
    }
  }

  if (queryOutcomes.length === 0 && firstSearchError) {
    throw firstSearchError;
  }

  const backends = [...new Set(queryOutcomes.map((o) => o.backend).filter(Boolean))];
  const backend = backends.length <= 1 ? (backends[0] ?? "web") : backends.join(", ");

  const byDomain = new Map<string, { candidate: ProspectCandidate; noise: boolean }>();
  let scannedCount = 0;

  for (const outcome of queryOutcomes) {
    for (const src of outcome.sources) {
      scannedCount += 1;
      const cleanUrl = websiteUrl(src.url);
      if (!cleanUrl) continue;
      const parsed = new URL(cleanUrl);
      const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (!domain) continue;

      const existing = byDomain.get(domain);
      if (existing) {
        const list = existing.candidate.foundByQueries ?? [];
        if (!list.includes(outcome.query)) list.push(outcome.query);
        existing.candidate.foundByQueries = list;
        if ((src.snippet ?? "").trim().length > existing.candidate.snippet.length) {
          existing.candidate.snippet = (src.snippet ?? "").trim();
        }
        continue;
      }

      const rootWebsite = `${parsed.protocol}//${parsed.hostname}`;
      const name = deriveCompanyNameFromSource(src, domain);
      const duplicateCompanyId = input.findDuplicate?.(normalizedName(name), rootWebsite);
      byDomain.set(domain, {
        noise: requestedMode === "deep" && isNoiseDomain(domain, terms),
        candidate: {
          name,
          website: rootWebsite,
          domain,
          snippet: (src.snippet ?? "").trim(),
          sourceUrl: cleanUrl,
          backend: outcome.backend,
          foundByQueries: [outcome.query],
          ...(duplicateCompanyId ? { duplicateCompanyId } : {}),
        },
      });
    }
  }

  const allUnique = [...byDomain.values()];
  const nonNoise = allUnique.filter((entry) => !entry.noise);
  const filteredOutCount = requestedMode === "deep" && nonNoise.length > 0 ? allUnique.length - nonNoise.length : 0;
  let candidates: ProspectCandidate[] = (filteredOutCount > 0 ? nonNoise : allUnique).map((e) => e.candidate);

  steps.push({
    label: "Exploration web",
    detail: `${scannedCount} résultat(s) analysé(s) via ${backend}, ${candidates.length} domaine(s) retenu(s)${filteredOutCount ? `, ${filteredOutCount} agrégateur(s) écarté(s)` : ""}.`,
    status: "done",
  });

  // ---------------- Stage 3: Bounded Live Website Inspection ----------------
  const auditsByDomain = new Map<string, WebsiteAuditResult>();
  if (requestedMode === "deep" && input.auditTopSites !== false && candidates.length > 0) {
    const inspectTargets = candidates.slice(0, Math.min(6, candidates.length));
    const hasCustomTransport = Boolean(input.fetchImpl || input.lookup);

    for (let i = 0; i < inspectTargets.length; i += 3) {
      const batch = inspectTargets.slice(i, i + 3);
      await Promise.allSettled(
        batch.map(async (cand) => {
          if (!hasCustomTransport && isMockTld(cand.domain)) return;
          const audited = await auditWebsiteSafely({
            url: cand.website,
            fetchImpl: input.fetchImpl,
            lookup: input.lookup,
            timeoutMs: DEEP_AUDIT_TIMEOUT_MS,
          });
          auditsByDomain.set(cand.domain, audited.audit);
          cand.audit = {
            finalUrl: audited.audit.finalUrl,
            statusCode: audited.audit.statusCode,
            usesHttps: audited.audit.usesHttps,
            hasViewportMeta: audited.audit.hasViewportMeta,
            responseTimeMs: audited.audit.responseTimeMs,
            title: audited.audit.title,
            generatorMeta: audited.audit.generatorMeta,
            issues: audited.audit.issues,
          };
          cand.contacts = {
            emails: audited.audit.detectedEmails,
            phones: audited.audit.detectedPhones,
            socials: audited.audit.socialLinks,
          };
        }),
      );
    }

    steps.push({
      label: "Inspection réelle des sites",
      detail: `${auditsByDomain.size} site(s) web inspecté(s) (HTTPS, mobile, contenu, contacts).`,
      status: auditsByDomain.size > 0 ? "done" : "skipped",
    });
  } else {
    steps.push({
      label: "Inspection réelle des sites",
      detail: requestedMode === "quick" ? "Ignorée en mode rapide." : "Aucun site inspecté.",
      status: "skipped",
    });
  }

  // ---------------- Stage 4: LLM Qualification, Ranking & Synthesis ----------------
  let mode: ProspectResearchReport["mode"] = "quick";
  let strategySummary = planSummary || `Recherche directe sur "${terms}".`;

  if (requestedMode === "deep" && candidates.length > 0) {
    let llmEvaluated = false;

    if (llmActive && input.modelClient) {
      try {
        const dossiers = candidates.slice(0, Math.min(12, candidates.length)).map((c) => {
          const audit = auditsByDomain.get(c.domain);
          return {
            domain: c.domain,
            rawName: c.name,
            snippet: c.snippet.slice(0, 260),
            foundByQueries: c.foundByQueries ?? [],
            alreadyInCrm: Boolean(c.duplicateCompanyId),
            liveSite: audit
              ? {
                  statusCode: audit.statusCode,
                  usesHttps: audit.usesHttps,
                  hasViewportMeta: audit.hasViewportMeta,
                  responseTimeMs: audit.responseTimeMs,
                  title: audit.title.slice(0, 140),
                  metaDescription: audit.metaDescription.slice(0, 220),
                  generatorMeta: audit.generatorMeta,
                  pageExcerpt: (audit.pageExcerpt ?? "").slice(0, 400),
                  issues: audit.issues,
                  emails: audit.detectedEmails,
                  phones: audit.detectedPhones,
                }
              : null,
          };
        });

        const evalSystemPrompt = [
          "Tu es le Directeur Commercial & Stratège Deep Search d'une agence logicielle / web.",
          "Analyse rigoureusement les dossiers RÉELS fournis ci-dessous (ne jamais inventer de domaine, d'email ou de fait absent du dossier).",
          "Pour chaque domaine :",
          "1. Décide keep=true si c'est une vraie entreprise / clinique / cabinet / boutique pertinente, ou keep=false si c'est un article de presse, blog générique, PDF administratif ou page hors sujet.",
          "2. Nettoie le nom exact de l'entreprise, déduis son secteur (`industry`) et sa ville (`city`) uniquement si étayés par les données.",
          "3. Attribue un score d'adéquation `fitScore` (0-100) et `relevance` ('high' | 'medium' | 'low').",
          "4. Rédige un `summary` factuel (1-2 phrases), une `opportunity` concrète pour notre agence digitale/logicielle (refonte mobile, prise de RDV, e-commerce, automatisation, SEO, etc.) et un `recommendedAngle` court pour le premier message.",
          "5. Liste 2 à 4 `signals` factuels courts.",
          `Profil client idéal (ICP) : ${formatQualificationContext(input.qualificationProfile)}`,
          input.agentRules?.length ? `Règles à respecter :\n- ${input.agentRules.slice(0, 5).join("\n- ")}` : "",
          "Réponds UNIQUEMENT par un objet JSON valide :",
          '{"strategySummary":"synthèse globale en français","candidates":[{"domain":"exemple.com","keep":true,"name":"Nom Entreprise","industry":"Immobilier","city":"Dakar","fitScore":86,"relevance":"high","summary":"...","opportunity":"...","recommendedAngle":"...","signals":["HTTPS","Contact direct"]}]}',
        ]
          .filter(Boolean)
          .join("\n\n");

        const rawEval = await input.modelClient.streamChat(
          {
            model: resolvedModel,
            messages: [
              { role: "system", content: evalSystemPrompt },
              {
                role: "user",
                content: `Requête utilisateur : "${terms}"\n\nDossiers des candidats (${dossiers.length}) :\n${JSON.stringify(dossiers)}`,
              },
            ],
          },
          () => {},
        );

        const parsedEval = extractJsonObject(rawEval);
        const evalItems = Array.isArray(parsedEval?.candidates) ? parsedEval.candidates : [];
        if (evalItems.length > 0) {
          const evalMap = new Map<string, Record<string, unknown>>();
          for (const item of evalItems) {
            if (!item || typeof item !== "object" || Array.isArray(item)) continue;
            const rec = item as Record<string, unknown>;
            const dom = String(rec.domain ?? "").toLowerCase().replace(/^www\./, "").trim();
            if (dom && byDomain.has(dom)) evalMap.set(dom, rec);
          }

          if (evalMap.size > 0) {
            const enrichedAll = candidates.map((cand) => {
              const ev = evalMap.get(cand.domain);
              const fallback = computeDeterministicScore(cand, auditsByDomain.get(cand.domain), input);
              if (!ev) {
                return { keep: true, cand: { ...cand, ...fallback } };
              }
              const keep = ev.keep !== false;
              const rawScore = Number(ev.fitScore);
              const fitScore = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : fallback.fitScore;
              const relVal = String(ev.relevance ?? "").toLowerCase();
              const relevance: "high" | "medium" | "low" =
                relVal === "high" || relVal === "medium" || relVal === "low"
                  ? relVal
                  : fitScore >= 72
                    ? "high"
                    : fitScore >= 48
                      ? "medium"
                      : "low";
              const cleanName = typeof ev.name === "string" && ev.name.trim() ? ev.name.trim().slice(0, 120) : cand.name;
              return {
                keep,
                cand: {
                  ...cand,
                  name: cleanName,
                  industry: typeof ev.industry === "string" && ev.industry.trim() ? ev.industry.trim().slice(0, 80) : input.industry?.trim() || undefined,
                  city: typeof ev.city === "string" && ev.city.trim() ? ev.city.trim().slice(0, 80) : input.city?.trim() || undefined,
                  fitScore,
                  relevance,
                  summary: typeof ev.summary === "string" && ev.summary.trim() ? ev.summary.trim().slice(0, 400) : fallback.summary,
                  opportunity: typeof ev.opportunity === "string" && ev.opportunity.trim() ? ev.opportunity.trim().slice(0, 320) : fallback.opportunity,
                  recommendedAngle: typeof ev.recommendedAngle === "string" && ev.recommendedAngle.trim() ? ev.recommendedAngle.trim().slice(0, 260) : fallback.recommendedAngle,
                  signals: Array.isArray(ev.signals)
                    ? ev.signals.map((s) => String(s ?? "").trim()).filter(Boolean).slice(0, 5)
                    : fallback.signals,
                },
              };
            });

            const kept = enrichedAll.filter((x) => x.keep);
            const activePool = (kept.length > 0 ? kept : enrichedAll).map((x) => x.cand);
            activePool.sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0));
            candidates = activePool.slice(0, maxResults);

            if (typeof parsedEval?.strategySummary === "string" && parsedEval.strategySummary.trim()) {
              strategySummary = parsedEval.strategySummary.trim().slice(0, 1200);
            } else {
              strategySummary = `Analyse Deep Search IA terminée (${resolvedModel}) : ${candidates.length} prospect(s) priorisés selon les signaux réels de leur site web.`;
            }
            mode = "deep_llm";
            llmEvaluated = true;
            steps.push({
              label: "Analyse & scoring IA",
              detail: `Qualification et détection d'opportunités par ${resolvedModel} sur ${evalMap.size} candidat(s).`,
              status: "done",
            });
          }
        }
      } catch {
        /* fallback deterministically below */
      }
    }

    if (!llmEvaluated) {
      candidates = candidates
        .map((cand, index) => ({
          index,
          cand: {
            ...cand,
            ...(input.industry?.trim() ? { industry: input.industry.trim() } : {}),
            ...(input.city?.trim() ? { city: input.city.trim() } : {}),
            ...computeDeterministicScore(cand, auditsByDomain.get(cand.domain), input),
          },
        }))
        .sort((a, b) => (b.cand.fitScore ?? 0) - (a.cand.fitScore ?? 0) || a.index - b.index)
        .slice(0, maxResults)
        .map((x) => x.cand);

      mode = "deep_deterministic";
      strategySummary =
        planSummary ||
        `Deep Search multi-requêtes (${queries.length} requêtes, ${auditsByDomain.size} site(s) inspecté(s)). Activez un modèle IA actif dans Paramètres/Agents IA pour activer le raisonnement sémantique complet.`;
      steps.push({
        label: "Scoring heuristique local",
        detail: `${candidates.length} candidat(s) classés selon l'audit technique et les signaux ICP (LLM inactif ou indisponible).`,
        status: "done",
      });
    }
  } else {
    candidates = candidates.slice(0, maxResults);
    if (requestedMode === "deep") {
      mode = llmActive ? "deep_llm" : "deep_deterministic";
      strategySummary = "Aucun candidat exploitable trouvé pour cette recherche.";
    } else {
      steps.push({
        label: "Scoring IA",
        detail: "Désactivé en mode rapide.",
        status: "skipped",
      });
    }
  }

  return {
    query: terms,
    backend,
    candidates,
    research: {
      mode,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      queries,
      scannedCount,
      filteredOutCount,
      auditedCount: auditsByDomain.size,
      durationMs: Math.max(1, Date.now() - startedAt),
      strategySummary,
      steps,
    },
  };
}
