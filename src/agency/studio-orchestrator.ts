/**
 * Conversational multi-subagent orchestrator for AnyModelBot Studio.
 *
 * Replaces rigid site-template selection with a Lovable/Bolt-style iterative loop:
 * 1. Derives architecture, branding, copy, stack, and features strictly from the project's
 *    BRIEF.md, docs/CAHIER-DES-CHARGES.md, docs/sources/* files, and user discussion.
 * 2. Plans & discusses changes (`mode: "plan"`) before touching code, producing a structured
 *    task breakdown assigned to specialized subagents (architect, ui_ux, frontend, backend, qa).
 * 3. Executes builds/adjustments (`mode: "build"`) via specialist subagents running inside
 *    the confined project workspace with Git snapshots before each build and real-time SSE events.
 * 4. Persists per-project conversation history + active plan on disk so reloads keep full state.
 */
import crypto from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelClient } from "../llm/client.js";
import { AgencyError } from "./errors.js";
import {
  createStudioSnapshot,
  listWorkspaceFiles,
  readWorkspaceFile,
  runStudioAiAgent,
  type StudioAgentStep,
} from "./studio.js";
import type { AgencyAgentRole, Project } from "./types.js";
import { initProjectWorkspace } from "./workspace-runner.js";

export type StudioSubagentId = "architect" | "ui_ux" | "frontend" | "backend" | "qa";

export interface StudioSubagentSpec {
  id: StudioSubagentId;
  agencyRole: AgencyAgentRole;
  focus: string;
}

export const STUDIO_SUBAGENTS: readonly StudioSubagentSpec[] = [
  {
    id: "architect",
    agencyRole: "architect",
    focus: "Analyse du cahier des charges, architecture modulaire, choix de stack et plan d'exécution",
  },
  {
    id: "ui_ux",
    agencyRole: "ui_ux",
    focus: "Identité visuelle sur mesure, système de design (CSS tokens), typographie, mise en page et responsive",
  },
  {
    id: "frontend",
    agencyRole: "developer",
    focus: "Interfaces interactives, composants, formulaires, états dynamiques, navigation et micro-interactions",
  },
  {
    id: "backend",
    agencyRole: "developer",
    focus: "Endpoints API, logique métier, persistance des données, validation et scripts serveur",
  },
  {
    id: "qa",
    agencyRole: "qa_technical",
    focus: "Tests automatisés (npm_test/typecheck/build), audit HTML/CSS/JS, accessibilité et correction de bugs",
  },
];

const SUBAGENT_SPEC_MAP = new Map<StudioSubagentId, StudioSubagentSpec>(
  STUDIO_SUBAGENTS.map((s) => [s.id, s]),
);

export interface StudioPlanTask {
  id: string;
  title: string;
  description: string;
  subagent: StudioSubagentId;
  targetFiles: string[];
  status: "pending" | "running" | "done" | "failed";
  summary?: string;
  modifiedFiles?: string[];
}

export interface StudioPlan {
  summary: string;
  architecture: string;
  designDirection: string;
  stack: string[];
  tasks: StudioPlanTask[];
  status: "draft" | "approved" | "running" | "completed";
  updatedAt: string;
}

export interface StudioSubagentRunSummary {
  taskId: string;
  subagent: StudioSubagentId;
  title: string;
  ok: boolean;
  summary: string;
  modifiedFiles: string[];
}

export interface StudioChatMessage {
  id: string;
  role: "user" | "assistant";
  mode: "plan" | "build";
  text: string;
  at: string;
  files?: string[];
  plan?: StudioPlan;
  subagentRuns?: StudioSubagentRunSummary[];
  modifiedFiles?: string[];
}

export interface StudioProjectState {
  version: 1;
  messages: StudioChatMessage[];
  plan: StudioPlan | null;
}

export interface StudioRuntimeProfile {
  model?: string;
  maxSteps: number;
  agentInstructions: string;
  agentRules: readonly string[];
  skills: readonly string[];
  displayName: string;
}

export type StudioRuntimeResolver = (role: AgencyAgentRole) => StudioRuntimeProfile;

export const STUDIO_HISTORY_MAX = 200;
const MAX_BRIEF_CONTEXT_CHARS = 16_000;
const TEXT_SOURCE_EXT = /\.(txt|md|markdown|csv|json|yml|yaml|xml|html|htm|ts|tsx|js|jsx|css|sql)$/i;

function stateFilePath(dataDir: string, projectId: string): string {
  const safe = projectId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "default";
  return path.join(dataDir, "agency", "studio-state", `${safe}.json`);
}

function normalizeSubagentId(raw: unknown): StudioSubagentId {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "architect" || value === "ui_ux" || value === "frontend" || value === "backend" || value === "qa") {
    return value;
  }
  if (value.includes("ui") || value.includes("ux") || value.includes("design")) return "ui_ux";
  if (value.includes("qa") || value.includes("test") || value.includes("security")) return "qa";
  if (value.includes("back") || value.includes("api") || value.includes("db")) return "backend";
  if (value.includes("arch")) return "architect";
  return "frontend";
}

function sanitizePlanTask(raw: unknown, idx: number): StudioPlanTask | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const status = t.status === "running" || t.status === "done" || t.status === "failed" ? t.status : "pending";
  const task: StudioPlanTask = {
    id: typeof t.id === "string" && t.id.trim() ? t.id.trim().slice(0, 60) : `t${idx + 1}`,
    title: String(t.title || `Tâche ${idx + 1}`).slice(0, 200),
    description: String(t.description || "").slice(0, 1500),
    subagent: normalizeSubagentId(t.subagent),
    targetFiles: Array.isArray(t.targetFiles)
      ? t.targetFiles.map((f) => String(f).trim()).filter(Boolean).slice(0, 20)
      : [],
    status,
  };
  if (typeof t.summary === "string") task.summary = t.summary.slice(0, 1000);
  if (Array.isArray(t.modifiedFiles)) {
    task.modifiedFiles = t.modifiedFiles.map((f) => String(f)).filter(Boolean).slice(0, 40);
  }
  return task;
}

function sanitizePlan(raw: unknown): StudioPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const rawTasks = Array.isArray(p.tasks) ? p.tasks : [];
  const tasks = rawTasks
    .map((t, idx) => sanitizePlanTask(t, idx))
    .filter((x): x is StudioPlanTask => x !== null)
    .slice(0, 12);
  const status =
    p.status === "approved" || p.status === "running" || p.status === "completed" ? p.status : "draft";
  return {
    summary: String(p.summary || "").slice(0, 2000),
    architecture: String(p.architecture || "").slice(0, 3000),
    designDirection: String(p.designDirection || "").slice(0, 2000),
    stack: Array.isArray(p.stack) ? p.stack.map((s) => String(s).trim()).filter(Boolean).slice(0, 16) : [],
    tasks,
    status,
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : new Date().toISOString(),
  };
}

function sanitizeMessage(raw: unknown): StudioChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return null;
  const msg: StudioChatMessage = {
    id: typeof m.id === "string" && m.id.trim() ? m.id : crypto.randomUUID(),
    role: m.role,
    mode: m.mode === "plan" ? "plan" : "build",
    text: m.text.slice(0, 40_000),
    at: typeof m.at === "string" ? m.at : new Date().toISOString(),
  };
  if (Array.isArray(m.files)) {
    msg.files = m.files.filter((f): f is string => typeof f === "string").slice(0, 20);
  }
  if (m.plan) {
    const cleanPlan = sanitizePlan(m.plan);
    if (cleanPlan) msg.plan = cleanPlan;
  }
  if (Array.isArray(m.subagentRuns)) {
    msg.subagentRuns = m.subagentRuns
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .slice(0, 20)
      .map((r) => ({
        taskId: String(r.taskId ?? ""),
        subagent: normalizeSubagentId(r.subagent),
        title: String(r.title ?? "").slice(0, 200),
        ok: r.ok === true,
        summary: String(r.summary ?? "").slice(0, 1000),
        modifiedFiles: Array.isArray(r.modifiedFiles)
          ? r.modifiedFiles.map((f) => String(f)).filter(Boolean).slice(0, 40)
          : [],
      }));
  }
  if (Array.isArray(m.modifiedFiles)) {
    msg.modifiedFiles = m.modifiedFiles.map((f) => String(f)).filter(Boolean).slice(0, 60);
  }
  return msg;
}

export async function loadStudioState(dataDir: string, projectId: string): Promise<StudioProjectState> {
  try {
    const raw = await readFile(stateFilePath(dataDir, projectId), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return {
      version: 1,
      messages: rawMessages
        .map(sanitizeMessage)
        .filter((x): x is StudioChatMessage => x !== null)
        .slice(-STUDIO_HISTORY_MAX),
      plan: parsed.plan ? sanitizePlan(parsed.plan) : null,
    };
  } catch {
    return { version: 1, messages: [], plan: null };
  }
}

export async function saveStudioState(
  dataDir: string,
  projectId: string,
  state: StudioProjectState,
): Promise<StudioProjectState> {
  const clean: StudioProjectState = {
    version: 1,
    messages: state.messages
      .map(sanitizeMessage)
      .filter((x): x is StudioChatMessage => x !== null)
      .slice(-STUDIO_HISTORY_MAX),
    plan: state.plan ? sanitizePlan(state.plan) : null,
  };
  const file = stateFilePath(dataDir, projectId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(clean, null, 2), "utf8");
  await rename(tmp, file);
  return clean;
}

export async function clearStudioState(dataDir: string, projectId: string): Promise<void> {
  await rm(stateFilePath(dataDir, projectId), { force: true });
}

export function buildProjectBriefContext(dataDir: string, project: Project): {
  contextText: string;
  codeFiles: string[];
  sourceFiles: string[];
} {
  const allFiles = listWorkspaceFiles(dataDir, project);
  const codeFiles = allFiles
    .filter((f) => !f.path.startsWith("docs/") && !f.path.startsWith("missions/") && !f.path.startsWith("qa/"))
    .map((f) => f.path);
  const sourceFiles = allFiles.filter((f) => f.path.startsWith("docs/")).map((f) => f.path);

  const chunks: string[] = [
    `## Informations Projet`,
    `- Titre : ${project.title}`,
    `- Statut : ${project.status}`,
    `- Stack souhaitée : ${project.targetStack.join(", ") || "à définir selon les besoins"}`,
    `- Budget : ${project.budgetAmount} ${project.currency}`,
    `- Durée estimée : ${project.estimatedDays} jour(s)`,
  ];

  if (project.technicalSpecs?.trim()) {
    chunks.push(`### Spécifications techniques\n${project.technicalSpecs.trim().slice(0, 4000)}`);
  }

  let budgetChars = chunks.join("\n").length;
  const docCandidates = ["BRIEF.md", "docs/CAHIER-DES-CHARGES.md", ...sourceFiles.filter((p) => p !== "docs/CAHIER-DES-CHARGES.md")];
  const seen = new Set<string>();

  for (const rel of docCandidates) {
    if (seen.has(rel) || budgetChars >= MAX_BRIEF_CONTEXT_CHARS) continue;
    seen.add(rel);
    if (rel.startsWith("docs/sources/") && !TEXT_SOURCE_EXT.test(rel)) {
      chunks.push(`### Fichier source binaire : ${rel}`);
      continue;
    }
    try {
      const content = readWorkspaceFile(dataDir, project, rel).content.trim();
      if (!content) continue;
      const remaining = Math.max(400, MAX_BRIEF_CONTEXT_CHARS - budgetChars);
      const excerpt = content.slice(0, Math.min(4500, remaining));
      const section = `### ${rel}\n${excerpt}`;
      chunks.push(section);
      budgetChars += section.length;
    } catch {
      /* skip unreadable or binary files */
    }
  }

  chunks.push(
    `### Fichiers applicatifs existants\n${codeFiles.length ? codeFiles.join(", ") : "(aucun fichier applicatif créé pour le moment)"}`,
  );

  return {
    contextText: chunks.join("\n\n"),
    codeFiles,
    sourceFiles,
  };
}

function buildSubagentPromptDirective(input: {
  subagent: StudioSubagentSpec;
  runtime: StudioRuntimeProfile;
  project: Project;
  briefContext: string;
  task: StudioPlanTask;
  priorSummary: string;
}): string {
  const parts = [
    `RÔLE SPÉCIALISÉ ACTIF : Sous-agent "${input.subagent.id}" (${input.runtime.displayName}).`,
    `DOMAINE DE RESPONSABILITÉ : ${input.subagent.focus}.`,
    `RÈGLE ABSOLUE SUR-MESURE : Ne génère JAMAIS de texte générique ni de modèle tout fait. Toute l'interface, le branding, les textes, la structure, les données et les fonctionnalités doivent découler exclusivement des informations du projet "${input.project.title}", du cahier des charges, des fichiers sources et des instructions utilisateur.`,
    input.runtime.agentInstructions?.trim() ? `COMPÉTENCES & INSTRUCTIONS CONFIGURÉES :\n${input.runtime.agentInstructions.trim()}` : "",
    input.runtime.agentRules.length ? `RÈGLES STRICTES :\n${input.runtime.agentRules.map((r) => `- ${r}`).join("\n")}` : "",
    input.task.targetFiles.length ? `FICHIERS CIBLES PRIORITAIRES : ${input.task.targetFiles.join(", ")}` : "",
    input.priorSummary ? `TRAVAIL DÉJÀ RÉALISÉ LORS DE CETTE SESSION :\n${input.priorSummary}` : "",
    `CONTEXTE COMPLET DU PROJET :\n${input.briefContext}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

function parseJsonObjectFromReply(raw: string): Record<string, unknown> | null {
  try {
    const direct = JSON.parse(raw) as unknown;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    /* try extracting fenced or balanced JSON */
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fallback below */
    }
  }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function buildFallbackPlanFromBrief(project: Project, message: string): StudioPlan {
  const now = new Date().toISOString();
  return {
    summary: `Plan sur mesure pour "${project.title}" basé sur le brief et votre demande.`,
    architecture: "Architecture modulaire HTML/CSS/JS ou Node adaptée au cahier des charges sans template figé.",
    designDirection: `Identité visuelle dédiée à ${project.title}, mise en page responsive, hiérarchie claire et contraste soigné.`,
    stack: project.targetStack.length ? [...project.targetStack] : ["HTML5", "CSS3", "JavaScript ESM"],
    status: "draft",
    updatedAt: now,
    tasks: [
      {
        id: "t1",
        title: "Design system & identité visuelle sur mesure",
        description: `Concevoir la charte graphique, la structure sémantique et les styles CSS de ${project.title} à partir du cahier des charges (${message.slice(0, 140)}).`,
        subagent: "ui_ux",
        targetFiles: ["index.html", "styles.css"],
        status: "pending",
      },
      {
        id: "t2",
        title: "Fonctionnalités interactives & contenu métier",
        description: `Implémenter les parcours, formulaires, données et interactions demandés pour ${project.title}.`,
        subagent: "frontend",
        targetFiles: ["index.html", "app.js"],
        status: "pending",
      },
      {
        id: "t3",
        title: "Audit QA, cohérence et vérification",
        description: "Vérifier l'intégrité des liens, scripts, tests et du rendu responsive, puis corriger toute anomalie.",
        subagent: "qa",
        targetFiles: ["index.html", "styles.css", "app.js"],
        status: "pending",
      },
    ],
  };
}

async function resolveModel(
  modelClient: ModelClient,
  preferredModel?: string,
): Promise<string> {
  let model = preferredModel?.trim() || "";
  if (!model) model = (await modelClient.listModels())[0] ?? "";
  if (!model) {
    throw new AgencyError("VALIDATION_ERROR", "Aucun modèle IA disponible sur l'endpoint configuré.");
  }
  return model;
}

export async function runStudioConversation(input: {
  dataDir: string;
  project: Project;
  message: string;
  mode: "plan" | "build";
  executePlan?: boolean;
  targetSubagent?: StudioSubagentId;
  attachedFileNames?: string[];
  modelClient?: ModelClient;
  defaultModel?: string;
  hasLlmEndpoint?: boolean;
  resolveRuntime: StudioRuntimeResolver;
  onEvent?: (event: string, data: unknown) => void;
}): Promise<{
  message: StudioChatMessage;
  plan: StudioPlan | null;
  state: StudioProjectState;
}> {
  if (!input.hasLlmEndpoint || !input.modelClient) {
    throw new AgencyError("VALIDATION_ERROR", "Aucun endpoint de modèle IA n'est configuré dans Paramètres.");
  }
  const cleanMsg = input.message.trim();
  if (!cleanMsg && !input.executePlan && !(input.attachedFileNames?.length)) {
    throw new AgencyError("VALIDATION_ERROR", "Un message ou des fichiers sont requis.");
  }

  initProjectWorkspace({ dataDir: input.dataDir, project: input.project, lots: [] });
  const state = await loadStudioState(input.dataDir, input.project.id);
  const brief = buildProjectBriefContext(input.dataDir, input.project);

  const userDisplay =
    cleanMsg ||
    (input.executePlan
      ? "Approuver le plan et lancer la construction avec les sous-agents."
      : `Fichiers ajoutés : ${(input.attachedFileNames ?? []).join(", ")}`);

  const userMsg: StudioChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    mode: input.mode,
    text: userDisplay,
    at: new Date().toISOString(),
    ...(input.attachedFileNames?.length ? { files: input.attachedFileNames } : {}),
  };
  state.messages.push(userMsg);
  await saveStudioState(input.dataDir, input.project.id, state);
  input.onEvent?.("status", { phase: input.mode, message: userDisplay });

  const historyLines = state.messages
    .slice(-13, -1)
    .map((m) => `[${m.role === "user" ? "Utilisateur" : "Studio IA"} · ${m.mode}] ${m.text.slice(0, 1200)}`);

  if (input.mode === "plan") {
    const archRuntime = input.resolveRuntime("architect");
    const model = await resolveModel(input.modelClient, archRuntime.model || input.defaultModel);

    const systemPrompt = [
      `Tu es l'Architecte Principal du Studio IA (niveau Lovable / Bolt).`,
      `Tu discutes avec l'utilisateur pour concevoir, clarifier et ajuster un plan de réalisation 100% sur mesure pour "${input.project.title}".`,
      `INTERDIT d'utiliser des modèles génériques ou des textes génériques : chaque composant, couleur, rubrique et fonctionnalité doit venir du cahier des charges, des fichiers sources et des échanges.`,
      `SOUS-AGENTS DISPONIBLES À ORCHESTRER :`,
      ...STUDIO_SUBAGENTS.map((s) => `- ${s.id} : ${s.focus}`),
      archRuntime.agentInstructions ? `Instructions Architecte :\n${archRuntime.agentInstructions}` : "",
      archRuntime.agentRules.length ? `Règles :\n${archRuntime.agentRules.map((r) => `- ${r}`).join("\n")}` : "",
      `Retourne STRICTEMENT un objet JSON valide (sans texte hors JSON) au format :`,
      `{"reply":"Réponse conversationnelle claire en Markdown dans la langue de l'utilisateur (analyse du brief, choix UX/tech, réponses aux questions ou ajustements proposés).","plan":{"summary":"Résumé en 1-2 phrases","architecture":"Architecture des fichiers et flux de données","designDirection":"Direction artistique, palette, typographie, ambiance tirées du projet","stack":["..."],"tasks":[{"id":"t1","title":"Titre court","description":"Spécification précise pour le sous-agent","subagent":"architect|ui_ux|frontend|backend|qa","targetFiles":["index.html","styles.css"]}]}}`,
    ].filter(Boolean).join("\n\n");

    const userPrompt = [
      brief.contextText,
      state.plan ? `PLAN ACTUEL À DISCUTER / AJUSTER :\n${JSON.stringify(state.plan, null, 2)}` : "",
      historyLines.length ? `HISTORIQUE RÉCENT :\n${historyLines.join("\n")}` : "",
      `DEMANDE UTILISATEUR (Mode Plan / Discussion) :\n${userDisplay}`,
    ].filter(Boolean).join("\n\n");

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

    const parsed = parseJsonObjectFromReply(raw);
    const replyText =
      typeof parsed?.reply === "string" && parsed.reply.trim()
        ? parsed.reply.trim()
        : raw.trim() || "Plan mis à jour selon vos consignes.";
    const parsedPlan = parsed?.plan ? sanitizePlan(parsed.plan) : null;
    const nextPlan: StudioPlan =
      parsedPlan && parsedPlan.tasks.length > 0
        ? { ...parsedPlan, status: "draft", updatedAt: new Date().toISOString() }
        : state.plan ?? buildFallbackPlanFromBrief(input.project, userDisplay);

    const assistantMsg: StudioChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      mode: "plan",
      text: replyText,
      at: new Date().toISOString(),
      plan: nextPlan,
    };
    state.plan = nextPlan;
    state.messages.push(assistantMsg);
    const saved = await saveStudioState(input.dataDir, input.project.id, state);
    input.onEvent?.("plan", { plan: nextPlan });
    input.onEvent?.("message", { message: assistantMsg });
    input.onEvent?.("done", { message: assistantMsg, plan: nextPlan, state: saved });
    return { message: assistantMsg, plan: nextPlan, state: saved };
  }

  // MODE BUILD: Snapshot Git puis exécution orchestrée par les sous-agents spécialisés
  await createStudioSnapshot(input.dataDir, input.project, "avant-studio-build").catch(() => undefined);

  let tasksToRun: StudioPlanTask[] = [];
  if (input.executePlan && state.plan?.tasks.length) {
    state.plan.status = "running";
    state.plan.updatedAt = new Date().toISOString();
    tasksToRun = state.plan.tasks.filter((t) => t.status !== "done");
    if (tasksToRun.length === 0) {
      tasksToRun = state.plan.tasks.map((t) => ({ ...t, status: "pending" as const }));
      state.plan.tasks = tasksToRun;
    }
    input.onEvent?.("plan", { plan: state.plan });
  } else if (input.targetSubagent) {
    const spec = SUBAGENT_SPEC_MAP.get(input.targetSubagent) ?? SUBAGENT_SPEC_MAP.get("frontend")!;
    tasksToRun = [
      {
        id: `t-${Date.now().toString(36)}`,
        title: `Intervention ${spec.id}`,
        description: userDisplay,
        subagent: spec.id,
        targetFiles: brief.codeFiles.slice(0, 6),
        status: "pending",
      },
    ];
  } else {
    const archRuntime = input.resolveRuntime("architect");
    const routerModel = await resolveModel(input.modelClient, archRuntime.model || input.defaultModel);
    const routingPrompt = [
      `Tu es l'orchestrateur du Studio IA pour "${input.project.title}".`,
      `Découpe cette demande en 1 à 4 tâches ciblées confiées aux sous-agents spécialisés (architect, ui_ux, frontend, backend, qa).`,
      `Si aucun fichier applicatif n'existe encore, prévois une construction complète sur mesure (ui_ux puis frontend, et backend si API/données requises, puis qa) tirée du brief et des documents.`,
      `Si c'est un ajustement ciblé, ne crée que 1 à 2 tâches focalisées sur les sous-agents pertinents.`,
      `Retourne STRICTEMENT un JSON : {"tasks":[{"id":"t1","title":"...","description":"...","subagent":"ui_ux|frontend|backend|architect|qa","targetFiles":["..."]}]}`,
    ].join("\n");

    const routingRaw = await input.modelClient
      .streamChat(
        {
          model: routerModel,
          messages: [
            { role: "system", content: routingPrompt },
            {
              role: "user",
              content: [
                brief.contextText,
                historyLines.length ? `HISTORIQUE :\n${historyLines.slice(-6).join("\n")}` : "",
                `INSTRUCTION :\n${userDisplay}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        },
        () => {},
      )
      .catch(() => "");

    const parsedRouting = parseJsonObjectFromReply(routingRaw);
    const rawTasks = Array.isArray(parsedRouting?.tasks) ? parsedRouting.tasks : [];
    tasksToRun = rawTasks
      .map((t, idx) => sanitizePlanTask(t, idx))
      .filter((x): x is StudioPlanTask => x !== null)
      .slice(0, 5);

    if (tasksToRun.length === 0) {
      tasksToRun = brief.codeFiles.length === 0
        ? buildFallbackPlanFromBrief(input.project, userDisplay).tasks
        : [
            {
              id: "t1",
              title: "Mise à jour applicative",
              description: userDisplay,
              subagent: "frontend",
              targetFiles: brief.codeFiles.slice(0, 6),
              status: "pending",
            },
          ];
    }

    state.plan = {
      summary: state.plan?.summary || `Construction sur mesure : ${userDisplay.slice(0, 140)}`,
      architecture: state.plan?.architecture || "Générée dynamiquement à partir du brief et des documents.",
      designDirection: state.plan?.designDirection || "Identité visuelle dérivée du projet.",
      stack: state.plan?.stack?.length ? state.plan.stack : input.project.targetStack,
      tasks: tasksToRun,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    input.onEvent?.("plan", { plan: state.plan });
  }

  const runs: StudioSubagentRunSummary[] = [];
  const allModified = new Set<string>();
  let rollingSummary = "";

  for (const task of tasksToRun) {
    const spec = SUBAGENT_SPEC_MAP.get(task.subagent) ?? SUBAGENT_SPEC_MAP.get("frontend")!;
    const runtime = input.resolveRuntime(spec.agencyRole);
    task.status = "running";
    input.onEvent?.("subagent_start", {
      taskId: task.id,
      subagent: spec.id,
      displayName: runtime.displayName,
      skills: runtime.skills,
      title: task.title,
    });
    if (state.plan) input.onEvent?.("plan", { plan: state.plan });

    const freshBrief = buildProjectBriefContext(input.dataDir, input.project);
    const directive = buildSubagentPromptDirective({
      subagent: spec,
      runtime,
      project: input.project,
      briefContext: freshBrief.contextText,
      task,
      priorSummary: rollingSummary,
    });

    const taskInstruction = [
      `TÂCHE ASSIGNÉE (#${task.id}) : ${task.title}`,
      task.description,
      `DEMANDE GLOBALE DE L'UTILISATEUR : ${userDisplay}`,
      `Assure-toi que les fichiers produits fonctionnent ensemble (chemins relatifs ./styles.css, ./app.js valides dans index.html, aucune erreur JS/CSS).`,
    ].join("\n\n");

    try {
      const execResult = await runStudioAiAgent({
        dataDir: input.dataDir,
        project: input.project,
        instruction: taskInstruction,
        maxSteps: Math.max(8, runtime.maxSteps || 10),
        modelClient: input.modelClient,
        defaultModel: runtime.model || input.defaultModel,
        hasLlmEndpoint: true,
        agentInstructions: directive,
        agentRules: runtime.agentRules,
        onStep: (step: StudioAgentStep) => {
          input.onEvent?.("step", { ...step, taskId: task.id, subagent: spec.id });
        },
      });
      task.status = "done";
      task.summary = execResult.summary;
      task.modifiedFiles = execResult.modifiedFiles;
      for (const f of execResult.modifiedFiles) allModified.add(f);
      rollingSummary += `\n- [${spec.id}] ${task.title}: ${execResult.summary} (fichiers: ${execResult.modifiedFiles.join(", ") || "aucun"})`;
      const runSummary: StudioSubagentRunSummary = {
        taskId: task.id,
        subagent: spec.id,
        title: task.title,
        ok: true,
        summary: execResult.summary,
        modifiedFiles: execResult.modifiedFiles,
      };
      runs.push(runSummary);
      input.onEvent?.("subagent_done", runSummary);
    } catch (err) {
      const msg = (err as Error).message || "Échec du sous-agent";
      task.status = "failed";
      task.summary = msg;
      const runSummary: StudioSubagentRunSummary = {
        taskId: task.id,
        subagent: spec.id,
        title: task.title,
        ok: false,
        summary: msg,
        modifiedFiles: [],
      };
      runs.push(runSummary);
      input.onEvent?.("subagent_done", runSummary);
    }
  }

  if (state.plan) {
    const anyFailed = state.plan.tasks.some((t) => t.status === "failed");
    const allDone = state.plan.tasks.every((t) => t.status === "done");
    state.plan.status = allDone ? "completed" : anyFailed ? "draft" : "approved";
    state.plan.updatedAt = new Date().toISOString();
    input.onEvent?.("plan", { plan: state.plan });
  }

  const modifiedList = [...allModified];
  const answerLines = [
    `### Exécution terminée (${runs.filter((r) => r.ok).length}/${runs.length} sous-agents réussis)`,
    ...runs.map(
      (r) =>
        `- **${r.subagent}** · ${r.title} : ${r.summary}${r.modifiedFiles.length ? ` (\`${r.modifiedFiles.join("`, `")}\`)` : ""}`,
    ),
    modifiedList.length
      ? `\nFichiers modifiés (${modifiedList.length}) : \`${modifiedList.join("`, `")}\`.`
      : "",
  ].filter(Boolean);

  const assistantMsg: StudioChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    mode: "build",
    text: answerLines.join("\n"),
    at: new Date().toISOString(),
    subagentRuns: runs,
    modifiedFiles: modifiedList,
  };
  state.messages.push(assistantMsg);
  const saved = await saveStudioState(input.dataDir, input.project.id, state);
  input.onEvent?.("message", { message: assistantMsg });
  input.onEvent?.("done", {
    message: assistantMsg,
    plan: state.plan,
    modifiedFiles: modifiedList,
    subagentRuns: runs,
    state: saved,
  });
  return { message: assistantMsg, plan: state.plan, state: saved };
}
