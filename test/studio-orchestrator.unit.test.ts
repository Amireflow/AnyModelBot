import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProjectBriefContext,
  clearStudioState,
  loadStudioState,
  runStudioConversation,
  saveStudioState,
  type StudioRuntimeProfile,
} from "../src/agency/studio-orchestrator.js";
import { readWorkspaceFile, runStudioAiAgent, writeWorkspaceFile } from "../src/agency/studio.js";
import type { Project } from "../src/agency/types.js";
import type { ModelClient } from "../src/llm/client.js";

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-studio-orch-"));
  dirs.push(dir);
  return dir;
}

function makeProject(): Project {
  const now = Date.now();
  return {
    id: "proj-orch-1",
    organizationId: "org-1",
    leadId: "lead-1",
    contractId: "ctr-1",
    title: "Klinika Dakar",
    status: "in_progress",
    targetStack: ["HTML5", "CSS3", "JavaScript"],
    budgetAmount: 2500000,
    currency: "XOF",
    estimatedDays: 14,
    technicalSpecs: "Portail de prise de rendez-vous médical à Dakar avec spécialités et fiche praticien.",
    workspacePath: "proj-orch-1",
    handoffSummary: "Handoff initial",
    handoffAt: now,
    deliveredAt: null,
    acceptedAt: null,
    createdBy: "operator",
    createdAt: now,
    updatedAt: now,
  };
}

function makeRuntimeResolver(): (role: string) => StudioRuntimeProfile {
  return (role) => ({
    model: "test-model",
    maxSteps: 6,
    agentInstructions: `Configured ${role} expert with SKILL.md`,
    agentRules: ["Toujours respecter le cahier des charges"],
    skills: ["clean-architecture", "ui-polish"],
    displayName: `Agent ${role}`,
  });
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("Studio conversational multi-subagent orchestrator", () => {
  it("persists and clears per-project state atomically", async () => {
    const dir = makeTempDir();
    expect(await loadStudioState(dir, "proj-1")).toEqual({ version: 1, messages: [], plan: null });

    await saveStudioState(dir, "proj-1", {
      version: 1,
      messages: [
        { id: "m1", role: "user", mode: "plan", text: "Analyse le cahier des charges", at: "2026-01-01T00:00:00Z" },
      ],
      plan: {
        summary: "Plan initial",
        architecture: "SPA légère",
        designDirection: "Palette médicale bleue et crème",
        stack: ["HTML5", "CSS3"],
        status: "draft",
        updatedAt: "2026-01-01T00:00:00Z",
        tasks: [
          {
            id: "t1",
            title: "Design",
            description: "Maquette",
            subagent: "ui_ux",
            targetFiles: ["styles.css"],
            status: "pending",
          },
        ],
      },
    });

    const loaded = await loadStudioState(dir, "proj-1");
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.plan?.tasks[0]?.subagent).toBe("ui_ux");

    await clearStudioState(dir, "proj-1");
    expect(await loadStudioState(dir, "proj-1")).toEqual({ version: 1, messages: [], plan: null });
  });

  it("reads cahier des charges and source docs into brief context", () => {
    const dir = makeTempDir();
    const project = makeProject();
    writeWorkspaceFile(dir, project, "docs/CAHIER-DES-CHARGES.md", "# CDC\nPrendre rendez-vous en cardiologie.");
    writeWorkspaceFile(dir, project, "docs/sources/praticiens.json", JSON.stringify([{ name: "Dr Diallo" }]));

    const ctx = buildProjectBriefContext(dir, project);
    expect(ctx.contextText).toContain("Klinika Dakar");
    expect(ctx.contextText).toContain("Prendre rendez-vous en cardiologie.");
    expect(ctx.contextText).toContain("Dr Diallo");
  });

  it("generates and persists a structured multi-subagent plan without touching code files in plan mode", async () => {
    const dir = makeTempDir();
    const project = makeProject();
    const mockClient: ModelClient = {
      listModels: async () => ["test-model"],
      streamChat: async () =>
        JSON.stringify({
          reply: "Voici le plan sur mesure pour Klinika Dakar.",
          plan: {
            summary: "Portail médical avec prise de RDV",
            architecture: "index.html + styles.css + app.js",
            designDirection: "Sérénité clinique, émeraude et lin",
            stack: ["HTML5", "CSS3", "JavaScript"],
            tasks: [
              {
                id: "t1",
                title: "Design System",
                description: "Créer styles.css",
                subagent: "ui_ux",
                targetFiles: ["styles.css"],
              },
              {
                id: "t2",
                title: "Parcours RDV",
                description: "Créer index.html et app.js",
                subagent: "frontend",
                targetFiles: ["index.html", "app.js"],
              },
            ],
          },
        }),
    };

    const events: string[] = [];
    const res = await runStudioConversation({
      dataDir: dir,
      project,
      message: "Propose un plan détaillé à partir du brief",
      mode: "plan",
      modelClient: mockClient,
      defaultModel: "test-model",
      hasLlmEndpoint: true,
      resolveRuntime: makeRuntimeResolver(),
      onEvent: (ev) => events.push(ev),
    });

    expect(res.plan?.tasks).toHaveLength(2);
    expect(res.plan?.tasks[0]?.subagent).toBe("ui_ux");
    expect(res.plan?.tasks[1]?.subagent).toBe("frontend");
    expect(events).toContain("plan");
    expect(events).toContain("done");

    const saved = await loadStudioState(dir, project.id);
    expect(saved.messages).toHaveLength(2);
    expect(() => readWorkspaceFile(dir, project, "index.html")).toThrow();
  });

  it("refuses to execute a plan whose tasks are already complete", async () => {
    const dir = makeTempDir();
    const project = makeProject();
    await saveStudioState(dir, project.id, {
      version: 1,
      messages: [],
      plan: {
        summary: "Plan déjà terminé",
        architecture: "index.html",
        designDirection: "Sobre",
        stack: ["HTML5"],
        status: "completed",
        updatedAt: new Date().toISOString(),
        tasks: [{ id: "done-1", title: "Page d'accueil", description: "Déjà livrée", subagent: "frontend", targetFiles: ["index.html"], status: "done" }],
      },
    });
    let modelCalls = 0;
    const mockClient: ModelClient = {
      listModels: async () => ["test-model"],
      streamChat: async () => { modelCalls += 1; return "<studio-done>Ne doit pas être appelé</studio-done>"; },
    };
    await expect(runStudioConversation({
      dataDir: dir,
      project,
      message: "",
      mode: "build",
      executePlan: true,
      modelClient: mockClient,
      defaultModel: "test-model",
      hasLlmEndpoint: true,
      resolveRuntime: makeRuntimeResolver(),
    })).rejects.toThrow(/déjà terminé/i);
    expect(modelCalls).toBe(0);
  });

  it("reports a failed result when a critical file operation fails even if the model emits done", async () => {
    const dir = makeTempDir();
    const project = makeProject();
    const mockClient: ModelClient = {
      listModels: async () => ["test-model"],
      streamChat: async () => '<studio-write path="../outside.txt">unsafe</studio-write><studio-done>Terminé</studio-done>',
    };
    const result = await runStudioAiAgent({
      dataDir: dir,
      project,
      instruction: "Créer un fichier sans sortir du workspace",
      modelClient: mockClient,
      defaultModel: "test-model",
      hasLlmEndpoint: true,
    });
    expect(result.ok).toBe(false);
    expect(result.steps.some((step) => step.tool === "write_file" && !step.ok)).toBe(true);
  });

  it("propagates a disabled sub-agent runtime instead of silently using it", async () => {
    const dir = makeTempDir();
    const project = makeProject();
    const mockClient: ModelClient = {
      listModels: async () => ["test-model"],
      streamChat: async () => "<studio-done>Ne doit pas être appelé</studio-done>",
    };
    await expect(runStudioConversation({
      dataDir: dir,
      project,
      message: "Intervenir côté frontend",
      mode: "build",
      targetSubagent: "frontend",
      modelClient: mockClient,
      defaultModel: "test-model",
      hasLlmEndpoint: true,
      resolveRuntime: (role) => {
        if (role === "developer") throw new Error("Agent developer is currently disabled");
        return makeRuntimeResolver()(role);
      },
    })).rejects.toThrow(/currently disabled/i);
  });

  it("executes approved plan across specialized subagents and persists modified files", async () => {
    const dir = makeTempDir();
    const project = makeProject();

    await saveStudioState(dir, project.id, {
      version: 1,
      messages: [],
      plan: {
        summary: "Construction Klinika Dakar",
        architecture: "index.html + styles.css",
        designDirection: "Clinique moderne",
        stack: ["HTML5", "CSS3"],
        status: "draft",
        updatedAt: new Date().toISOString(),
        tasks: [
          {
            id: "t1",
            title: "Charte CSS",
            description: "Créer styles.css",
            subagent: "ui_ux",
            targetFiles: ["styles.css"],
            status: "pending",
          },
          {
            id: "t2",
            title: "Page d'accueil",
            description: "Créer index.html",
            subagent: "frontend",
            targetFiles: ["index.html"],
            status: "pending",
          },
        ],
      },
    });

    let call = 0;
    const responses = [
      JSON.stringify({ tool: "write_file", path: "styles.css", content: "body{margin:0;color:#0f172a;}" }),
      JSON.stringify({ tool: "finish", summary: "styles.css prêt" }),
      JSON.stringify({ tool: "write_file", path: "index.html", content: "<!doctype html><html><body><h1>Klinika Dakar</h1></body></html>" }),
      JSON.stringify({ tool: "finish", summary: "index.html prêt" }),
    ];
    const mockClient: ModelClient = {
      listModels: async () => ["test-model"],
      streamChat: async () => responses[call++] ?? JSON.stringify({ tool: "finish", summary: "ok" }),
    };

    const events: string[] = [];
    const res = await runStudioConversation({
      dataDir: dir,
      project,
      message: "",
      mode: "build",
      executePlan: true,
      modelClient: mockClient,
      defaultModel: "test-model",
      hasLlmEndpoint: true,
      resolveRuntime: makeRuntimeResolver(),
      onEvent: (ev) => events.push(ev),
    });

    expect(res.plan?.status).toBe("completed");
    expect(res.message.subagentRuns).toHaveLength(2);
    expect(res.message.modifiedFiles).toEqual(["styles.css", "index.html"]);
    expect(events).toContain("subagent_start");
    expect(events).toContain("subagent_done");
    expect(readWorkspaceFile(dir, project, "index.html").content).toContain("Klinika Dakar");
  });

  it("auto-detects failing build scripts and triggers self-healing QA fix loop", async () => {
    const dir = makeTempDir();
    const project = makeProject();

    writeWorkspaceFile(
      dir,
      project,
      "package.json",
      JSON.stringify({
        name: "autofix-test",
        private: true,
        scripts: {
          build: "node -e \"const fs=require('fs'); if(!fs.existsSync('fixed.txt')) { console.error('Missing fixed.txt'); process.exit(1); }\"",
        },
      }),
    );

    let call = 0;
    const replies = [
      // Initial router split
      JSON.stringify({
        tasks: [{ id: "t1", title: "App setup", description: "Setup", subagent: "frontend", targetFiles: ["app.js"] }],
      }),
      // Frontend subagent writes app.js (forgetting fixed.txt)
      `<studio-write path="app.js">console.log("ok");</studio-write><studio-done>app.js créé</studio-done>`,
      // Auto-fix QA subagent creates fixed.txt after npm_build fails
      `<studio-write path="fixed.txt">ok</studio-write><studio-done>Erreur build corrigée</studio-done>`,
    ];

    const mockClient: ModelClient = {
      listModels: async () => ["test-model"],
      streamChat: async () => replies[call++] ?? "<studio-done>ok</studio-done>",
    };

    const res = await runStudioConversation({
      dataDir: dir,
      project,
      message: "Prépare l'app",
      mode: "build",
      modelClient: mockClient,
      defaultModel: "test-model",
      hasLlmEndpoint: true,
      resolveRuntime: makeRuntimeResolver(),
    });

    expect(res.message.modifiedFiles).toContain("app.js");
    expect(res.message.modifiedFiles).toContain("fixed.txt");
    expect(res.message.subagentRuns?.some((r) => r.taskId === "auto-fix-1" && r.ok)).toBe(true);
    expect(readWorkspaceFile(dir, project, "fixed.txt").content).toBe("ok");
  });
});
