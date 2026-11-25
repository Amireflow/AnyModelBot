import type { ModelClient } from "../llm/client.js";
import { calculateQuoteTotals, marginFloorPrice } from "./commercial.js";
import { AgencyError } from "./errors.js";
import type {
  AgencyDashboard,
  AgencyMetrics,
  CommercialConversation,
  CommercialRules,
  Company,
  ConversationMessage,
  Lead,
  NeedsQualification,
  Organization,
  Project,
  ProjectLot,
  QaCheck,
  Quote,
  QuoteLineItem,
  ServiceCatalogItem,
  SolutionType,
} from "./types.js";

const SOLUTION_TYPES: readonly SolutionType[] = [
  "vitrine", "ecommerce", "web_app", "mobile_app",
  "business_platform", "internal_tool", "automation", "maintenance",
];

function formatAgentDirective(instructions?: string, rules?: readonly string[]): string {
  const parts: string[] = [];
  if (instructions?.trim()) parts.push(`Configured instructions: ${instructions.trim()}`);
  if (rules?.length) parts.push(`Configured rules:\n${rules.map((r) => `- ${r}`).join("\n")}`);
  return parts.length ? `\n${parts.join("\n")}` : "";
}

export async function suggestCommercialReply(input: {
  organization: Organization;
  company?: Company;
  lead: Lead;
  conversation: CommercialConversation;
  messages: readonly ConversationMessage[];
  needs?: NeedsQualification;
  quotes: readonly Quote[];
  rules: CommercialRules;
  modelClient?: ModelClient;
  defaultModel?: string;
  hasLlmEndpoint?: boolean;
  lang?: string;
  agentInstructions?: string;
  agentRules?: readonly string[];
}): Promise<{ draft: string; model: string; guardrailsNote: string }> {
  if (input.conversation.status === "opted_out") {
    throw new AgencyError("CONFLICT", "This conversation has opted out; commercial drafting is blocked");
  }
  if (!input.hasLlmEndpoint || !input.modelClient) {
    throw new AgencyError("VALIDATION_ERROR", "No AI model endpoint is configured in Settings");
  }

  let model = input.defaultModel?.trim() || "";
  if (!model) {
    const available = await input.modelClient.listModels();
    model = available[0] ?? "";
  }
  if (!model) {
    throw new AgencyError("VALIDATION_ERROR", "No available AI models returned by the configured endpoint");
  }

  const en = (input.lang ?? "fr").startsWith("en");
  const recentMessages = input.messages.slice(-12).map((m) => `- [${m.direction}] ${m.body}`).join("\n");
  const quoteSummary = input.quotes
    .map((q) => `- v${q.version} "${q.title}" (${q.status}): ${q.netTotal} ${q.currency}, ${q.deliveryDays}d`)
    .join("\n");

  const baseSystemPrompt = en
    ? `You are a commercial advisor for ${input.organization.name}. Draft one concise, polite client reply that respects agency guardrails: never invent unapproved prices or timelines, never claim a draft quote or contract is already approved/signed, max autonomous discount is ${input.rules.maxAutonomousDiscountPct}%, minimum margin is ${input.rules.minMarginPct}%.`
    : `Tu es conseiller commercial pour ${input.organization.name}. Rédige une proposition de réponse client concise et professionnelle en français en respectant strictement les garde-fous : n'invente aucun tarif ou délai non validé, ne prétends jamais qu'un devis ou contrat en brouillon est approuvé/signé, remise autonome max ${input.rules.maxAutonomousDiscountPct} %, marge minimale ${input.rules.minMarginPct} %.`;
  const systemPrompt = baseSystemPrompt + formatAgentDirective(input.agentInstructions, input.agentRules);

  const userPrompt = [
    `Client: ${input.company?.name || input.lead.companyId} (stage=${input.lead.stage})`,
    `Subject: ${input.conversation.subject} (channel=${input.conversation.channel}, status=${input.conversation.status})`,
    input.needs
      ? `Needs: ${input.needs.problemStatement} | Solution: ${input.needs.solutionType} | Budget: ${input.needs.budgetMin}-${input.needs.budgetMax}`
      : "Needs: not captured yet",
    quoteSummary ? `Quotes:\n${quoteSummary}` : "Quotes: none",
    recentMessages ? `Recent messages:\n${recentMessages}` : "Recent messages: none",
    en ? "Draft only the reply message text." : "Rédige uniquement le texte de réponse prêt à relire avant envoi.",
  ].join("\n\n");

  const raw = await input.modelClient.streamChat(
    {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    },
    () => {},
  );

  const draft = raw.trim();
  if (!draft) {
    throw new AgencyError("VALIDATION_ERROR", "AI model returned an empty reply draft");
  }

  const guardrailsNote = en
    ? `Draft generated (${model}). Review before sending — max autonomous discount: ${input.rules.maxAutonomousDiscountPct}%.`
    : `Brouillon généré (${model}). Relisez avant envoi — remise autonome max : ${input.rules.maxAutonomousDiscountPct} %.`;

  return { draft, model, guardrailsNote };
}

function heuristicNeedsFromMessages(
  messages: readonly ConversationMessage[],
  company?: Company,
  subject = "",
): {
  problemStatement: string;
  targetUsers: string;
  solutionType: SolutionType;
  mustHaveFeatures: string[];
  desiredTimeline: string;
  budgetMin: number;
  budgetMax: number;
  unknowns: string[];
} {
  const joined = [subject, ...messages.map((m) => m.body)].join("\n").trim();
  const lower = joined.toLowerCase();
  let solutionType: SolutionType = "web_app";
  if (/e-?commerce|boutique|panier|paiement|catalogue/.test(lower)) solutionType = "ecommerce";
  else if (/vitrine|site web|landing|présentation/.test(lower)) solutionType = "vitrine";
  else if (/mobile|ios|android|flutter|react native/.test(lower)) solutionType = "mobile_app";
  else if (/automatis|workflow|n8n|zapier|webhook/.test(lower)) solutionType = "automation";
  else if (/maintenance|support|correctif|tma/.test(lower)) solutionType = "maintenance";
  else if (/erp|crm|plateforme|portail/.test(lower)) solutionType = "business_platform";

  const features: string[] = [];
  if (/auth|connexion|compte|login/.test(lower)) features.push("Authentification utilisateurs");
  if (/paiement|stripe|wave|orange money|factur/.test(lower)) features.push("Paiement & facturation");
  if (/dashboard|tableau de bord|kpi|statistique/.test(lower)) features.push("Tableau de bord");
  if (/admin|gestion|back-?office/.test(lower)) features.push("Administration");
  if (!features.length) features.push("Socle fonctionnel principal", "Interface responsive");

  const nums = [...joined.matchAll(/\b(\d{3,7})\b/g)].map((m) => Number(m[1])).filter((n) => n >= 100);
  const budgetMin = nums.length ? Math.min(...nums) : 0;
  const budgetMax = nums.length > 1 ? Math.max(...nums) : budgetMin;

  return {
    problemStatement: joined.slice(0, 600) || `Besoin numérique pour ${company?.name || "le client"}`,
    targetUsers: "Utilisateurs finaux et équipe interne",
    solutionType,
    mustHaveFeatures: features,
    desiredTimeline: /\b(\d+\s*(?:semaines?|mois|jours?))\b/i.exec(joined)?.[1] ?? "À préciser",
    budgetMin,
    budgetMax,
    unknowns: ["Contraintes d'hébergement exactes", "Contenus et accès disponibles"],
  };
}

export async function extractNeedsFromConversation(input: {
  organization: Organization;
  company?: Company;
  lead: Lead;
  conversation: CommercialConversation;
  messages: readonly ConversationMessage[];
  modelClient?: ModelClient;
  defaultModel?: string;
  hasLlmEndpoint?: boolean;
  agentInstructions?: string;
  agentRules?: readonly string[];
}): Promise<{
  extracted: ReturnType<typeof heuristicNeedsFromMessages>;
  mode: "llm" | "heuristic";
  model?: string;
}> {
  const fallback = heuristicNeedsFromMessages(input.messages, input.company, input.conversation.subject);
  if (!input.hasLlmEndpoint || !input.modelClient || input.messages.length === 0) {
    return { extracted: fallback, mode: "heuristic" };
  }

  let model = input.defaultModel?.trim() || "";
  if (!model) model = (await input.modelClient.listModels().catch(() => []))[0] ?? "";
  if (!model) return { extracted: fallback, mode: "heuristic" };

  try {
    const transcript = input.messages.slice(-20).map((m) => `[${m.direction}] ${m.body}`).join("\n");
    const raw = await input.modelClient.streamChat(
      {
        model,
        messages: [
          {
            role: "system",
            content: `Extract structured client needs from the commercial conversation for ${input.organization.name}. Return ONLY valid JSON with keys: problemStatement (string), targetUsers (string), solutionType (${SOLUTION_TYPES.join("|")}), mustHaveFeatures (string[]), desiredTimeline (string), budgetMin (number), budgetMax (number), unknowns (string[]). Never invent confirmed facts; put missing details in unknowns.${formatAgentDirective(input.agentInstructions, input.agentRules)}`,
          },
          {
            role: "user",
            content: `Company: ${input.company?.name || input.lead.companyId}\nSubject: ${input.conversation.subject}\nMessages:\n${transcript}`,
          },
        ],
      },
      () => {},
    );
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as Record<string, unknown>;
    const solutionType = SOLUTION_TYPES.includes(parsed.solutionType as SolutionType)
      ? (parsed.solutionType as SolutionType)
      : fallback.solutionType;
    const budgetMin = Math.max(0, Number(parsed.budgetMin) || 0);
    const budgetMax = Math.max(budgetMin, Number(parsed.budgetMax) || budgetMin);
    return {
      extracted: {
        problemStatement: String(parsed.problemStatement || fallback.problemStatement).slice(0, 2000),
        targetUsers: String(parsed.targetUsers || fallback.targetUsers).slice(0, 500),
        solutionType,
        mustHaveFeatures: Array.isArray(parsed.mustHaveFeatures)
          ? parsed.mustHaveFeatures.map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 15)
          : fallback.mustHaveFeatures,
        desiredTimeline: String(parsed.desiredTimeline || fallback.desiredTimeline).slice(0, 120),
        budgetMin,
        budgetMax,
        unknowns: Array.isArray(parsed.unknowns)
          ? parsed.unknowns.map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 10)
          : fallback.unknowns,
      },
      mode: "llm",
      model,
    };
  } catch {
    return { extracted: fallback, mode: "heuristic" };
  }
}

export async function estimateQuoteFromNeeds(input: {
  organization: Organization;
  company?: Company;
  lead: Lead;
  needs?: NeedsQualification;
  catalog: readonly ServiceCatalogItem[];
  rules: CommercialRules;
  modelClient?: ModelClient;
  defaultModel?: string;
  hasLlmEndpoint?: boolean;
  agentInstructions?: string;
  agentRules?: readonly string[];
}): Promise<{
  title: string;
  tier: "essential" | "standard" | "advanced";
  lines: QuoteLineItem[];
  exclusions: string[];
  rationale: string;
  mode: "llm" | "catalog";
}> {
  const activeCatalog = input.catalog.filter((c) => c.active);
  const matched =
    activeCatalog.find((c) => c.category === input.needs?.solutionType) ?? activeCatalog[0];

  const buildFallback = () => {
    const basePrice = matched?.priceBase ?? 2500;
    const baseCost = matched?.estimatedCost ?? 1200;
    const baseDays = matched?.estimatedDays ?? 10;
    const features = input.needs?.mustHaveFeatures?.length ? input.needs.mustHaveFeatures : ["Architecture & UX", "Développement cœur", "Tests & mise en ligne"];
    const count = Math.min(4, features.length);
    const lines: QuoteLineItem[] = features.slice(0, 4).map((feat, i) => {
      const weight = i === 0 ? 0.35 : 0.65 / Math.max(1, count - 1);
      const cost = Math.max(100, Math.round(baseCost * weight));
      const minP = marginFloorPrice(cost, input.rules.minMarginPct);
      const price = Math.max(minP, Math.round(basePrice * weight));
      return {
        label: feat.slice(0, 120),
        quantity: 1,
        unitPrice: price,
        unitCost: cost,
        estimatedDays: Math.max(1, Math.round(baseDays * weight)),
      };
    });
    return {
      title: `Proposition — ${matched?.name || input.company?.name || "Projet numérique"}`,
      tier: "standard" as const,
      lines,
      exclusions: matched?.exclusions?.length ? [...matched.exclusions] : ["Hébergement et licences tierces"],
      rationale: matched
        ? `Estimation basée sur le service "${matched.name}" et la marge minimale de ${input.rules.minMarginPct} %.`
        : `Estimation standard respectant la marge minimale de ${input.rules.minMarginPct} %.`,
      mode: "catalog" as const,
    };
  };

  if (!input.hasLlmEndpoint || !input.modelClient || !input.needs) {
    return buildFallback();
  }

  let model = input.defaultModel?.trim() || "";
  if (!model) model = (await input.modelClient.listModels().catch(() => []))[0] ?? "";
  if (!model) return buildFallback();

  try {
    const raw = await input.modelClient.streamChat(
      {
        model,
        messages: [
          {
            role: "system",
            content: `You are an agency estimator for ${input.organization.name} (currency=${input.organization.currency}, minMarginPct=${input.rules.minMarginPct}%). Return ONLY valid JSON: {title:string, tier:"essential"|"standard"|"advanced", lines:[{label:string,description?:string,quantity:number,unitPrice:number,unitCost:number,estimatedDays:number}], exclusions:string[], rationale:string}. Ensure every line yields margin >= ${input.rules.minMarginPct}%.${formatAgentDirective(input.agentInstructions, input.agentRules)}`,
          },
          {
            role: "user",
            content: `Needs: ${JSON.stringify(input.needs)}\nCatalog reference: ${JSON.stringify(activeCatalog.slice(0, 6).map((c) => ({ code: c.code, name: c.name, category: c.category, priceBase: c.priceBase, cost: c.estimatedCost, days: c.estimatedDays })))}`,
          },
        ],
      },
      () => {},
    );
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as Record<string, unknown>;
    const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
    if (!rawLines.length) return buildFallback();
    const lines: QuoteLineItem[] = rawLines.slice(0, 12).map((l: any, idx) => {
      const unitCost = Math.max(0, Number(l.unitCost) || 300);
      const floor = marginFloorPrice(unitCost, input.rules.minMarginPct);
      const unitPrice = Math.max(floor, Number(l.unitPrice) || floor);
      return {
        label: String(l.label || `Lot ${idx + 1}`).slice(0, 140),
        ...(l.description ? { description: String(l.description).slice(0, 300) } : {}),
        quantity: Math.max(1, Number(l.quantity) || 1),
        unitPrice,
        unitCost,
        estimatedDays: Math.max(1, Number(l.estimatedDays) || 2),
      };
    });
    calculateQuoteTotals(lines, 0, 15);
    const tier = ["essential", "standard", "advanced"].includes(String(parsed.tier))
      ? (parsed.tier as "essential" | "standard" | "advanced")
      : "standard";
    return {
      title: String(parsed.title || `Devis — ${input.company?.name || "Client"}`).slice(0, 200),
      tier,
      lines,
      exclusions: Array.isArray(parsed.exclusions) ? parsed.exclusions.map((e) => String(e).slice(0, 200)).filter(Boolean) : [],
      rationale: String(parsed.rationale || `Devis estimé via ${model}`).slice(0, 500),
      mode: "llm",
    };
  } catch {
    return buildFallback();
  }
}

export async function runAgencyCopilot(input: {
  organization: Organization;
  dashboard: AgencyDashboard;
  metrics: AgencyMetrics;
  tab: string;
  question: string;
  company?: Company;
  lead?: Lead;
  needs?: NeedsQualification;
  quotes?: readonly Quote[];
  project?: Project;
  lots?: readonly ProjectLot[];
  qaChecks?: readonly QaCheck[];
  modelClient?: ModelClient;
  defaultModel?: string;
  hasLlmEndpoint?: boolean;
}): Promise<{ answer: string; mode: "llm" | "deterministic"; model?: string }> {
  const q = input.question.trim();
  if (!q) throw new AgencyError("VALIDATION_ERROR", "Copilot question is required");

  const contextLines = [
    `Organisation: ${input.organization.name} (${input.organization.currency})`,
    `Onglet actif: ${input.tab}`,
    `Pipeline: ${input.dashboard.companyCount} entreprises, ${input.dashboard.leadCount} prospects (${input.dashboard.openLeadCount} ouverts, ${input.dashboard.wonLeadCount} gagnés)`,
    `KPIs: CA signé=${input.metrics.signedRevenue}, Pipeline=${input.metrics.pipelineValue}, Acomptes=${input.metrics.collectedDeposits}, Approbations en attente=${input.metrics.pendingApprovalsCount}, Projets livrés=${input.metrics.projectsDelivered}`,
  ];
  if (input.company) contextLines.push(`Entreprise sélectionnée: ${input.company.name} (${input.company.industry || "—"}, ${input.company.website || "sans site"})`);
  if (input.lead) contextLines.push(`Prospect sélectionné: ${input.lead.id} (stage=${input.lead.stage})`);
  if (input.needs) contextLines.push(`Besoins: ${input.needs.solutionType} — ${input.needs.problemStatement}`);
  if (input.quotes?.length) contextLines.push(`Devis: ${input.quotes.map((x) => `v${x.version} ${x.status} ${x.netTotal}`).join(" | ")}`);
  if (input.project) contextLines.push(`Projet actif: ${input.project.title} (${input.project.status}), lots=${input.lots?.length ?? 0}, QA=${input.qaChecks?.length ?? 0}`);

  if (input.hasLlmEndpoint && input.modelClient) {
    let model = input.defaultModel?.trim() || "";
    if (!model) model = (await input.modelClient.listModels().catch(() => []))[0] ?? "";
    if (model) {
      try {
        const answer = await input.modelClient.streamChat(
          {
            model,
            messages: [
              {
                role: "system",
                content: "Tu es le Copilote IA d'AnyModelBot Agence. Réponds en français de façon concise, factuelle et orientée action à partir du contexte réel ci-dessous. Ne fabrique jamais de chiffres ni d'approbations.",
              },
              {
                role: "user",
                content: `Contexte:\n${contextLines.join("\n")}\n\nQuestion:\n${q}`,
              },
            ],
          },
          () => {},
        );
        if (answer.trim()) return { answer: answer.trim(), mode: "llm", model };
      } catch {
        /* fallback cleanly below */
      }
    }
  }

  const nextSteps: string[] = [];
  if (input.metrics.pendingApprovalsCount > 0) {
    nextSteps.push(`Valider ${input.metrics.pendingApprovalsCount} approbation(s) en attente dans Opérations.`);
  }
  if (input.company && !input.company.website) {
    nextSteps.push(`Renseigner ou auditer le site web de ${input.company.name}.`);
  }
  if (input.lead && !input.needs) {
    nextSteps.push(`Compléter la qualification des besoins pour ce prospect avant d'émettre un devis.`);
  }
  if (input.project && (input.lots?.length ?? 0) === 0) {
    nextSteps.push(`Générer les lots du projet "${input.project.title}" puis lancer l'audit QA 4 axes.`);
  }
  if (nextSteps.length === 0) {
    nextSteps.push("Prospecter de nouvelles entreprises, qualifier les opportunités ouvertes ou vérifier l'audit QA des projets en cours.");
  }

  return {
    answer: `${contextLines.join("\n")}\n\nRecommandations immédiates :\n- ${nextSteps.join("\n- ")}`,
    mode: "deterministic",
  };
}
