import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgencyService, AgencyStore } from "../src/agency/index.js";
import {
  browseMachineDirectories,
  getProjectEvolutionSnapshot,
  getProjectGitDiff,
  listProjectFiles,
  readProjectFile,
  syncProjectBriefToDisk,
  validateLocalProductDirectory,
} from "../src/agency/project-tracker.js";

const dirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("Machine Product Directory Linking & Evolution Tracker", () => {
  it("validates local product directories and blocks OS roots or traversal", () => {
    const productDir = makeTempDir("amb-prod-dir-");
    expect(validateLocalProductDirectory(productDir)).toBe(path.resolve(productDir));
    expect(() => validateLocalProductDirectory("relative/path")).toThrow(/absolute path/i);
    expect(() => validateLocalProductDirectory("C:\\..\\Windows")).toThrow(/traversal/i);
    const rootTarget = process.platform === "win32" ? "C:\\" : "/";
    expect(() => validateLocalProductDirectory(rootTarget)).toThrow(/root directories/i);
    if (process.platform === "win32" && fs.existsSync("C:\\Windows")) {
      expect(() => validateLocalProductDirectory("C:\\Windows")).toThrow(/Protected OS directory/i);
    }

    const parent = path.dirname(productDir);
    const baseName = path.basename(productDir);
    const browse = browseMachineDirectories(parent);
    expect(browse.entries.some((e) => e.name === baseName)).toBe(true);
  });

  it("links a real Git repository on the machine and tracks commits, file diffs, and stack", async () => {
    const dataDir = makeTempDir("amb-tracker-data-");
    const repoDir = makeTempDir("amb-tracker-repo-");

    // Initialize a real Git repo in repoDir
    execFileSync("git", ["init"], { cwd: repoDir, windowsHide: true });
    execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: repoDir, windowsHide: true });
    execFileSync("git", ["config", "user.name", "Dev Test"], { cwd: repoDir, windowsHide: true });
    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({ name: "client-app", scripts: { test: "vitest" }, dependencies: { react: "^18.0.0" } }),
      "utf8",
    );
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "export const version = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoDir, windowsHide: true });
    execFileSync("git", ["commit", "-m", "Initial product commit"], { cwd: repoDir, windowsHide: true });

    // Introduce local working tree modification
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "export const version = 2;\n", "utf8");

    const store = new AgencyStore(path.join(dataDir, "agency.sqlite"));
    try {
      const service = new AgencyService(store);
      const org = service.createOrganization({ name: "Test Agency", countryCode: "SN", currency: "XOF" }, "local-owner");
      const created = service.createDirectProject(org.id, "local-owner", {
        title: "Real Repo Product",
        localPath: repoDir,
      });
      expect(created.project.localPath).toBe(path.resolve(repoDir));

      const brief = syncProjectBriefToDisk({ dataDir, project: created.project, contract: created.contract, lots: [] });
      expect(brief.mode).toBe("linked");
      expect(brief.path).toBe(".anymodelbot/BRIEF.md");

      const evo = await getProjectEvolutionSnapshot(dataDir, created.project);
      expect(evo.mode).toBe("linked");
      expect(evo.exists).toBe(true);
      expect(evo.stack).toContain("React");
      expect(evo.git.isRepo).toBe(true);
      expect(evo.git.recentCommits[0]?.subject).toBe("Initial product commit");
      expect(evo.git.changes.some((c) => c.path === "src/index.ts")).toBe(true);

      const diff = await getProjectGitDiff(dataDir, created.project, "src/index.ts");
      expect(diff.patch).toContain("+export const version = 2;");

      const files = listProjectFiles(dataDir, created.project);
      expect(files.some((f) => f.path === "src/index.ts")).toBe(true);
      expect(readProjectFile(dataDir, created.project, "src/index.ts").content).toContain("version = 2");

      // Test unlinking back to managed workspace
      const unlinked = service.linkProjectLocalDirectory(org.id, "local-owner", created.project.id, "");
      expect(unlinked.localPath).toBe("");
    } finally {
      store.close();
    }
  });
});
