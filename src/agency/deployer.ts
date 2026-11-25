import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgencyError } from "./errors.js";
import type { Project } from "./types.js";
import { resolveProjectDirectory } from "./workspace-runner.js";

export type DeployAdapterId = "docker_compose" | "vercel" | "cloudflare_wrangler" | "npm_deploy";

export interface DeployAdapterInfo {
  id: DeployAdapterId;
  name: string;
  available: boolean;
  command: string;
  detectedPath?: string;
}

export interface DeploymentHealthResult {
  healthy: boolean;
  url: string;
  statusCode: number;
  responseTimeMs: number;
  checkedAt: number;
  error?: string;
}

function locateCmd(command: string): string {
  try {
    const tool = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(tool, [command], {
      timeout: 1500,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  } catch {
    return "";
  }
}

export function detectDeployAdapters(projectDir?: string): DeployAdapterInfo[] {
  const dockerPath = locateCmd("docker");
  const vercelPath = locateCmd("vercel");
  const wranglerPath = locateCmd("wrangler");

  let hasNpmDeploy = false;
  if (projectDir) {
    const pkgPath = path.join(projectDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
        hasNpmDeploy = typeof pkg.scripts?.deploy === "string" && pkg.scripts.deploy.trim().length > 0;
      } catch {
        hasNpmDeploy = false;
      }
    }
  }

  return [
    {
      id: "docker_compose",
      name: "Docker Compose (up -d --build)",
      available: Boolean(dockerPath),
      command: "docker compose up -d --build",
      ...(dockerPath ? { detectedPath: dockerPath } : {}),
    },
    {
      id: "vercel",
      name: "Vercel CLI (--prod --yes)",
      available: Boolean(vercelPath),
      command: "vercel --prod --yes",
      ...(vercelPath ? { detectedPath: vercelPath } : {}),
    },
    {
      id: "cloudflare_wrangler",
      name: "Cloudflare Wrangler (deploy)",
      available: Boolean(wranglerPath),
      command: "wrangler deploy",
      ...(wranglerPath ? { detectedPath: wranglerPath } : {}),
    },
    {
      id: "npm_deploy",
      name: "Script projet (npm run deploy)",
      available: hasNpmDeploy,
      command: "npm run deploy",
    },
  ];
}

export async function runDeploymentHealthCheck(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeploymentHealthResult> {
  const clean = String(rawUrl ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    throw new AgencyError("VALIDATION_ERROR", "A valid http:// or https:// environmentUrl is required for health check");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AgencyError("VALIDATION_ERROR", "Health check URL must use http or https");
  }
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(parsed.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(8_000),
      headers: { "user-agent": "AnyModelBot-HealthCheck/1.0" },
    });
    return {
      healthy: res.status >= 200 && res.status < 400,
      url: parsed.toString(),
      statusCode: res.status,
      responseTimeMs: Math.max(1, Date.now() - startedAt),
      checkedAt: Date.now(),
    };
  } catch (error) {
    return {
      healthy: false,
      url: parsed.toString(),
      statusCode: 0,
      responseTimeMs: Math.max(1, Date.now() - startedAt),
      checkedAt: Date.now(),
      error: (error as Error).message || "Health check request failed",
    };
  }
}

function resolveCommandSpec(adapter: DeployAdapterId): { command: string; args: string[] } {
  if (adapter === "docker_compose") return { command: "docker", args: ["compose", "up", "-d", "--build"] };
  if (adapter === "vercel") return { command: "vercel", args: ["--prod", "--yes"] };
  if (adapter === "cloudflare_wrangler") return { command: "wrangler", args: ["deploy"] };
  if (adapter === "npm_deploy") {
    if (process.platform === "win32") {
      const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      if (fs.existsSync(npmCli)) return { command: process.execPath, args: [npmCli, "run", "deploy"] };
    }
    return { command: "npm", args: ["run", "deploy"] };
  }
  throw new AgencyError("VALIDATION_ERROR", `Unsupported deployment adapter: ${String(adapter)}`);
}

function execDeployProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const isWinCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const bin = isWinCmd ? process.env.ComSpec || "cmd.exe" : command;
    const finalArgs = isWinCmd ? ["/d", "/s", "/c", command, ...args] : args;
    try {
      execFile(
        bin,
        finalArgs,
        { cwd, timeout: 180_000, maxBuffer: 2 * 1024 * 1024, shell: false, windowsHide: true, encoding: "utf8" },
        (err, stdout, stderr) => {
          const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
          if (!err) {
            resolve({ exitCode: 0, output: combined });
            return;
          }
          const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
          resolve({ exitCode: code, output: combined || err.message || "Deployment command failed" });
        },
      );
    } catch (error) {
      resolve({ exitCode: 1, output: (error as Error).message || "Deployment spawn failed" });
    }
  });
}

export async function executeProjectDeploy(input: {
  dataDir: string;
  project: Project;
  adapter: DeployAdapterId;
  environmentUrl?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{
  ok: boolean;
  adapter: DeployAdapterId;
  rollbackRef: string;
  logPath: string;
  output: string;
  healthCheck?: DeploymentHealthResult;
}> {
  const { workspaceDir, mode } = resolveProjectDirectory(input.dataDir, input.project);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const spec = resolveCommandSpec(input.adapter);

  let rollbackRef = "none";
  try {
    rollbackRef =
      execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: workspaceDir,
        timeout: 2000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim() || "none";
  } catch {
    rollbackRef = "none";
  }

  let exitCode = 0;
  let output = "";
  if (input.dryRun) {
    output = `[dry-run] adapter=${input.adapter} cmd="${spec.command} ${spec.args.join(" ")}" cwd="${workspaceDir}" rollbackRef=${rollbackRef}`;
  } else {
    let resolvedBin = spec.command;
    if (!path.isAbsolute(resolvedBin) && resolvedBin !== process.execPath) {
      const located = locateCmd(resolvedBin);
      if (!located) {
        throw new AgencyError("CONFLICT", `Deployment CLI "${spec.command}" is not installed on this machine`);
      }
      resolvedBin = located;
    }
    const res = await execDeployProcess(resolvedBin, spec.args, workspaceDir);
    exitCode = res.exitCode;
    output = res.output;
  }

  const ts = Date.now();
  const logRel = mode === "linked" ? `.anymodelbot/deployments/deploy-${ts}.log` : `deployments/deploy-${ts}.log`;
  const logAbs = path.join(workspaceDir, logRel);
  fs.mkdirSync(path.dirname(logAbs), { recursive: true });
  fs.writeFileSync(
    logAbs,
    `Adapter: ${input.adapter}\nRollback Git Ref: ${rollbackRef}\nExit Code: ${exitCode}\n\n${output}\n`,
    "utf8",
  );

  const healthCheck =
    exitCode === 0 && input.environmentUrl?.trim()
      ? await runDeploymentHealthCheck(input.environmentUrl.trim(), input.fetchImpl)
      : undefined;

  return {
    ok: exitCode === 0 && (healthCheck ? healthCheck.healthy : true),
    adapter: input.adapter,
    rollbackRef,
    logPath: logRel,
    output: output.slice(0, 6_000),
    ...(healthCheck ? { healthCheck } : {}),
  };
}
