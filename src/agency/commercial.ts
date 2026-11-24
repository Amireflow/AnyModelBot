import { AgencyError } from "./errors.js";
import type {
  CommercialRules,
  CommercialSignal,
  NegotiationAction,
  NegotiationEvaluation,
  NegotiationViolation,
  QuoteLineItem,
  QuoteTotals,
  ServiceCatalogItem,
  TieredProposalOption,
} from "./types.js";

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgencyError("VALIDATION_ERROR", `${field} must be a non-negative finite number`);
  }
  return value;
}

export function calculateQuoteTotals(
  lines: QuoteLineItem[],
  discountPct = 0,
  uncertaintyPct = 15,
): QuoteTotals {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 50) {
    throw new AgencyError("VALIDATION_ERROR", "Quote must contain between 1 and 50 line items");
  }
  const discount = finiteNonNegative(discountPct, "discountPct");
  if (discount > 100) throw new AgencyError("VALIDATION_ERROR", "discountPct cannot exceed 100");
  const uncertainty = finiteNonNegative(uncertaintyPct, "uncertaintyPct");
  if (uncertainty > 100) throw new AgencyError("VALIDATION_ERROR", "uncertaintyPct cannot exceed 100");

  let subtotal = 0;
  let estimatedCost = 0;
  let totalDays = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || typeof line !== "object" || typeof line.label !== "string" || !line.label.trim()) {
      throw new AgencyError("VALIDATION_ERROR", `Quote line ${i + 1} requires a label`);
    }
    const quantity = finiteNonNegative(line.quantity, `lines[${i}].quantity`);
    if (quantity <= 0) throw new AgencyError("VALIDATION_ERROR", `lines[${i}].quantity must be greater than 0`);
    const unitPrice = finiteNonNegative(line.unitPrice, `lines[${i}].unitPrice`);
    const unitCost = finiteNonNegative(line.unitCost, `lines[${i}].unitCost`);
    const estimatedDays = finiteNonNegative(line.estimatedDays, `lines[${i}].estimatedDays`);
    subtotal += quantity * unitPrice;
    estimatedCost += quantity * unitCost;
    totalDays += estimatedDays;
  }

  const roundedSubtotal = round2(subtotal);
  const discountAmount = round2(roundedSubtotal * (discount / 100));
  const netTotal = round2(roundedSubtotal - discountAmount);
  const roundedCost = round2(estimatedCost);
  const grossMargin = round2(netTotal - roundedCost);
  const marginPct = netTotal > 0 ? round2((grossMargin / netTotal) * 100) : (roundedCost > 0 ? -100 : 0);
  const roundedDays = round2(totalDays);
  const rangeLow = round2(Math.max(0, netTotal * (1 - uncertainty / 100)));
  const rangeHigh = round2(netTotal * (1 + uncertainty / 100));

  return {
    subtotal: roundedSubtotal,
    discountPct: round2(discount),
    discountAmount,
    netTotal,
    estimatedCost: roundedCost,
    grossMargin,
    marginPct,
    totalDays: roundedDays,
    rangeLow,
    rangeHigh,
  };
}

export function marginFloorPrice(estimatedCost: number, minMarginPct: number): number {
  const cost = finiteNonNegative(estimatedCost, "estimatedCost");
  const minMargin = finiteNonNegative(minMarginPct, "minMarginPct");
  if (minMargin >= 100) return cost;
  return round2(cost / (1 - minMargin / 100));
}

export function evaluateNegotiation(
  totals: QuoteTotals,
  requestedDiscountPct: number,
  rules: CommercialRules,
): NegotiationEvaluation {
  const discount = finiteNonNegative(requestedDiscountPct, "requestedDiscountPct");
  if (discount > 100) throw new AgencyError("VALIDATION_ERROR", "requestedDiscountPct cannot exceed 100");

  const priceFloor = marginFloorPrice(totals.estimatedCost, rules.minMarginPct);
  const discountAmount = round2(totals.subtotal * (discount / 100));
  const resultingTotal = round2(totals.subtotal - discountAmount);
  const resultingMargin = round2(resultingTotal - totals.estimatedCost);
  const resultingMarginPct = resultingTotal > 0
    ? round2((resultingMargin / resultingTotal) * 100)
    : (totals.estimatedCost > 0 ? -100 : 0);

  const violations: NegotiationViolation[] = [];
  if (discount > rules.maxAutonomousDiscountPct) violations.push("DISCOUNT_EXCEEDS_AUTONOMOUS_LIMIT");
  if (resultingMarginPct < rules.minMarginPct) violations.push("BELOW_MIN_MARGIN");
  if (resultingTotal < priceFloor) violations.push("BELOW_PRICE_FLOOR");
  if (rules.requireOwnerApprovalAboveAmount > 0 && resultingTotal > rules.requireOwnerApprovalAboveAmount) {
    violations.push("EXCEEDS_OWNER_THRESHOLD");
  }

  const actions = new Set<NegotiationAction>();
  if (violations.includes("BELOW_MIN_MARGIN") || violations.includes("BELOW_PRICE_FLOOR")) {
    actions.add("reduce_scope");
    actions.add("phase_delivery");
    actions.add("request_owner_approval");
  } else if (violations.length > 0) {
    actions.add("phase_delivery");
    actions.add("adjust_payment_schedule");
    actions.add("request_owner_approval");
  }

  return {
    requestedDiscountPct: round2(discount),
    priceFloor,
    resultingTotal,
    resultingMargin,
    resultingMarginPct,
    allowedAutonomously: violations.length === 0,
    requiresOwnerApproval: violations.length > 0,
    violations,
    recommendedActions: [...actions],
  };
}

export function buildTieredProposals(item: ServiceCatalogItem, rules: CommercialRules): TieredProposalOption[] {
  const baseScope = item.defaultScope || item.description;
  const essentialCost = round2(item.estimatedCost * 0.72);
  const standardCost = round2(item.estimatedCost);
  const advancedCost = round2(item.estimatedCost * 1.35);

  const essentialPrice = Math.max(
    item.priceMin > 0 ? round2(item.priceMin) : round2(item.priceBase * 0.75),
    marginFloorPrice(essentialCost, rules.minMarginPct),
  );
  const standardPrice = Math.max(
    round2(item.priceBase),
    marginFloorPrice(standardCost, rules.minMarginPct),
  );
  const advancedPrice = Math.max(
    item.priceMax > 0 ? round2(item.priceMax) : round2(item.priceBase * 1.45),
    marginFloorPrice(advancedCost, rules.minMarginPct),
    round2(standardPrice * 1.25),
  );

  const marginOf = (price: number, cost: number) => (price > 0 ? round2(((price - cost) / price) * 100) : 0);

  return [
    {
      tier: "essential",
      title: `${item.name} — Essentiel`,
      scopeSummary: `Socle prioritaire : ${baseScope}`,
      deliverables: ["Cadrage initial", "Fonctionnalités cœur de périmètre", "Mise en ligne et recette de base"],
      exclusions: [...item.exclusions, "Intégrations tierces avancées", "Automatisations complémentaires"],
      estimatedDays: Math.max(1, Math.round(item.estimatedDays * 0.7)),
      price: round2(essentialPrice),
      estimatedCost: essentialCost,
      marginPct: marginOf(essentialPrice, essentialCost),
    },
    {
      tier: "standard",
      title: `${item.name} — Standard`,
      scopeSummary: baseScope,
      deliverables: ["Spécifications validées", "Périmètre complet catalogue", "Tests fonctionnels et techniques", "Documentation de prise en main"],
      exclusions: [...item.exclusions],
      estimatedDays: Math.max(1, Math.round(item.estimatedDays)),
      price: round2(standardPrice),
      estimatedCost: standardCost,
      marginPct: marginOf(standardPrice, standardCost),
    },
    {
      tier: "advanced",
      title: `${item.name} — Avancé`,
      scopeSummary: `${baseScope} + automatisations, instrumentation et accompagnement renforcé`,
      deliverables: ["Périmètre complet + extensions prioritaires", "Intégrations et automatisations métier", "Suite QA étendue & suivi post-livraison"],
      exclusions: item.exclusions.slice(0, 2),
      estimatedDays: Math.max(1, Math.round(item.estimatedDays * 1.35)),
      price: round2(advancedPrice),
      estimatedCost: advancedCost,
      marginPct: marginOf(advancedPrice, advancedCost),
    },
  ];
}

const OPT_OUT_PATTERN = /\b(stop|unsubscribe|opt[- ]?out|do not contact|remove me)\b|désinscri|ne (?:me )?plus contacter|pas intéressé/iu;
const HUMAN_PATTERN = /\b(human|manager|director|call me|lawyer|legal|dispute)\b|responsable|humain|appeler|juridique|avocat/iu;
const PRICING_PATTERN = /\b(price|pricing|cost|quote|budget|discount|how much)\b|prix|tarif|devis|co[uû]t|remise|combien/iu;
const OBJECTION_PATTERN = /\b(too expensive|not now|already have|no budget|later)\b|trop cher|pas maintenant|déjà un|pas de budget/iu;
const INTEREST_PATTERN = /\b(interested|demo|proposal|let'?s talk|yes|send)\b|intéressé|proposition|d'accord|oui|envoyez/iu;

export function classifyCommercialSignal(text: string): CommercialSignal {
  const sample = String(text || "").trim();
  if (!sample) return "general";
  if (OPT_OUT_PATTERN.test(sample)) return "opt_out";
  if (HUMAN_PATTERN.test(sample)) return "needs_human";
  if (OBJECTION_PATTERN.test(sample)) return "objection";
  if (PRICING_PATTERN.test(sample)) return "pricing_question";
  if (INTEREST_PATTERN.test(sample)) return "interested";
  return "general";
}
