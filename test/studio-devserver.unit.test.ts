import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../src/agency/types.js";
import { resolveStudioPreviewAsset, rewritePreviewHtmlForStudio, writeWorkspaceFile } from "../src/agency/studio.js";
import { buildStudioDockerRunArgs, detectStudioExecutionCapabilities } from "../src/agency/studio-devserver.js";

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

describe("Studio Docker preview isolation", () => {
  it("publishes the preview only on host loopback and mounts only the project workspace", () => {
    const args = buildStudioDockerRunArgs({
      projectId: "Project_123",
      workspaceDir: "/home/user/projects/project-123",
      hostPort: 43127,
      scriptName: "dev",
      isVite: true,
      isNext: false,
      userId: 1001,
      groupId: 1001,
    });

    expect(optionValue(args, "--publish")).toBe("127.0.0.1:43127:4173");
    expect(args).toContain("type=bind,source=/home/user/projects/project-123,target=/workspace");
    expect(optionValue(args, "--user")).toBe("1001:1001");
    expect(args.filter((arg) => arg.startsWith("type=bind,source="))).toHaveLength(1);
    expect(optionValue(args, "--network")).toBe("bridge");
  });

  it("drops capabilities, prevents privilege escalation and bounds container resources", () => {
    const args = buildStudioDockerRunArgs({
      projectId: "proj-1",
      workspaceDir: "/tmp/project",
      hostPort: 41000,
      scriptName: "dev",
      isVite: true,
      isNext: false,
      userId: 1001,
      groupId: 1001,
    });

    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges:true");
    expect(optionValue(args, "--user")).toBe("1001:1001");
    expect(args).toContain("--pids-limit=128");
    expect(args).toContain("--memory=1024m");
    expect(args).toContain("--cpus=1.5");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--pid=host");
  });

  it("uses only explicit non-secret container environment values", () => {
    const args = buildStudioDockerRunArgs({
      projectId: "proj-2",
      workspaceDir: "/tmp/project",
      hostPort: 41001,
      scriptName: "start",
      isVite: false,
      isNext: true,
      userId: 1001,
      groupId: 1001,
    });

    const envValues = args.flatMap((value, index) => value === "--env" ? [args[index + 1]] : []);
    expect(envValues).toContain("NODE_ENV=development");
    expect(envValues).toContain("HOME=/tmp");
    expect(envValues).toContain("HOST=0.0.0.0");
    expect(envValues.some((value) => /API_KEY|TOKEN|SECRET|PASSWORD|AWS_|OPENAI_/i.test(value))).toBe(false);
    expect(args.at(-1)).toContain("npm run start -- -H 0.0.0.0 -p 4173");
  });

  it("installs dependencies inside the container and binds Vite to its private interface", () => {
    const args = buildStudioDockerRunArgs({
      projectId: "proj-3",
      workspaceDir: "/tmp/project",
      hostPort: 41002,
      scriptName: "dev",
      isVite: true,
      isNext: false,
      userId: 1001,
      groupId: 1001,
    });

    const command = args.at(-1) || "";
    expect(command).toContain("npm ci --no-audit --no-fund");
    expect(command).toContain("npm install --no-audit --no-fund --no-package-lock");
    expect(command).toContain("npm run dev -- --host 0.0.0.0 --port 4173 --strictPort");
  });
});

describe("Studio preview resolution & runtime bridge", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("prioritizes dist/index.html and dist assets over unbundled Vite root index.html", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-preview-dist-"));
    tmpDirs.push(dataDir);
    const project: Project = {
      id: "proj-prev",
      organizationId: "org-1",
      leadId: "lead-1",
      contractId: "ctr-1",
      title: "Preview App",
      status: "in_progress",
      targetStack: ["react", "vite"],
      budgetAmount: 2000,
      currency: "EUR",
      estimatedDays: 3,
      workspacePath: "projects/proj-prev",
      technicalSpecs: "",
      handoffSummary: "",
      handoffAt: Date.now(),
      deliveredAt: null,
      acceptedAt: null,
      createdBy: "operator",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeWorkspaceFile(dataDir, project, "index.html", `<script type="module" src="/src/main.tsx"></script>`);
    writeWorkspaceFile(dataDir, project, "dist/index.html", `<script type="module" src="/assets/index-123.js"></script>`);
    writeWorkspaceFile(dataDir, project, "dist/assets/index-123.js", `console.log("built");`);

    const resolvedHtml = resolveStudioPreviewAsset(dataDir, project, "index.html");
    expect(resolvedHtml.relPath).toBe("dist/index.html");

    const resolvedAsset = resolveStudioPreviewAsset(dataDir, project, "assets/index-123.js");
    expect(resolvedAsset.relPath).toBe("dist/assets/index-123.js");
    expect(resolvedAsset.data.toString("utf8")).toContain("built");

    const relRewritten = rewritePreviewHtmlForStudio(resolvedHtml.data.toString("utf8"), {
      relativeAssets: true,
      injectBridge: true,
    });
    expect(relRewritten).toContain('src="./assets/index-123.js"');
    expect(relRewritten).toContain("amb-studio-preview");

    const proxyRewritten = rewritePreviewHtmlForStudio(`<script src="/@vite/client"></script>`, {
      basePrefix: "/amb/api/agency/org-1/projects/proj-prev/studio/live/",
      injectBridge: true,
    });
    expect(proxyRewritten).toContain('src="/amb/api/agency/org-1/projects/proj-prev/studio/live/@vite/client"');

    const caps = detectStudioExecutionCapabilities();
    expect(["host", "container"]).toContain(caps.recommendedMode);
  });
});
