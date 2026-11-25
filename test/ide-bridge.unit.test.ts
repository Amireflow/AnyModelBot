import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../src/agency/types.js";
import {
  buildIdeInvocationArgs,
  deleteCustomIdeProfile,
  detectInstalledIdes,
  dispatchIdeTask,
  listCustomIdeProfiles,
  listIdeTaskRuns,
  upsertCustomIdeProfile,
} from "../src/agency/ide-bridge.js";

const dirs: string[] = [];

function makeTempProject(): { dataDir: string; project: Project } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-ide-bridge-"));
  dirs.push(dataDir);
  const now = Date.now();
  const project: Project = {
    id: "proj-ide-1",
    organizationId: "org-1",
    leadId: "lead-1",
    contractId: "ctr-1",
    title: "Client Portal",
    status: "in_progress",
    workspacePath: "projects/proj-ide-1",
    localPath: "",
    technicalSpecs: "API + web UI",
    targetStack: ["typescript", "react"],
    budgetAmount: 5000,
    currency: "EUR",
    estimatedDays: 7,
    handoffSummary: "Ready",
    handoffAt: now,
    deliveredAt: null,
    acceptedAt: null,
    createdBy: "operator",
    createdAt: now,
    updatedAt: now,
  };
  return { dataDir, project };
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("Universal IDE Bridge", () => {
  it("expands invocation argument templates cleanly without shell injection", () => {
    const args = buildIdeInvocationArgs(["--dir", "{dir}", "-g", "{file}:{line}", "-m", "{missionFile}"], {
      dir: "C:\\Work\\MyApp",
      file: "C:\\Work\\MyApp\\src\\App.tsx",
      line: 42,
      missionFile: ".anymodelbot/missions/r1.md",
    });
    expect(args).toEqual([
      "--dir",
      "C:\\Work\\MyApp",
      "-g",
      "C:\\Work\\MyApp\\src\\App.tsx:42",
      "-m",
      ".anymodelbot/missions/r1.md",
    ]);
  });

  it("supports custom IDE profile persistence, rejects unsafe executables, and detects tools", () => {
    const { dataDir } = makeTempProject();

    expect(() =>
      upsertCustomIdeProfile(dataDir, {
        name: "Unsafe",
        category: "ide",
        executable: "code && rm -rf /",
      }),
    ).toThrow(/shell operators/i);

    const saved = upsertCustomIdeProfile(dataDir, {
      id: "node-cli",
      name: "Node Dev Runner",
      category: "cli_agent",
      executable: process.execPath,
      openDirArgs: ["{dir}"],
      openFileArgs: ["{file}"],
      promptArgs: ["-e", "console.log('DISPATCHED_OK')"],
    });
    expect(saved.id).toBe("custom-node-cli");
    expect(listCustomIdeProfiles(dataDir)).toHaveLength(1);

    const detected = detectInstalledIdes(dataDir, true);
    const customItem = detected.find((x) => x.id === "custom-node-cli");
    expect(customItem?.available).toBe(true);
    expect(customItem?.custom).toBe(true);

    const del = deleteCustomIdeProfile(dataDir, "custom-node-cli");
    expect(del.deleted).toBe(true);
    expect(listCustomIdeProfiles(dataDir)).toHaveLength(0);
  });

  it("writes mission brief and dispatches CLI task runner with captured logs", async () => {
    const { dataDir, project } = makeTempProject();
    upsertCustomIdeProfile(dataDir, {
      id: "node-runner",
      name: "Node Runner",
      category: "cli_agent",
      executable: process.execPath,
      promptArgs: ["-e", "console.log('RUN_DONE_OK')"],
    });

    const dispatched = await dispatchIdeTask({
      dataDir,
      project,
      ideId: "custom-node-runner",
      title: "Build dashboard",
      instruction: "Implement dashboard metrics cards",
    });

    expect(dispatched.run.mode).toBe("cli");
    expect(dispatched.run.missionFile).toContain("missions/");
    expect(dispatched.promptText).toContain("Implement dashboard metrics cards");

    // Wait briefly for child node -e process to exit cleanly
    for (let i = 0; i < 30; i++) {
      const latest = listIdeTaskRuns(project.id).find((r) => r.id === dispatched.run.id);
      if (latest && latest.status !== "running") break;
      await new Promise((r) => setTimeout(r, 80));
    }

    const finished = listIdeTaskRuns(project.id).find((r) => r.id === dispatched.run.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.logs.join("\n")).toContain("RUN_DONE_OK");
  });
});
