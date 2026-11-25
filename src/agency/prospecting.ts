import dns from "node:dns/promises";
import net from "node:net";
import { createHash } from "node:crypto";
import type { SearchService, WebSource } from "../tools/search.js";
import { AgencyError } from "./errors.js";
import type { ProspectCandidate, WebsiteAuditResult } from "./types.js";
import { normalizedName, websiteUrl } from "./validation.js";

const MAX_AUDIT_BYTES = 512 * 1024;
const AUDIT_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

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

export async function prospectWebCompanies(input: {
  search: Pick<SearchService, "search">;
  query: string;
  industry?: string;
  city?: string;
  countryCode?: string;
  maxResults?: number;
  findDuplicate?: (normalized: string, website: string) => string | undefined;
}): Promise<{ query: string; backend: string; candidates: ProspectCandidate[] }> {
  const terms = [input.query.trim(), input.industry?.trim(), input.city?.trim(), input.countryCode?.trim()]
    .filter(Boolean)
    .join(" ");
  if (!terms || terms.length < 2) {
    throw new AgencyError("VALIDATION_ERROR", "Prospecting query must contain at least 2 characters");
  }
  const maxResults = Math.max(1, Math.min(20, Math.round(input.maxResults ?? 10)));
  const outcome = await input.search.search(terms, maxResults);
  const seenDomains = new Set<string>();
  const candidates: ProspectCandidate[] = [];

  for (const src of outcome.sources) {
    const cleanUrl = websiteUrl(src.url);
    if (!cleanUrl) continue;
    const parsed = new URL(cleanUrl);
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!domain || seenDomains.has(domain)) continue;
    seenDomains.add(domain);
    const rootWebsite = `${parsed.protocol}//${parsed.hostname}`;
    const name = deriveCompanyNameFromSource(src, domain);
    const duplicateCompanyId = input.findDuplicate?.(normalizedName(name), rootWebsite);
    candidates.push({
      name,
      website: rootWebsite,
      domain,
      snippet: (src.snippet ?? "").trim(),
      sourceUrl: cleanUrl,
      backend: outcome.backend,
      ...(duplicateCompanyId ? { duplicateCompanyId } : {}),
    });
  }

  return { query: terms, backend: outcome.backend, candidates };
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function auditWebsiteSafely(input: {
  url: string;
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
  now?: () => number;
}): Promise<{
  audit: WebsiteAuditResult;
  evidenceSummary: string;
  contentHash: string;
  confidence: number;
}> {
  const fetchFn = input.fetchImpl ?? fetch;
  const now = (input.now ?? Date.now)();
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
      signal: AbortSignal.timeout(AUDIT_TIMEOUT_MS),
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
