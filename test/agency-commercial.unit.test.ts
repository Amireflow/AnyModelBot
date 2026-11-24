import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgencyError,
  AgencyService,
  AgencyStore,
  buildTieredProposals,
  calculateQuoteTotals,
  classifyCommercialSignal,
  evaluateNegotiation,
} from "../src/agency/index.js";

describe("Agency commercial loop (Lot A)", () => {
  let store: AgencyStore;
  let service: AgencyService;
  let tick: number;
  let seq: number;
  let orgId: string;
  let companyId: string;
  let contactId: string;
  let leadId: string;

  beforeEach(() => {
    tick = 1_800_000_000_000;
    seq = 0;
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, { now: () => tick, id: () => `comm-${++seq}` });
    orgId = service.createOrganization({ name: "Amireflow Agency", countryCode: "SN", currency: "EUR" }, "owner-1").id;
    service.addMember(orgId, "owner-1", "sales-1", "member");
    companyId = service.createCompany(orgId, "owner-1", { name: "Boutique Soleil", industry: "retail", countryCode: "SN" }).id;
    contactId = service.createContact(orgId, "owner-1", {
      companyId, displayName: "Fatou Ndiaye", email: "fatou@soleil.example", phone: "+221771112233",
    }).id;
    leadId = service.createLead(orgId, "owner-1", { companyId, contactId, source: "outbound_research" }).id;
  });

  afterEach(() => store.close());

  it("computes deterministic quote totals, margins and uncertainty ranges, rejecting invalid inputs", () => {
    const totals = calculateQuoteTotals([
      { label: "Frontend", quantity: 1, unitPrice: 2000, unitCost: 900, estimatedDays: 6 },
      { label: "Backend", quantity: 2, unitPrice: 1000, unitCost: 450, estimatedDays: 4 },
    ], 10, 20);
    expect(totals).toEqual({
      subtotal: 4000,
      discountPct: 10,
      discountAmount: 400,
      netTotal: 3600,
      estimatedCost: 1800,
      grossMargin: 1800,
      marginPct: 50,
      totalDays: 10,
      rangeLow: 2880,
      rangeHigh: 4320,
    });
    expect(() => calculateQuoteTotals([], 0)).toThrowError(AgencyError);
    expect(() => calculateQuoteTotals([{ label: "Bad", quantity: 1, unitPrice: -10, unitCost: 0, estimatedDays: 1 }], 0)).toThrowError(AgencyError);
    expect(() => calculateQuoteTotals([{ label: "Bad", quantity: 1, unitPrice: 100, unitCost: 0, estimatedDays: 1 }], 120)).toThrowError(AgencyError);
  });

  it("generates tiered proposals respecting minimum margin floor", () => {
    const item = service.createCatalogItem(orgId, "owner-1", {
      code: "web_ecom",
      name: "Boutique E-commerce",
      category: "ecommerce",
      description: "Boutique en ligne complète avec paiement",
      defaultScope: "Catalogue, panier, paiement et back-office",
      exclusions: ["Shooting photo", "Rédaction SEO"],
      estimatedDays: 15,
      priceMin: 1800,
      priceBase: 3000,
      priceMax: 5000,
      estimatedCost: 1500,
    });
    const rules = service.updateCommercialRules(orgId, "owner-1", {
      minMarginPct: 40,
      maxAutonomousDiscountPct: 10,
      defaultDepositPct: 40,
    });
    const tiers = buildTieredProposals(item, rules);
    expect(tiers.map((t) => t.tier)).toEqual(["essential", "standard", "advanced"]);
    for (const tier of tiers) {
      expect(tier.marginPct).toBeGreaterThanOrEqual(40);
      expect(tier.deliverables.length).toBeGreaterThan(0);
    }
    expect(service.previewTieredProposals(orgId, "sales-1", item.id)).toHaveLength(3);
  });

  it("enforces bounded negotiation rules and detects floor breaches", () => {
    const rules = service.updateCommercialRules(orgId, "owner-1", {
      minMarginPct: 30,
      maxAutonomousDiscountPct: 10,
      requireOwnerApprovalAboveAmount: 5000,
    });
    const totals = calculateQuoteTotals([
      { label: "Platform", quantity: 1, unitPrice: 3000, unitCost: 1800, estimatedDays: 12 },
    ], 0);
    const ok = evaluateNegotiation(totals, 8, rules);
    expect(ok.allowedAutonomously).toBe(true);
    expect(ok.requiresOwnerApproval).toBe(false);
    expect(ok.violations).toEqual([]);

    const breach = evaluateNegotiation(totals, 25, rules);
    expect(breach.allowedAutonomously).toBe(false);
    expect(breach.requiresOwnerApproval).toBe(true);
    expect(breach.violations).toContain("DISCOUNT_EXCEEDS_AUTONOMOUS_LIMIT");
    expect(breach.violations).toContain("BELOW_MIN_MARGIN");
    expect(breach.violations).toContain("BELOW_PRICE_FLOOR");
    expect(breach.recommendedActions).toContain("reduce_scope");
  });

  it("manages commercial conversations, halts outreach on opt-out, and supports human handoff", () => {
    expect(classifyCommercialSignal("STOP merci de ne plus me contacter")).toBe("opt_out");
    expect(classifyCommercialSignal("Quel est le tarif pour un devis ?")).toBe("pricing_question");

    const conv = service.createConversation(orgId, "sales-1", {
      leadId,
      channel: "email",
      subject: "Refonte boutique en ligne",
      nextFollowUpAt: tick + 86_400_000,
    });
    const out = service.addConversationMessage(orgId, "sales-1", conv.id, {
      direction: "outbound",
      body: "Bonjour Fatou, voici notre proposition initiale.",
    });
    expect(out.conversation.status).toBe("awaiting_reply");

    const optOut = service.addConversationMessage(orgId, "sales-1", conv.id, {
      direction: "inbound",
      body: "Merci, pas intéressé — unsubscribe.",
    });
    expect(optOut.message.signal).toBe("opt_out");
    expect(optOut.conversation.status).toBe("opted_out");
    expect(optOut.conversation.nextFollowUpAt).toBe(0);

    expect(() =>
      service.addConversationMessage(orgId, "sales-1", conv.id, {
        direction: "outbound",
        body: "Relance automatique",
      }),
    ).toThrowError(AgencyError);

    const conv2 = service.createConversation(orgId, "sales-1", {
      leadId,
      channel: "whatsapp",
      subject: "Deuxième contact",
    });
    const handed = service.handoffConversation(orgId, "sales-1", conv2.id, "Client demande un appel juridique");
    expect(handed.status).toBe("handoff_human");
  });

  it("persists structured needs qualification and enforces quote -> contract -> signature -> deposit governance", () => {
    const needs = service.upsertNeedsQualification(orgId, "sales-1", leadId, {
      problemStatement: "Vendre en ligne avec paiement mobile money",
      targetUsers: "Clients particuliers Dakar",
      solutionType: "ecommerce",
      mustHaveFeatures: ["Catalogue", "Panier", "Paiement Wave"],
      niceToHaveFeatures: ["Programme fidélité"],
      constraints: ["Budget serré"],
      desiredTimeline: "4 semaines",
      budgetMin: 2000,
      budgetMax: 3500,
      assumptions: ["Photos fournies par le client"],
      unknowns: ["Volume SKU exact"],
      risks: ["Délai intégration API paiement"],
      recommendedSolution: "Boutique Standard + module paiement local",
      clientConfirmed: true,
    });
    expect(needs.mustHaveFeatures).toEqual(["Catalogue", "Panier", "Paiement Wave"]);
    expect(service.getNeedsQualification(orgId, "sales-1", leadId)?.clientConfirmed).toBe(true);

    const { quote } = service.createQuote(orgId, "sales-1", {
      leadId,
      title: "Devis E-commerce Dakar",
      tier: "standard",
      lines: [{ label: "Boutique + Wave", quantity: 1, unitPrice: 3000, unitCost: 1400, estimatedDays: 14 }],
      exclusions: ["Shooting photo"],
      discountPct: 5,
    });
    expect(quote.version).toBe(1);
    expect(quote.netTotal).toBe(2850);

    // Cannot send before approval
    expect(() => service.sendQuote(orgId, "sales-1", quote.id)).toThrowError(AgencyError);

    const { approval: quoteApproval } = service.requestQuoteApproval(orgId, "sales-1", quote.id, "Envoi devis v1");
    expect(() => service.decideApproval(orgId, "sales-1", quoteApproval.id, "approved", quoteApproval.payloadHash)).toThrowError(AgencyError);
    service.decideApproval(orgId, "owner-1", quoteApproval.id, "approved", quoteApproval.payloadHash, "OK");

    const sentQuote = service.sendQuote(orgId, "owner-1", quote.id);
    expect(sentQuote.status).toBe("sent");

    // Cannot create contract before acceptance
    expect(() => service.createContractFromQuote(orgId, "owner-1", { quoteId: quote.id })).toThrowError(AgencyError);

    const acceptedQuote = service.recordQuoteDecision(orgId, "owner-1", quote.id, "accepted");
    expect(acceptedQuote.status).toBe("accepted");

    const draftContract = service.createContractFromQuote(orgId, "sales-1", { quoteId: quote.id });
    expect(draftContract.status).toBe("draft");
    expect(draftContract.depositAmount).toBe(855);

    // Cannot sign before owner sign_contract approval
    expect(() => service.markContractSigned(orgId, "owner-1", draftContract.id)).toThrowError(AgencyError);

    const { approval: contractApproval } = service.requestContractApproval(orgId, "sales-1", draftContract.id, "Validation finale avant signature");
    service.decideApproval(orgId, "owner-1", contractApproval.id, "approved", contractApproval.payloadHash, "Signé par le propriétaire");

    const signed = service.markContractSigned(orgId, "owner-1", draftContract.id);
    expect(signed.status).toBe("signed");
    expect(signed.signedAt).toBe(tick);

    const paid = service.recordContractDeposit(orgId, "owner-1", signed.id, "paid", "VIR-2026-0042");
    expect(paid.depositStatus).toBe("paid");
    expect(paid.depositReference).toBe("VIR-2026-0042");

    // Tenant isolation & audit integrity
    const otherOrg = service.createOrganization({ name: "Autre Agence" }, "owner-2").id;
    expect(() => service.getQuote(otherOrg, "owner-2", quote.id)).toThrowError(AgencyError);
    expect(service.verifyAudit(orgId, "owner-1").valid).toBe(true);
  });
});
