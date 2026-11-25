import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../src/agency/types.js";
import { buildWorkspaceRepoMap, compactAgentHistory } from "../src/agency/studio-context.js";
import { partitionDisjointTaskWaves, type StudioPlanTask } from "../src/agency/studio-orchestrator.js";
import { writeWorkspaceFile } from "../src/agency/studio.js";

const dirs: string[] = [];

function makeProject(): { dataDir: string; project: Project } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-studio-ctx-"));
  dirs.push(dataDir);
  const project: Project = {
    id: "proj-ctx",
    organizationId: "org-1",
    leadId: "lead-1",
    contractId: "ctr-1",
    title: "Context App",
    status: "in_progress",
    targetStack: ["react", "typescript"],
    budgetAmount: 3000,
    currency: "EUR",
    estimatedDays: 4,
    workspacePath: "projects/proj-ctx",
    technicalSpecs: "",
    handoffSummary: "",
    handoffAt: Date.now(),
    deliveredAt: null,
    acceptedAt: null,
    createdBy: "operator",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { dataDir, project };
}

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("Studio context, compaction & parallel wave partitioning", () => {
  it("builds concise Repo Map with scripts, deps, exports, routes, and CSS tokens", () => {
    const { dataDir, project } = makeProject();
    writeWorkspaceFile(
      dataDir,
      project,
      "package.json",
      JSON.stringify({
        name: "demo-shop",
        scripts: { dev: "vite", build: "vite build", typecheck: "tsc --noEmit" },
        dependencies: { react: "^18.0.0", "lucide-react": "^0.400.0" },
      }),
    );
    writeWorkspaceFile(
      dataDir,
      project,
      "src/App.tsx",
      `export const routes = [{ path: "/catalog" }, { path: "/checkout" }];\nexport default function App() { return null; }\n`,
    );
    writeWorkspaceFile(dataDir, project, "src/index.css", `:root { --brand-gold: #c9a227; --bg-cream: #faf8f5; }\n`);

    const map = buildWorkspaceRepoMap(dataDir, project);
    expect(map).toContain("package.json (demo-shop)");
    expect(map).toContain("scripts: dev, build, typecheck");
    expect(map).toContain("src/App.tsx");
    expect(map).toContain("exports: default, routes");
    expect(map).toContain("routes: /catalog, /checkout");
    expect(map).toContain("--brand-gold");
  });

  it("compacts bulky middle turns while keeping system, initial prompt, errors, and tail intact", () => {
    const bigFileBody = "x".repeat(2500);
    const msgs = [
      { role: "system" as const, content: "SYSTEM_PROMPT" },
      { role: "user" as const, content: "INITIAL_TASK" },
      { role: "assistant" as const, content: `<studio-write path="src/Big.tsx">${bigFileBody}</studio-write>` },
      { role: "user" as const, content: `Résultats des actions :\n${"ok\n".repeat(400)}error TS2304: Cannot find name Foo` },
      ...Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `TAIL_${i}` })),
    ];
    const compacted = compactAgentHistory(msgs, 1500);
    expect(compacted[0].content).toBe("SYSTEM_PROMPT");
    expect(compacted[1].content).toBe("INITIAL_TASK");
    expect(compacted[2].content).toContain("contenu écrit");
    expect(compacted[2].content.length).toBeLessThan(300);
    expect(compacted[3].content.length).toBeLessThan(1500);
    expect(compacted[9].content).toBe("TAIL_5");
  });

  it("groups disjoint tasks with satisfied dependencies into parallel waves and serializes overlapping targets", () => {
    const makeTask = (id: string, subagent: StudioPlanTask["subagent"], targetFiles: string[], dependsOn?: string[]): StudioPlanTask => ({
      id,
      title: id,
      description: id,
      subagent,
      targetFiles,
      ...(dependsOn ? { dependsOn } : {}),
      status: "pending",
    });

    const waves = partitionDisjointTaskWaves([
      makeTask("t1", "architect", ["docs/arch.md"]),
      makeTask("t2", "frontend", ["src/App.tsx"], ["t1"]),
      makeTask("t3", "backend", ["server/api.ts"], ["t1"]),
      makeTask("t4", "ui_ux", ["src/App.tsx"], ["t1"]), // overlaps t2 on src/App.tsx -> next wave
      makeTask("t5", "qa", ["src/App.tsx"], ["t2", "t3", "t4"]),
    ]);

    expect(waves.map((w) => w.map((t) => t.id))).toEqual([
      ["t1"],
      ["t2", "t3"],
      ["t4"],
      ["t5"],
    ]);
  });
});
