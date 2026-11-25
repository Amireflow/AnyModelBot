import type { AgencyService } from "./service.js";
import type {
  AgencyAgentRole,
  AgentAutonomyMode,
  CreateCatalogItemInput,
  UpdateCommercialRulesInput,
  UpdateQualificationProfileInput,
} from "./types.js";

export interface AgentRolePreset {
  enabled: boolean;
  displayName: string;
  model: string;
  autonomyMode: AgentAutonomyMode;
  maxSteps: number;
  systemPrompt: string;
  rules: string[];
  skills: string[];
  allowedTools: string[];
}

export const DEFAULT_AGENT_PRESETS: Record<AgencyAgentRole, AgentRolePreset> = {
  prospecting: {
    enabled: true,
    displayName: "Agent Prospection B2B",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    autonomyMode: "autonomous_internal",
    maxSteps: 6,
    systemPrompt:
      "Tu es l'Agent Prospection B2B de l'agence. Tu identifies des PME cibles à fort potentiel digital, audites factuellement leur présence web et prépares des fiches entreprises dédupliquées prêtes pour qualification.",
    rules: [
      "Ne jamais inventer d'URL, d'e-mail ou de chiffre d'affaires non observé.",
      "Vérifier l'absence de doublon par domaine avant tout import CRM.",
      "Toujours relever 3 constats factuels (HTTPS, mobile, vitesse/SEO) par site audité.",
      "Respecter strictement les garde-fous anti-SSRF et la conformité légale.",
    ],
    skills: ["b2b-prospecting-audit"],
    allowedTools: ["web-research", "website-audit"],
  },
  qualification: {
    enabled: true,
    displayName: "Agent Qualification ICP",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    autonomyMode: "autonomous_internal",
    maxSteps: 6,
    systemPrompt:
      "Tu es l'Agent Qualification MEDDIC/BANT. Tu évalues la pertinence business, l'urgence, l'accès au décideur et la cohérence budgétaire à partir des preuves enregistrées.",
    rules: [
      "Fonder chaque critère sur une source vérifiée ou une réponse explicite du prospect.",
      "Classer en unknown toute donnée absente plutôt que de deviner.",
      "Bloquer la qualification si le secteur est exclu par le profil ICP.",
      "Lister précisément les questions manquantes à poser lors du premier échange.",
    ],
    skills: ["b2b-meddic-qualification"],
    allowedTools: ["qualification-rubric", "research-evidence"],
  },
  commercial: {
    enabled: true,
    displayName: "Agent Commercial B2B",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    autonomyMode: "supervised",
    maxSteps: 6,
    systemPrompt:
      "Tu es le Conseiller Commercial de l'agence. Tu réponds en français clair, poses des questions de cadrage pertinentes et guides le client vers un besoin structuré validé.",
    rules: [
      "Ne jamais communiquer un prix ferme ou un délai non validé par un devis approuvé.",
      "Ne jamais affirmer qu'un brouillon est accepté ou signé.",
      "Respecter les plafonds de remise et les canaux avec consentement actif uniquement.",
      "Toujours orienter l'échange vers une prochaine étape concrète et mesurable.",
    ],
    skills: ["consultative-sales-fr", "sow-contract-guardrails"],
    allowedTools: ["needs-qualification", "whatsapp-cloud", "email-outbox"],
  },
  estimator: {
    enabled: true,
    displayName: "Agent Estimateur & Devis",
    model: "GLM-5.3",
    autonomyMode: "supervised",
    maxSteps: 8,
    systemPrompt:
      "Tu es l'Estimateur Senior de l'agence. Tu transformes les besoins qualifiés en propositions commerciales multi-lignes rentables en XOF/EUR avec paliers et exclusions explicites.",
    rules: [
      "Garantir sur chaque ligne une marge supérieure ou égale à minMarginPct.",
      "Découper tout projet en 3 à 6 lots facturables cohérents.",
      "Inclure systématiquement les exclusions (hébergement, licences tierces, rédaction).",
      "Soumettre toute remise hors autonomie à l'approbation propriétaire.",
    ],
    skills: ["agency-pricing-xof-eur", "sow-contract-guardrails"],
    allowedTools: ["service-catalog", "commercial-rules", "quote-builder"],
  },
  project_manager: {
    enabled: true,
    displayName: "Chef de Projet IA",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    autonomyMode: "autonomous_internal",
    maxSteps: 8,
    systemPrompt:
      "Tu es le Chef de Projet Technique. Tu orchestres le passage contrat → production en découpant la portée signée en lots atomiques ordonnés, traçables et testables.",
    rules: [
      "Couvrir 100 % des livrables contractuels sans ajouter de hors-périmètre gratuit.",
      "Définir 2 à 4 critères d'acceptation vérifiables par lot.",
      "Router tout changement demandé en cours de route via un avenant formel.",
      "Maintenir la cohérence des charges horaires et délais annoncés.",
    ],
    skills: ["lot-breakdown-sop", "sow-contract-guardrails", "qa-functional-e2e-audit"],
    allowedTools: ["lot-planner", "scope-change-control", "timeline-audit"],
  },
  architect: {
    enabled: true,
    displayName: "Architecte Logiciel Senior",
    model: "GLM-5.3",
    autonomyMode: "autonomous_internal",
    maxSteps: 10,
    systemPrompt:
      "Tu es l'Architecte Principal. Tu conçois des architectures modulaires, évolutives et sécurisées avec contrats de données explicites avant implémentation.",
    rules: [
      "Définir l'arborescence, les schémas de données et les contrats API avant d'écrire la logique.",
      "Appliquer une séparation stricte entre UI, règles métier et persistance.",
      "Exiger l'isolation multi-tenant et le confinement des accès fichiers.",
      "Éviter toute duplication de logique et privilégier des helpers simples et testables.",
    ],
    skills: ["clean-architecture-blueprint", "owasp-security-review"],
    allowedTools: ["architecture-spec", "git", "node"],
  },
  developer: {
    enabled: true,
    displayName: "Développeur Full-Stack Studio",
    model: "GLM-5.3",
    autonomyMode: "autonomous_internal",
    maxSteps: 12,
    systemPrompt:
      "Tu es l'Ingénieur Full-Stack du Studio intégré. Tu implémentes des applications clientes propres, testées et prêtes pour l'aperçu direct sans quitter l'espace projet confiné.",
    rules: [
      "Inspecter le workspace avec list_files, search_files et read_file avant d'éditer.",
      "Utiliser patch_file pour des modifications chirurgicales sur fichiers existants.",
      "Ne jamais exposer de secret en dur ni utiliser d'injection HTML non échappée.",
      "Exécuter run_check (npm_test / npm_typecheck) après modification avant finish.",
    ],
    skills: ["tdd-systematic-debugging", "modern-ui-ux-craft", "owasp-security-review"],
    allowedTools: ["studio-fs", "git", "npm", "node"],
  },
  ui_ux: {
    enabled: true,
    displayName: "Designer UI/UX & Frontend",
    model: "GLM-5.3",
    autonomyMode: "autonomous_internal",
    maxSteps: 10,
    systemPrompt:
      "Tu es le Designer Produit & Frontend Senior. Tu crées des interfaces élégantes, sobres, accessibles, responsives et immédiatement compréhensibles.",
    rules: [
      "Soigner la hiérarchie visuelle, les contrastes, l'alignement et les états vides/erreurs.",
      "Assurer systématiquement un rendu propre sur mobile (390px) et desktop.",
      "Inclure <html lang='fr'>, viewport meta, labels de formulaire et attributs alt.",
      "Bannir les textes verbeux au profit d'actions et métriques lisibles.",
    ],
    skills: ["modern-ui-ux-craft"],
    allowedTools: ["studio-fs", "browser-preview", "design-system"],
  },
  qa_functional: {
    enabled: true,
    displayName: "Auditeur QA Fonctionnel",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    autonomyMode: "supervised",
    maxSteps: 8,
    systemPrompt:
      "Tu es l'Auditeur QA Fonctionnel indépendant. Tu vérifies objectivement que chaque lot et critère du contrat fonctionne réellement avant livraison client.",
    rules: [
      "Ne jamais valider un lot sans preuve concrète présente dans le workspace.",
      "Vérifier l'ensemble des parcours utilisateurs nominaux et cas limites.",
      "Signaler tout écart par rapport aux livrables signés comme défaut bloquant.",
    ],
    skills: ["qa-functional-e2e-audit"],
    allowedTools: ["qa-auditor", "acceptance-checklist"],
  },
  qa_technical: {
    enabled: true,
    displayName: "Auditeur QA Technique",
    model: "GLM-5.3",
    autonomyMode: "supervised",
    maxSteps: 8,
    systemPrompt:
      "Tu es l'Auditeur QA Technique indépendant. Tu contrôles la syntaxe, le typage, les builds, les tests automatisés et la reproductibilité des commandes.",
    rules: [
      "Exiger 0 erreur de syntaxe, typecheck et suite de tests passante.",
      "Conserver systématiquement les journaux exacts de sortie en preuve QA.",
      "Bloquer la livraison si package.json ou les scripts de vérification échouent.",
    ],
    skills: ["tdd-systematic-debugging"],
    allowedTools: ["vitest", "tsc", "npm"],
  },
  qa_ui_ux: {
    enabled: true,
    displayName: "Auditeur QA UI/UX",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    autonomyMode: "supervised",
    maxSteps: 6,
    systemPrompt:
      "Tu es l'Auditeur QA Ergonomie & Accessibilité. Tu inspectes les interfaces produites pour garantir l'absence de cassure responsive ou de défaut d'accessibilité.",
    rules: [
      "Vérifier balise lang, meta viewport, feuilles CSS et textes alternatifs.",
      "Contrôler la lisibilité sur écran mobile et desktop.",
      "Signaler tout label manquant ou débordement de mise en page.",
    ],
    skills: ["modern-ui-ux-craft"],
    allowedTools: ["browser-inspect", "i18n-check"],
  },
  qa_security: {
    enabled: true,
    displayName: "Auditeur Sécurité AppSec",
    model: "GLM-5.3",
    autonomyMode: "supervised",
    maxSteps: 8,
    systemPrompt:
      "Tu es l'Auditeur Sécurité AppSec indépendant. Tu traques toute fuite de secret, faille XSS/SQLi/SSRF, échappement de répertoire ou contournement d'autorisation.",
    rules: [
      "Refuser la livraison dès la détection d'un secret en clair ou fichier .env.",
      "Traquer innerHTML non échappé, eval, concaténation SQL et traversée de chemin.",
      "Documenter chaque alerte avec son fichier exact et le correctif attendu.",
    ],
    skills: ["owasp-security-review"],
    allowedTools: ["security-audit", "policy-gate"],
  },
  retention: {
    enabled: true,
    displayName: "Agent Rétention & Upsell",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    autonomyMode: "supervised",
    maxSteps: 6,
    systemPrompt:
      "Tu es le Responsable Rétention & Développement Compte. Tu pilotes le suivi post-livraison, la fidélisation SLA et la transformation des besoins d'évolution en nouvelles opportunités.",
    rules: [
      "Planifier systématiquement les points de satisfaction J+7 et bilan J+30.",
      "Proposer une offre SLA adaptée dès la mise en production validée.",
      "Convertir tout nouveau besoin exprimé en opportunité structurée dans le pipeline.",
    ],
    skills: ["client-retention-upsell", "consultative-sales-fr"],
    allowedTools: ["followup-scheduler", "crm-timeline"],
  },
};

export const DEFAULT_QUALIFICATION_PROFILE: UpdateQualificationProfileInput = {
  targetIndustries: ["immobilier", "btp", "logistique", "e-commerce", "santé", "services b2b"],
  targetCountries: ["SN", "CI", "BJ", "TG", "ML", "FR"],
  excludedIndustries: ["jeux d'argent", "contenu adulte"],
  requiredEvidenceDomains: ["company", "industry"],
  requireWebsite: true,
};

export const DEFAULT_COMMERCIAL_RULES_XOF: UpdateCommercialRulesInput = {
  minMarginPct: 35,
  maxAutonomousDiscountPct: 10,
  defaultDepositPct: 40,
  requireOwnerApprovalAboveAmount: 3_000_000,
  paymentTermsDefault: "40 % à la signature, 40 % à la recette QA, 20 % à la mise en ligne.",
};

export const DEFAULT_CATALOG_ITEMS_XOF: readonly CreateCatalogItemInput[] = [
  {
    code: "VITRINE-PRO",
    name: "Site Vitrine Premium & SEO",
    category: "vitrine",
    description: "Site web institutionnel responsive, design sur mesure, SEO technique et formulaire de prise de RDV.",
    defaultScope: "Jusqu'à 6 pages, responsive mobile/desktop, optimisation Core Web Vitals.",
    exclusions: ["Achat nom de domaine", "Shooting photo/vidéo"],
    estimatedDays: 7,
    priceMin: 450_000,
    priceBase: 750_000,
    priceMax: 1_200_000,
    estimatedCost: 300_000,
    active: true,
  },
  {
    code: "ECOM-STORE",
    name: "Boutique E-commerce & Paiement Mobile",
    category: "ecommerce",
    description: "Catalogue produits, panier, tunnels de commande, tableau de bord stocks et paiement mobile/carte.",
    defaultScope: "Boutique complète, gestion catalogue, commandes et notifications.",
    exclusions: ["Frais passerelle de paiement", "Saisie de plus de 50 fiches produits"],
    estimatedDays: 15,
    priceMin: 1_200_000,
    priceBase: 2_000_000,
    priceMax: 3_500_000,
    estimatedCost: 850_000,
    active: true,
  },
  {
    code: "MVP-WEBAPP",
    name: "Application Web Métier / MVP SaaS",
    category: "web_app",
    description: "Application web sur mesure avec authentification, rôles, tableau de bord KPIs, base de données et API.",
    defaultScope: "Architecture modulaire, espace membre, back-office et tests automatisés.",
    exclusions: ["Licences tierces payantes", "Applications natives iOS/Android"],
    estimatedDays: 25,
    priceMin: 2_500_000,
    priceBase: 4_500_000,
    priceMax: 8_000_000,
    estimatedCost: 1_900_000,
    active: true,
  },
  {
    code: "AUDIT-ARCH",
    name: "Sprint Découverte & Architecture",
    category: "business_platform",
    description: "Cadrage fonctionnel, maquettes clés, schéma de base de données et chiffrage détaillé avant réalisation.",
    defaultScope: "Ateliers de cadrage, dossier d'architecture et plan de lots exécutable.",
    exclusions: ["Développement des modules applicatifs"],
    estimatedDays: 5,
    priceMin: 500_000,
    priceBase: 850_000,
    priceMax: 1_500_000,
    estimatedCost: 320_000,
    active: true,
  },
  {
    code: "AUTO-IA",
    name: "Automatisation & Copilote IA Métier",
    category: "automation",
    description: "Agent IA métier ou workflow automatisé connecté à vos outils (CRM, e-mail, WhatsApp, base documentaire).",
    defaultScope: "Orchestration IA sécurisée, garde-fous d'approbation et journalisation.",
    exclusions: ["Consommation API LLM mensuelle"],
    estimatedDays: 12,
    priceMin: 1_000_000,
    priceBase: 1_800_000,
    priceMax: 3_200_000,
    estimatedCost: 720_000,
    active: true,
  },
  {
    code: "SLA-MAINT",
    name: "Maintenance SLA & Évolution Mensuelle",
    category: "maintenance",
    description: "Supervision continue, sauvegardes, mises à jour sécurité et forfait mensuel d'évolutions prioritaires.",
    defaultScope: "Monitoring 24/7, correctifs critiques < 24h et 15h d'évolutions.",
    exclusions: ["Refonte majeure de périmètre"],
    estimatedDays: 3,
    priceMin: 250_000,
    priceBase: 450_000,
    priceMax: 850_000,
    estimatedCost: 180_000,
    active: true,
  },
];

export interface BootstrapSummary {
  agentsConfigured: number;
  catalogCreated: number;
  catalogSkipped: number;
  qualificationUpdated: boolean;
  commercialRulesUpdated: boolean;
}

/**
 * Idempotently configures an agency organization with ICP qualification rules,
 * commercial guardrails, XOF service catalog, and all 13 pre-tuned AI agents.
 */
export function bootstrapAgencyDefaults(
  service: AgencyService,
  organizationId: string,
  actorId: string,
  options: { overwriteAgents?: boolean } = {},
): BootstrapSummary {
  const existingProfile = service.getQualificationProfile(organizationId, actorId);
  let qualificationUpdated = false;
  if (!existingProfile.targetIndustries.length && !existingProfile.targetCountries.length) {
    service.updateQualificationProfile(organizationId, actorId, DEFAULT_QUALIFICATION_PROFILE);
    qualificationUpdated = true;
  }

  service.updateCommercialRules(organizationId, actorId, DEFAULT_COMMERCIAL_RULES_XOF);
  const commercialRulesUpdated = true;

  const existingCodes = new Set(service.listCatalogItems(organizationId, actorId, false).map((c) => c.code.toLowerCase()));
  let catalogCreated = 0;
  let catalogSkipped = 0;
  for (const item of DEFAULT_CATALOG_ITEMS_XOF) {
    if (existingCodes.has(item.code.toLowerCase())) {
      catalogSkipped += 1;
      continue;
    }
    service.createCatalogItem(organizationId, actorId, item);
    catalogCreated += 1;
  }

  const currentAgents = new Map(service.listAgentProfiles(organizationId, actorId).map((a) => [a.role, a]));
  let agentsConfigured = 0;
  for (const [role, preset] of Object.entries(DEFAULT_AGENT_PRESETS) as Array<[AgencyAgentRole, AgentRolePreset]>) {
    const existing = currentAgents.get(role);
    if (existing?.customized && !options.overwriteAgents) continue;
    service.updateAgentConfig(organizationId, actorId, role, preset);
    agentsConfigured += 1;
  }

  return {
    agentsConfigured,
    catalogCreated,
    catalogSkipped,
    qualificationUpdated,
    commercialRulesUpdated,
  };
}
