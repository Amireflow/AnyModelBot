import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioSnapshot, getStudioDiff, resolveWorkspaceFile, writeWorkspaceFile } from "../src/agency/studio.js";
import type { Project } from "../src/agency/types.js";

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-studio-diff-"));
  dirs.push(dir);
  return dir;
}

function makeProject(): Project {
  const now = Date.now();
  return {
    id: "proj-diff-1",
    organizationId: "org-1",
    leadId: "lead-1",
    contractId: "ctr-1",
    title: "Studio diff test",
    status: "in_progress",
    targetStack: ["HTML5"],
    budgetAmount: 100000,
    currency: "XOF",
    estimatedDays: 3,
    technicalSpecs: "Test workspace diff",
    workspacePath: "proj-diff-1",
    handoffSummary: "Test",
    handoffAt: now,
    deliveredAt: null,
    acceptedAt: null,
    createdBy: "test",
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Studio snapshot diffs", () => {
  it("returns added, modified and deleted files with a bounded patch", async () => {
    const dir = makeTempDir();
    const project = makeProject();
    writeWorkspaceFile(dir, project, "src/app.js", "const label = \"old\";\n");
    writeWorkspaceFile(dir, project, "src/removed.js", "export const oldFile = true;\n");
    const removedPath = resolveWorkspaceFile(dir, project.workspacePath, "src/removed.js").absPath;
    expect(fs.existsSync(removedPath)).toBe(true);
    const before = await createStudioSnapshot(dir, project, "before");

    writeWorkspaceFile(dir, project, "src/app.js", "const label = \"new\";\n");
    writeWorkspaceFile(dir, project, "src/added.js", "export const added = true;\n");
    expect(fs.existsSync(removedPath)).toBe(true);
    fs.rmSync(removedPath);
    const after = await createStudioSnapshot(dir, project, "after");

    const result = await getStudioDiff(dir, project, before.commitHash, after.commitHash);
    expect(result.totalFiles).toBe(3);
    expect(result.files.map((file) => file.status)).toEqual(["added", "modified", "deleted"]);
    expect(result.files.map((file) => file.path)).toEqual(["src/added.js", "src/app.js", "src/removed.js"]);

    const detail = await getStudioDiff(dir, project, before.commitHash, after.commitHash, "src/app.js");
    expect(detail.diff?.patch).toContain("-const label = \"old\";");
    expect(detail.diff?.patch).toContain("+const label = \"new\";");
  });

  it("rejects invalid snapshot refs and paths outside the workspace", async () => {
    const dir = makeTempDir();
    const project = makeProject();
    writeWorkspaceFile(dir, project, "index.html", "<main>base</main>");
    const before = await createStudioSnapshot(dir, project, "before");
    writeWorkspaceFile(dir, project, "index.html", "<main>next</main>");
    const after = await createStudioSnapshot(dir, project, "after");

    await expect(getStudioDiff(dir, project, "HEAD;rm", after.commitHash)).rejects.toThrow(/hash/i);
    await expect(getStudioDiff(dir, project, before.commitHash, after.commitHash, "../outside.txt")).rejects.toThrow();
  });
});
