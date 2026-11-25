import { describe, expect, it } from "vitest";
import { buildStudioDockerRunArgs } from "../src/agency/studio-devserver.js";

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
    });

    expect(optionValue(args, "--publish")).toBe("127.0.0.1:43127:4173");
    expect(args).toContain("type=bind,source=/home/user/projects/project-123,target=/workspace");
    expect(args).toContain("type=volume,source=amb-studio-project_123-node-modules,target=/workspace/node_modules");
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
    });

    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges:true");
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
    });

    const command = args.at(-1) || "";
    expect(command).toContain("npm ci --no-audit --no-fund");
    expect(command).toContain("npm install --no-audit --no-fund --no-package-lock");
    expect(command).toContain("npm run dev -- --host 0.0.0.0 --port 4173 --strictPort");
  });
});
