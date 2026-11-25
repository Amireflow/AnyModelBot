import { AgencyError } from "./errors.js";
import type {
  AgencyMetrics,
  AgencyMission,
  Approval,
  ClientFollowUp,
  Contract,
  Lead,
  Project,
  ProjectLot,
  ProjectStatus,
  QaCategory,
  QaCheck,
  QaGateEvaluation,
  Quote,
} from "./types.js";

const PROJECT_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  handoff_pending: ["scoping", "archived"],
  scoping: ["in_progress", "archived"],
  in_progress: ["qa_review", "archived"],
  qa_review: ["in_progress", "ready_for_delivery", "archived"],
  ready_for_delivery: ["qa_review", "delivered", "archived"],
  delivered: ["accepted", "maintenance", "qa_review", "archived"],
  accepted: ["maintenance", "archived"],
  maintenance: ["in_progress", "archived"],
  archived: [],
};

export const REQUIRED_QA_CATEGORIES: readonly QaCategory[] = [
  "functional",
  "technical",
  "ui_ux",
  "security",
];

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return Object.hasOwn(PROJECT_TRANSITIONS, from) && PROJECT_TRANSITIONS[from].includes(to);
}

export function assertProjectTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!canTransitionProject(from, to)) {
    throw new AgencyError("INVALID_TRANSITION", `Project cannot move from ${from} to ${to}`, {
      from,
      to,
    });
  }
}

/**
 * Evaluates whether a project passes the independent multi-discipline QA gate
 * required before governed production delivery.
 */
export function evaluateQaGate(
  lots: readonly ProjectLot[],
  checks: readonly QaCheck[],
): QaGateEvaluation {
  const totalLots = lots.length;
  const verifiedLots = lots.filter((l) => l.status === "verified" || l.status === "done").length;
  const totalChecks = checks.length;
  const failedChecks = checks.filter((c) => c.status === "failed").length;
  const blockedChecks = checks.filter((c) => c.status === "blocked").length;
  const missingEvidenceChecks = checks.filter(
    (c) => c.status === "passed" && c.evidence.trim().length === 0,
  ).length;

  const passedCategories = REQUIRED_QA_CATEGORIES.filter((category) =>
    checks.some(
      (c) => c.category === category && c.status === "passed" && c.evidence.trim().length > 0,
    ),
  );
  const missingCategories = REQUIRED_QA_CATEGORIES.filter(
    (category) => !passedCategories.includes(category),
  );

  const blockers: string[] = [];
  if (totalLots === 0) {
    blockers.push("no_project_lots");
  } else if (verifiedLots < totalLots) {
    blockers.push(`unverified_lots:${totalLots - verifiedLots}`);
  }
  if (failedChecks > 0) {
    blockers.push(`failed_qa_checks:${failedChecks}`);
  }
  if (blockedChecks > 0) {
    blockers.push(`blocked_qa_checks:${blockedChecks}`);
  }
  if (missingEvidenceChecks > 0) {
    blockers.push(`missing_qa_evidence:${missingEvidenceChecks}`);
  }
  for (const cat of missingCategories) {
    blockers.push(`missing_qa_category:${cat}`);
  }

  return {
    readyForDelivery: blockers.length === 0,
    totalLots,
    verifiedLots,
    totalChecks,
    passedCategories,
    missingCategories,
    failedChecks,
    blockedChecks,
    missingEvidenceChecks,
    blockers,
  };
}

export interface ComputeAgencyMetricsInput {
  organizationId: string;
  leads: readonly Lead[];
  quotes: readonly Quote[];
  contracts: readonly Contract[];
  projects: readonly Project[];
  qaChecks: readonly QaCheck[];
  followUps: readonly ClientFollowUp[];
  missions: readonly AgencyMission[];
  approvals?: readonly Approval[];
}

export function computeAgencyMetrics(input: ComputeAgencyMetricsInput): AgencyMetrics {
  const qualifiedStages = new Set([
    "qualified",
    "contact_pending",
    "contacted",
    "engaged",
    "opportunity",
    "proposal",
    "won",
  ]);
  const leadsQualified = input.leads.filter((l) => qualifiedStages.has(l.stage)).length;
  const leadsWon = input.leads.filter((l) => l.stage === "won").length;

  const sentStatuses = new Set(["sent", "negotiating", "accepted", "rejected"]);
  const quotesSent = input.quotes.filter((q) => sentStatuses.has(q.status)).length;
  const quotesAccepted = input.quotes.filter((q) => q.status === "accepted").length;
  const signedContracts = input.contracts.filter((c) => c.status === "signed");
  const contractsSigned = signedContracts.length;
  const signedRevenue =
    Math.round(signedContracts.reduce((sum, c) => sum + c.totalAmount, 0) * 100) / 100;
  const collectedDeposits =
    Math.round(
      signedContracts
        .filter((c) => c.depositStatus === "paid")
        .reduce((sum, c) => sum + c.depositAmount, 0) * 100,
    ) / 100;
  const outstandingBalance = Math.max(0, Math.round((signedRevenue - collectedDeposits) * 100) / 100);
  const avgDealSize =
    contractsSigned > 0 ? Math.round((signedRevenue / contractsSigned) * 100) / 100 : 0;

  const activeQuoteStatuses = new Set(["draft", "pending_approval", "approved", "sent"]);
  const pipelineValue =
    Math.round(
      input.quotes
        .filter((q) => activeQuoteStatuses.has(q.status))
        .reduce((sum, q) => sum + q.netTotal, 0) * 100,
    ) / 100;

  const avgMarginPct =
    input.quotes.length > 0
      ? Math.round(
          (input.quotes.reduce((sum, q) => sum + q.marginPct, 0) / input.quotes.length) * 10,
        ) / 10
      : 0;

  const projectsDelivered = input.projects.filter(
    (p) => p.deliveredAt !== null || ["delivered", "accepted", "maintenance"].includes(p.status),
  ).length;
  const projectsAccepted = input.projects.filter(
    (p) => p.acceptedAt !== null || p.status === "accepted" || p.status === "maintenance",
  ).length;

  const decidedQa = input.qaChecks.filter((c) => c.status === "passed" || c.status === "failed");
  const passedQa = decidedQa.filter((c) => c.status === "passed").length;
  const qaFirstPassRate =
    decidedQa.length > 0 ? Math.round((passedQa / decidedQa.length) * 1000) / 10 : 0;

  const quoteAcceptanceRate =
    quotesSent > 0 ? Math.round((quotesAccepted / quotesSent) * 1000) / 10 : 0;
  const leadToWinRate =
    input.leads.length > 0 ? Math.round((leadsWon / input.leads.length) * 1000) / 10 : 0;

  const pendingApprovalsCount = (input.approvals ?? []).filter((a) => a.status === "pending").length;
  const pendingFollowUps = input.followUps.filter(
    (f) => f.status === "scheduled" || f.status === "contacted",
  ).length;
  const openMissions = input.missions.filter(
    (m) => m.status === "planned" || m.status === "running" || m.status === "blocked",
  ).length;

  return {
    organizationId: input.organizationId,
    leadsTotal: input.leads.length,
    leadsQualified,
    quotesSent,
    quotesAccepted,
    contractsSigned,
    projectsTotal: input.projects.length,
    projectsDelivered,
    projectsAccepted,
    quoteAcceptanceRate,
    qaFirstPassRate,
    signedRevenue,
    pipelineValue,
    collectedDeposits,
    outstandingBalance,
    avgDealSize,
    leadToWinRate,
    avgMarginPct,
    pendingApprovalsCount,
    pendingFollowUps,
    openMissions,
  };
}
