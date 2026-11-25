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

export interface CopilotAttachment {
  name: string;
  mimeType: string;
  size: number;
  textContent?: string;
}

export interface CopilotActionLog {
  step: number;
  tool: string;
  summary: string;
  ok: boolean;
  data?: unknown;
}

export type CopilotToolExecutor = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; summary: string; data?: unknown }>;

function parseCopilotToolCall(raw: string): { tool: string; args: Record<string, unknown> } | null {
  const trimmed = raw.trim();
  const unwrapped = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
    : trimmed;
  if (!unwrapped.startsWith("{") || !unwrapped.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(unwrapped) as Record<string, unknown>;
    if (typeof parsed.tool === "string" && parsed.tool.trim()) {
      const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
        ? (parsed.args as Record<string, unknown>)
        : {};
      return { tool: parsed.tool.trim(), args };
    }
  } catch {
    return null;
  }
  return null;
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
  attachments?: readonly CopilotAttachment[];
  history?: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  executeTool?: CopilotToolExecutor;
  maxSteps?: number;
  modelClient?: ModelClient;
  defaultModel?: string;
  hasLlmEndpoint?: boolean;
}): Promise<{ answer: string; mode: "llm" | "deterministic"; model?: string; actions: CopilotActionLog[] }> {
  const q = input.question.trim();
  const attachments = (input.attachments ?? []).slice(0, 5);
  if (!q && attachments.length === 0) {
    throw new AgencyError("VALIDATION_ERROR", "Copilot question or attachment is required");
  }
  const effectiveQuestion = q || `Analyse les ${attachments.length} fichier(s) joint(s) et propose les actions concrètes adaptées.`;
  const actions: CopilotActionLog[] = [];

  const contextLines = [
    `Organisation: ${input.organization.name} (${input.organization.currency})`,
    `Onglet actif: ${input.tab}`,
    `Pipeline: ${input.dashboard.companyCount} entreprises, ${input.dashboard.leadCount} prospects (${input.dashboard.openLeadCount} ouverts, ${input.dashboard.wonLeadCount} gagnés)`,
    `KPIs: CA signé=${input.metrics.signedRevenue}, Pipeline=${input.metrics.pipelineValue}, Acomptes=${input.metrics.collectedDeposits}, Approbations en attente=${input.metrics.pendingApprovalsCount}, Projets livrés=${input.metrics.projectsDelivered}`,
  ];
  if (input.company) contextLines.push(`Entreprise sélectionnée: ${input.company.name} (id=${input.company.id}, secteur=${input.company.industry || "—"}, site=${input.company.website || "sans site"})`);
  if (input.lead) contextLines.push(`Prospect sélectionné: ${input.lead.id} (stage=${input.lead.stage})`);
  if (input.needs) contextLines.push(`Besoins: ${input.needs.solutionType} — ${input.needs.problemStatement}`);
  if (input.quotes?.length) contextLines.push(`Devis: ${input.quotes.map((x) => `${x.id} v${x.version} ${x.status} ${x.netTotal}`).join(" | ")}`);
  if (input.project) contextLines.push(`Projet actif: ${input.project.title} (id=${input.project.id}, statut=${input.project.status}), lots=${input.lots?.length ?? 0}, QA=${input.qaChecks?.length ?? 0}`);

  const attachmentBlock = attachments.length
    ? "\n\nPièces jointes fournies par l'utilisateur :\n" +
      attachments.map((att, idx) => {
        const body = (att.textContent || "").trim().slice(0, 24_000);
        return `### Fichier ${idx + 1}: ${att.name} (${att.mimeType}, ${att.size} octets)\n${body || "(Contenu binaire sans texte extrait)"}`;
      }).join("\n\n")
    : "";

  if (input.hasLlmEndpoint && input.modelClient) {
    let model = input.defaultModel?.trim() || "";
    if (!model) model = (await input.modelClient.listModels().catch(() => []))[0] ?? "";
    if (model) {
      const toolGuide = input.executeTool
        ? [
            "",
            "Capacités d'action gouvernées :",
            "Quand l'utilisateur demande d'agir sur le CRM, la prospection, la qualification, les devis brouillons, les missions, la QA ou le Studio d'un projet, tu PEUX exécuter des outils en répondant UNIQUEMENT avec un objet JSON strict :",
            `{"tool":"<nom>","args":{...}}`,
            "Outils disponibles :",
            `- list_crm_summary: {"scope":"companies"|"leads"|"quotes"|"contracts"|"projects"|"catalog"}`,
            `- prospect_web: {"query":string,"industry"?:string,"city"?:string,"countryCode"?:string,"maxResults"?:number}`,
            `- import_companies: {"companies":[{"name":string,"website"?:string,"industry"?:string,"city"?:string,"countryCode"?:string}]}`,
            `- audit_website: {"companyId"?:string,"url"?:string}`,
            `- create_contact: {"companyId":string,"displayName":string,"role"?:string,"email"?:string,"phone"?:string}`,
            `- create_lead: {"companyId":string,"contactId"?:string,"source"?:string,"notes"?:string}`,
            `- qualify_needs: {"leadId":string,"problemStatement":string,"solutionType":"vitrine"|"ecommerce"|"web_app"|"mobile_app"|"business_platform"|"internal_tool"|"automation"|"maintenance","mustHaveFeatures"?:string[],"desiredTimeline"?:string,"budgetMin"?:number,"budgetMax"?:number}`,
            `- create_quote_draft: {"leadId":string,"title":string,"tier"?:"essential"|"standard"|"advanced"|"custom","discountPct"?:number,"lines":[{"label":string,"quantity":number,"unitPrice":number,"unitCost":number,"estimatedDays":number}]}`,
            `- create_mission: {"title":string,"agentRole":"prospecting"|"qualification"|"commercial"|"estimator"|"project_manager"|"architect"|"developer"|"ui_ux"|"qa_functional"|"qa_technical"|"qa_ui_ux"|"qa_security"|"retention","objective"?:string,"projectId"?:string,"leadId"?:string}`,
            `- create_project: {"title":string,"clientName"?:string,"companyId"?:string,"technicalSpecs"?:string,"targetStack"?:string[],"budgetAmount"?:number,"estimatedDays"?:number,"template"?:"vitrine-html"|"webapp-node-preact"|"api-node-ts"|"saas-dashboard-app"|"ecommerce-storefront","includeAttachedFiles"?:boolean}`,
            `- run_qa_audit: {"projectId":string}`,
            `- write_studio_file: {"projectId":string,"path":string,"content":string}`,
            "Règles : n'envoie jamais d'e-mail/WhatsApp ni ne signe/déploie sans approbation humaine. Dès que tu as assez d'informations ou terminé les actions, réponds en Markdown français clair et structuré (tableaux GFM, listes, gras).",
          ].join("\n")
        : "";

      const systemPrompt = [
        "Tu es le Copilote IA ultra-compétent d'AnyModelBot Agence.",
        "Réponds en français de façon concise, factuelle, professionnelle et orientée action à partir du contexte réel et des fichiers joints.",
        "Ne fabrique jamais de chiffres, de résultats d'audit ni d'approbations.",
        toolGuide,
      ].filter(Boolean).join("\n");

      const priorHistory = (input.history ?? [])
        .slice(-10)
        .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string" && h.text.trim())
        .map((h) => ({ role: h.role, content: h.text.slice(0, 4000) }));

      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: systemPrompt },
        ...priorHistory,
        {
          role: "user",
          content: `Contexte:\n${contextLines.join("\n")}${attachmentBlock}\n\nDemande utilisateur:\n${effectiveQuestion}`,
        },
      ];

      const executeTool = input.executeTool;
      const maxSteps = Math.max(1, Math.min(10, Math.round(input.maxSteps ?? 6)));
      try {
        for (let step = 1; step <= maxSteps; step++) {
          const reply = await input.modelClient.streamChat({ model, messages }, () => {});
          const toolCall = executeTool ? parseCopilotToolCall(reply) : null;
          if (!toolCall || !executeTool) {
            if (reply.trim()) {
              return { answer: reply.trim(), mode: "llm", model, actions };
            }
            break;
          }
          messages.push({ role: "assistant", content: reply });
          const exec = await executeTool(toolCall.tool, toolCall.args);
          actions.push({ step, tool: toolCall.tool, summary: exec.summary, ok: exec.ok, data: exec.data });
          messages.push({
            role: "user",
            content: `Résultat outil "${toolCall.tool}" (ok=${exec.ok}) : ${exec.summary}\n${exec.data ? JSON.stringify(exec.data).slice(0, 6000) : ""}`,
          });
        }

        if (actions.length > 0) {
          messages.push({
            role: "user",
            content: "Résume maintenant en français (Markdown propre avec tableaux/puces) les actions exécutées et les résultats constatés.",
          });
          const summaryReply = await input.modelClient.streamChat({ model, messages }, () => {});
          if (summaryReply.trim()) {
            return { answer: summaryReply.trim(), mode: "llm", model, actions };
          }
        }
      } catch {
        /* fallback cleanly below */
      }
    }
  }

  const nextSteps: string[] = [];
  if (attachments.length > 0) {
    nextSteps.push(
      `Fichiers reçus (${attachments.length}) : ${attachments.map((a) => `${a.name} (${Math.round(a.size / 1024)} Ko)`).join(", ")}. Activez un modèle IA dans Paramètres pour analyser leur contenu et déclencher les actions automatiques.`,
    );
  }
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
    actions,
  };
}
