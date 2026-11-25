import type { ModelClient } from "../llm/client.js";
import { AgencyError } from "./errors.js";
import type {
  CommercialConversation,
  CommercialRules,
  Company,
  ConversationMessage,
  Lead,
  NeedsQualification,
  Organization,
  Quote,
} from "./types.js";

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

  const systemPrompt = en
    ? `You are a commercial advisor for ${input.organization.name}. Draft one concise, polite client reply that respects agency guardrails: never invent unapproved prices or timelines, never claim a draft quote or contract is already approved/signed, max autonomous discount is ${input.rules.maxAutonomousDiscountPct}%, minimum margin is ${input.rules.minMarginPct}%.`
    : `Tu es conseiller commercial pour ${input.organization.name}. Rédige une proposition de réponse client concise et professionnelle en français en respectant strictement les garde-fous : n'invente aucun tarif ou délai non validé, ne prétends jamais qu'un devis ou contrat en brouillon est approuvé/signé, remise autonome max ${input.rules.maxAutonomousDiscountPct} %, marge minimale ${input.rules.minMarginPct} %.`;

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
