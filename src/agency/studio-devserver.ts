/**
 * Managed local dev server runner for AnyModelBot Studio (Dyad-style).
 *
 * Detects Vite/React/Node dev scripts inside a confined project workspace,
 * installs dependencies on first run if needed, spawns the dev server on a
 * free loopback port (`127.0.0.1:<port>`), streams logs into a ring buffer,
 * and cleans up idle processes automatically.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { AgencyError } from "./errors.js";
import type { Project } from "./types.js";
import { resolveSafeWorkspacePath } from "./workspace-runner.js";

export type DevServerState = "stopped" | "installing" | "starting" | "running" | "error";

export type StudioExecutionMode = "container" | "host";

export interface StudioDevServerStatus {
  projectId: string;
  running: boolean;
  executionMode: StudioExecutionMode | null;
  status: DevServerState;
  hasDevScript: boolean;
  port: number | null;
  url: string | null;
  logs: string[];
  error?: string;
  startedAt?: number;
}

interface RunningServer {
  projectId: string;
  workspaceDir: string;
  port: number;
  url: string;
  status: DevServerState;
  child: ChildProcess | null;
  executionMode: StudioExecutionMode;
  containerName?: string;
  logs: string[];
  error?: string;
  startedAt: number;
  lastTouch: number;
}

const MAX_LOGS = 120;
const IDLE_TTL_MS = 20 * 60_000;
const HOST_START_TIMEOUT_MS = 25_000;
const CONTAINER_START_TIMEOUT_MS = 120_000;
const STUDIO_CONTAINER_IMAGE = "node:22-alpine";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function safeProjectToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 40) || "project";
}

function minimalHostEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.NODE_ENV = "development";
  env.PORT = String(port);
  env.HOST = "127.0.0.1";
  env.HOSTNAME = "127.0.0.1";
  env.BROWSER = "none";
  env.FORCE_COLOR = "0";
  return env;
}

function runExecFile(command: string, args: string[], timeout: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024, shell: false, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
        ? Number((error as NodeJS.ErrnoException & { code: number }).code)
        : 1;
      resolve({ code, stdout: stdout ?? "", stderr: stderr || (error as Error | null)?.message || "" });
    });
  });
}

/** Builds a least-privilege Docker invocation without inheriting host environment secrets. */
export function buildStudioDockerRunArgs(input: {
  projectId: string;
  workspaceDir: string;
  hostPort: number;
  scriptName: "dev" | "start";
  isVite: boolean;
  isNext: boolean;
}): string[] {
  const token = safeProjectToken(input.projectId);
  const containerName = `amb-studio-${token}`;
  const volumeName = `amb-studio-${token}-node-modules`;
  const serve = input.isVite
    ? `npm run ${input.scriptName} -- --host 0.0.0.0 --port 4173 --strictPort`
    : input.isNext
      ? `npm run ${input.scriptName} -- -H 0.0.0.0 -p 4173`
      : `npm run ${input.scriptName}`;
  const command = [
    "set -eu",
    "if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund --no-package-lock; fi",
    `exec ${serve}`,
  ].join(" && ");

  return [
    "run", "--detach", "--name", containerName,
    "--label", "io.anymodelbot.studio=true",
    "--label", `io.anymodelbot.project=${token}`,
    "--restart", "no",
    "--read-only",
    "--pids-limit=128",
    "--memory=1024m",
    "--cpus=1.5",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m",
    "--mount", `type=bind,source=${input.workspaceDir},target=/workspace`,
    "--mount", `type=volume,source=${volumeName},target=/workspace/node_modules`,
    "--publish", `127.0.0.1:${input.hostPort}:4173`,
    "--workdir", "/workspace",
    "--env", "NODE_ENV=development",
    "--env", "HOME=/tmp",
    "--env", "TMPDIR=/tmp",
    "--env", "npm_config_cache=/tmp/npm-cache",
    "--env", "PORT=4173",
    "--env", "HOST=0.0.0.0",
    "--env", "HOSTNAME=0.0.0.0",
    "--env", "BROWSER=none",
    "--network", "bridge",
    STUDIO_CONTAINER_IMAGE,
    "sh", "-lc", command,
  ];
}

async function ensureDockerRuntime(srv: RunningServer): Promise<void> {
  const info = await runExecFile("docker", ["info", "--format", "{{.ServerVersion}}"], 12_000);
  if (info.code !== 0) {
    throw new AgencyError("CONFLICT", "L'aperçu isolé nécessite Docker Desktop ou Docker Engine démarré. Choisissez le mode local de confiance si vous ne pouvez pas utiliser Docker.");
  }
  const image = await runExecFile("docker", ["image", "inspect", STUDIO_CONTAINER_IMAGE], 12_000);
  if (image.code === 0) return;
  srv.status = "installing";
  pushLog(srv, `$ docker pull ${STUDIO_CONTAINER_IMAGE}`);
  const pull = await runExecFile("docker", ["pull", STUDIO_CONTAINER_IMAGE], 180_000);
  if (pull.stdout) pushLog(srv, pull.stdout);
  if (pull.stderr) pushLog(srv, pull.stderr);
  if (pull.code !== 0) throw new AgencyError("CONFLICT", `Impossible de récupérer l'image d'aperçu ${STUDIO_CONTAINER_IMAGE}: ${(pull.stderr || pull.stdout).slice(0, 500)}`);
}

async function removeContainer(containerName: string): Promise<void> {
  await runExecFile("docker", ["rm", "-f", containerName], 15_000);
}

const servers = new Map<string, RunningServer>();
let cleanupHooked = false;

function hookProcessCleanup(): void {
  if (cleanupHooked) return;
  cleanupHooked = true;
  const stopAll = () => {
    for (const id of [...servers.keys()]) {
      stopStudioDevServer(id);
    }
  };
  process.once("exit", stopAll);
  process.once("SIGINT", stopAll);
  process.once("SIGTERM", stopAll);

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, srv] of servers.entries()) {
      if (now - srv.lastTouch > IDLE_TTL_MS) {
        stopStudioDevServer(id);
      }
    }
  }, 60_000);
  timer.unref?.();
}

function pushLog(srv: RunningServer, chunk: string): void {
  const lines = chunk
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
  for (const line of lines) {
    srv.logs.push(line.slice(0, 400));
    if (srv.logs.length > MAX_LOGS) srv.logs.shift();
  }
}

function resolveNpmSpec(subArgs: string[]): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCli)) {
      return { command: process.execPath, args: [npmCli, ...subArgs] };
    }
  }
  return { command: "npm", args: subArgs };
}

export function detectProjectDevScript(dataDir: string, project: Project): {
  workspaceDir: string;
  hasDevScript: boolean;
  isVite: boolean;
  isNext: boolean;
  scriptName: "dev" | "start" | "";
  devScript: string;
  hasDependencies: boolean;
} {
  const { workspaceDir } = resolveSafeWorkspacePath(dataDir, project.workspacePath);
  const pkgPath = path.join(workspaceDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return { workspaceDir, hasDevScript: false, isVite: false, isNext: false, scriptName: "", devScript: "", hasDependencies: false };
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const devScript = String(pkg.scripts?.dev ?? "").trim();
    const startScript = String(pkg.scripts?.start ?? "").trim();
    const scriptName: "dev" | "start" | "" = devScript ? "dev" : startScript ? "start" : "";
    const activeScript = devScript || startScript;
    const hasDependencies =
      Object.keys(pkg.dependencies ?? {}).length > 0 || Object.keys(pkg.devDependencies ?? {}).length > 0;
    return {
      workspaceDir,
      hasDevScript: scriptName !== "",
      isVite: /\bvite\b/i.test(activeScript),
      isNext: /\bnext\b/i.test(activeScript),
      scriptName,
      devScript: activeScript,
      hasDependencies,
    };
  } catch {
    return { workspaceDir, hasDevScript: false, isVite: false, isNext: false, scriptName: "", devScript: "", hasDependencies: false };
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function waitForPort(port: number, timeoutMs: number, isAborted: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      if (isAborted()) {
        resolve(false);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function runNpmInstall(workspaceDir: string, srv: RunningServer): Promise<{ ok: boolean; error?: string }> {
  const spec = resolveNpmSpec(["install", "--no-audit", "--no-fund"]);
  return new Promise((resolve) => {
    execFile(
      spec.command,
      spec.args,
      { cwd: workspaceDir, env: minimalHostEnv(srv.port), timeout: 120_000, maxBuffer: 2 * 1024 * 1024, shell: false, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (stdout) pushLog(srv, stdout);
        if (stderr) pushLog(srv, stderr);
        if (!err) {
          resolve({ ok: true });
          return;
        }
        resolve({ ok: false, error: (stderr || err.message || "npm install failed").slice(0, 400) });
      },
    );
  });
}

export function getStudioDevServerStatus(dataDir: string, project: Project): StudioDevServerStatus {
  const info = detectProjectDevScript(dataDir, project);
  const srv = servers.get(project.id);
  if (!srv) {
    return {
      projectId: project.id,
      running: false,
      status: "stopped",
      executionMode: null,
      hasDevScript: info.hasDevScript,
      port: null,
      url: null,
      logs: [],
    };
  }
  srv.lastTouch = Date.now();
  return {
    projectId: project.id,
    running: srv.status === "running",
    status: srv.status,
    executionMode: srv.executionMode,
    hasDevScript: info.hasDevScript,
    port: srv.port,
    url: srv.status === "running" ? srv.url : null,
    logs: [...srv.logs],
    ...(srv.error ? { error: srv.error } : {}),
    startedAt: srv.startedAt,
  };
}

export function stopStudioDevServer(projectId: string): StudioDevServerStatus {
  const srv = servers.get(projectId);
  if (srv) {
    if (srv.containerName) void removeContainer(srv.containerName);
    if (srv.child && !srv.child.killed) {
      try {
        if (process.platform === "win32" && srv.child.pid) {
          execFile("taskkill", ["/pid", String(srv.child.pid), "/T", "/F"], { windowsHide: true }, () => {});
        } else {
          srv.child.kill("SIGTERM");
        }
      } catch {
        /* best effort */
      }
    }
    servers.delete(projectId);
  }
  return {
    projectId,
    running: false,
    status: "stopped",
    executionMode: null,
    hasDevScript: false,
    port: null,
    url: null,
    logs: [],
  };
}

export async function startStudioDevServer(
  dataDir: string,
  project: Project,
  opts?: { restart?: boolean; executionMode?: StudioExecutionMode },
): Promise<StudioDevServerStatus> {
  hookProcessCleanup();
  const info = detectProjectDevScript(dataDir, project);
  if (!info.hasDevScript || !info.scriptName) {
    throw new AgencyError("CONFLICT", "No 'dev' or 'start' script found in package.json for this project");
  }

  const executionMode = opts?.executionMode === "host" ? "host" : "container";
  const existing = servers.get(project.id);
  if (!opts?.restart && existing && existing.status === "running" && existing.executionMode === executionMode && existing.child && !existing.child.killed) {
    existing.lastTouch = Date.now();
    return getStudioDevServerStatus(dataDir, project);
  }
  if (existing) {
    stopStudioDevServer(project.id);
  }

  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const srv: RunningServer = {
    projectId: project.id,
    workspaceDir: info.workspaceDir,
    port,
    url,
    status: executionMode === "container" ? "installing" : "starting",
    child: null,
    executionMode,
    logs: [],
    startedAt: Date.now(),
    lastTouch: Date.now(),
  };
  servers.set(project.id, srv);

  if (executionMode === "container") {
    try {
      await ensureDockerRuntime(srv);
      const containerName = `amb-studio-${safeProjectToken(project.id)}`;
      await removeContainer(containerName);
      const args = buildStudioDockerRunArgs({
        projectId: project.id,
        workspaceDir: info.workspaceDir,
        hostPort: port,
        scriptName: info.scriptName,
        isVite: info.isVite,
        isNext: info.isNext,
      });
      pushLog(srv, "$ docker " + args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" "));
      const started = await runExecFile("docker", args, 45_000);
      if (started.stdout) pushLog(srv, started.stdout);
      if (started.stderr) pushLog(srv, started.stderr);
      if (started.code !== 0) throw new AgencyError("CONFLICT", (started.stderr || started.stdout || "Docker failed to start the preview container").slice(0, 700));
      srv.containerName = containerName;
      const logsChild = spawn("docker", ["logs", "--follow", containerName], {
        shell: false,
        windowsHide: true,
        env: process.env,
      });
      srv.child = logsChild;
      let exited = false;
      logsChild.stdout?.setEncoding("utf8");
      logsChild.stderr?.setEncoding("utf8");
      logsChild.stdout?.on("data", (chunk: string) => pushLog(srv, chunk));
      logsChild.stderr?.on("data", (chunk: string) => pushLog(srv, chunk));
      logsChild.on("error", (err) => {
        exited = true;
        if (servers.get(project.id) === srv) {
          srv.status = "error";
          srv.error = err.message;
          pushLog(srv, `Docker log stream error: ${err.message}`);
        }
      });
      logsChild.on("exit", (code) => {
        exited = true;
        if (servers.get(project.id) === srv && srv.status === "running") {
          srv.status = code === 0 ? "stopped" : "error";
          if (code !== 0) srv.error = `Docker log stream exited with code ${code}`;
        }
      });
      const ready = await waitForPort(port, CONTAINER_START_TIMEOUT_MS, () => exited || servers.get(project.id) !== srv);
      if (ready && !exited && servers.get(project.id) === srv) {
        srv.status = "running";
        srv.lastTouch = Date.now();
      } else if (servers.get(project.id) === srv) {
        srv.status = "error";
        srv.error = "Le conteneur ne démarre pas le serveur sur le port attendu. Consultez les logs puis vérifiez le script dev/start.";
        await removeContainer(containerName);
        logsChild.kill();
      }
    } catch (error) {
      srv.status = "error";
      srv.error = (error as Error).message || "Docker preview failed";
      pushLog(srv, srv.error);
    }
    return getStudioDevServerStatus(dataDir, project);
  }

  const pkgPath = path.join(info.workspaceDir, "package.json");
  const nmPath = path.join(info.workspaceDir, "node_modules");
  const pkgMtime = fs.existsSync(pkgPath) ? fs.statSync(pkgPath).mtimeMs : 0;
  const nmMtime = fs.existsSync(nmPath) ? fs.statSync(nmPath).mtimeMs : 0;
  if (info.hasDependencies && (!fs.existsSync(nmPath) || pkgMtime > nmMtime)) {
    srv.status = "installing";
    pushLog(srv, "$ npm install --no-audit --no-fund");
    const installed = await runNpmInstall(info.workspaceDir, srv);
    if (!installed.ok) {
      srv.status = "error";
      srv.error = installed.error || "npm install failed";
      return getStudioDevServerStatus(dataDir, project);
    }
  }

  srv.status = "starting";
  const devArgs = info.isVite
    ? ["run", info.scriptName, "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"]
    : info.isNext
      ? ["run", info.scriptName, "--", "-H", "127.0.0.1", "-p", String(port)]
      : ["run", info.scriptName];
  const spec = resolveNpmSpec(devArgs);
  pushLog(srv, `$ npm ${devArgs.join(" ")}`);

  const child = spawn(spec.command, spec.args, {
    cwd: info.workspaceDir,
    shell: false,
    windowsHide: true,
    env: minimalHostEnv(port),
  });
  srv.child = child;

  let exited = false;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => pushLog(srv, chunk));
  child.stderr?.on("data", (chunk: string) => pushLog(srv, chunk));
  child.on("error", (err) => {
    exited = true;
    srv.status = "error";
    srv.error = err.message;
    pushLog(srv, `Process error: ${err.message}`);
  });
  child.on("exit", (code) => {
    exited = true;
    if (servers.get(project.id) === srv) {
      srv.status = code === 0 ? "stopped" : "error";
      if (code && code !== 0) srv.error = `Dev server exited with code ${code}`;
      pushLog(srv, `Dev server exited (code=${code ?? "null"})`);
    }
  });

  const ready = await waitForPort(port, HOST_START_TIMEOUT_MS, () => exited || servers.get(project.id) !== srv);
  if (ready && !exited && servers.get(project.id) === srv) {
    srv.status = "running";
    srv.lastTouch = Date.now();
  } else if (servers.get(project.id) === srv && (srv.status as DevServerState) !== "error") {
    srv.status = "error";
    srv.error = "Dev server did not open its port in time";
  }

  return getStudioDevServerStatus(dataDir, project);
}
