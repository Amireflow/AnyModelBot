import type { Evidence, ResearchAssessment, ResearchDomain } from "./types.js";

const DOMAINS: readonly ResearchDomain[] = ["company", "industry", "financial", "news"];
const DAY = 24 * 60 * 60 * 1000;

/** Measures research-dossier quality; it is not a prospect-fit or likelihood-to-buy score. */
export function classifyEvidenceType(value: string): ResearchDomain | undefined {
  const type = value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (/(financial|finance|funding|revenue|annual_report|balance_sheet|investment)/.test(type)) return "financial";
  if (/(news|press|media|announcement|event)/.test(type)) return "news";
  if (/(industry|market|competitor|sector|regulation|trend)/.test(type)) return "industry";
  if (/(company|business|profile|product|service|team|official|website|registry)/.test(type)) return "company";
  return undefined;
}

function hostOf(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function assessResearchEvidence(evidence: Evidence[], now: number): ResearchAssessment {
  const coverage: Record<ResearchDomain, number> = { company: 0, industry: 0, financial: 0, news: 0 };
  const hosts = new Set<string>();
  let confidenceTotal = 0;
  let freshEvidenceCount = 0;

  for (const item of evidence) {
    const domain = classifyEvidenceType(item.evidenceType);
    if (domain) coverage[domain]++;
    const host = hostOf(item.sourceUrl);
    if (host) hosts.add(host);
    confidenceTotal += Math.max(0, Math.min(1, item.confidence));
    if (item.observedAt >= now - 365 * DAY && item.observedAt <= now + DAY) freshEvidenceCount++;
  }

  const evidenceCount = evidence.length;
  const coveredDomains = DOMAINS.filter(domain => coverage[domain] > 0);
  const missingDomains = DOMAINS.filter(domain => coverage[domain] === 0);
  const averageConfidence = evidenceCount ? confidenceTotal / evidenceCount : 0;
  const breakdown = {
    coverage: Math.round((coveredDomains.length / DOMAINS.length) * 40),
    sourceDiversity: Math.round((Math.min(hosts.size, 5) / 5) * 20),
    confidence: Math.round(averageConfidence * 20),
    freshness: evidenceCount ? Math.round((freshEvidenceCount / evidenceCount) * 20) : 0,
  };
  const score = breakdown.coverage + breakdown.sourceDiversity + breakdown.confidence + breakdown.freshness;
  const status: ResearchAssessment["status"] = evidenceCount === 0
    ? "insufficient"
    : score >= 65 && coveredDomains.length >= 3 && evidenceCount >= 5 && averageConfidence >= 0.6
      ? "review_ready"
      : "developing";

  const reasons = [
    "Domain coverage: " + coveredDomains.length + "/" + DOMAINS.length,
    "Distinct source hosts: " + hosts.size,
    "Average source confidence: " + Math.round(averageConfidence * 100) + "%",
    "Evidence observed in the last 365 days: " + freshEvidenceCount + "/" + evidenceCount,
  ];
  const recommendations: string[] = [];
  if (missingDomains.length) recommendations.push("Add evidence for: " + missingDomains.join(", "));
  if (hosts.size < 3) recommendations.push("Use at least three distinct source websites where available");
  if (averageConfidence < 0.6) recommendations.push("Review source reliability and lower confidence for weak sources");
  if (evidenceCount > 0 && freshEvidenceCount < evidenceCount) recommendations.push("Refresh evidence that is more than 365 days old");
  if (evidenceCount < 5) recommendations.push("Collect at least five independent evidence items");
  if (status === "review_ready") recommendations.push("Dossier can be reviewed by a human; this does not qualify the prospect automatically");

  return {
    modelVersion: "research-evidence-v1", score, status, evidenceCount,
    coveredDomains, missingDomains, coverage, distinctSourceHosts: hosts.size,
    averageConfidence: Math.round(averageConfidence * 100) / 100,
    freshEvidenceCount, breakdown, reasons, recommendations, assessedAt: now,
  };
}
