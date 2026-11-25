import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ModelClient } from "../llm/client.js";
import { AgencyError } from "./errors.js";
import { getAgentProfile } from "./orchestrator.js";
import type { AgencyMission, Contract, Project, ProjectLot } from "./types.js";

export type AgencyCliAction =
  | "git_status"
  | "npm_test"
  | "npm_typecheck"
  | "npm_build"
  | "claude_brief"
  | "codex_brief";

export type AgencyMissionExecutionMode = "brief_export" | "llm_draft" | "cli_tool";

const CLI_TIMEOUT_MS = 90_000;
const CLI_MAX_BUFFER = 1_048_576;

export function resolveSafeWorkspacePath(
  dataDir: string,
  workspacePath: string,
): { rootDir: string; workspaceDir: string; relativePath: string } {
  const rootDir = path.resolve(dataDir, "agency-workspaces");
  const raw = String(workspacePath ?? "").trim();
  if (!raw || raw.includes("\0")) {
    throw new AgencyError("VALIDATION_ERROR", "Workspace path is required");
  }
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    throw new AgencyError("FORBIDDEN", "Absolute workspace paths are not allowed");
  }

  let normalized = raw.replaceAll("\\", "/").replace(/\/+/g, "/");
  if (normalized.startsWith("workspaces/")) {
    normalized = normalized.slice("workspaces/".length);
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
    throw new AgencyError("FORBIDDEN", "Workspace path contains disallowed traversal segments");
  }

  const relativePath = segments.join("/");
  const workspaceDir = path.resolve(rootDir, ...segments);
  if (workspaceDir !== rootDir && !workspaceDir.startsWith(rootDir + path.sep)) {
    throw new AgencyError("FORBIDDEN", "Workspace path escapes agency workspace root");
  }

  assertNoSymlinkInHierarchy(rootDir, segments);
  return { rootDir, workspaceDir, relativePath };
}

function assertNoSymlinkInHierarchy(rootDir: string, segments: readonly string[]): void {
  if (fs.existsSync(rootDir) && fs.lstatSync(rootDir).isSymbolicLink()) {
    throw new AgencyError("FORBIDDEN", "Agency workspace root cannot be a symbolic link");
  }
  let current = rootDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new AgencyError("FORBIDDEN", "Workspace path cannot traverse symbolic links");
    }
  }
}

const PROTECTED_SYSTEM_PATHS_WIN = new Set([
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "system volume information",
]);

const PROTECTED_SYSTEM_PATHS_POSIX = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
  "/system",
  "/library",
]);

export function validateLocalProductDirectory(rawPath: string): string {
  const raw = String(rawPath ?? "").trim();
  if (!raw || raw.includes("\0")) {
    throw new AgencyError("VALIDATION_ERROR", "Local directory path is required");
  }
  if (raw.split(/[\\/]+/).some((seg) => seg === "..")) {
    throw new AgencyError("FORBIDDEN", "Local directory path cannot contain parent traversal segments");
  }
  if (!path.isAbsolute(raw)) {
    throw new AgencyError("VALIDATION_ERROR", "Local product directory must be an absolute path on the machine");
  }
  const resolved = path.resolve(raw);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new AgencyError("FORBIDDEN", "Filesystem root directories cannot be linked as a product workspace");
  }
  if (process.platform === "win32") {
    const rest = resolved.slice(parsed.root.length).replaceAll("\\", "/").toLowerCase();
    const firstSeg = rest.split("/")[0] || "";
    if (PROTECTED_SYSTEM_PATHS_WIN.has(firstSeg)) {
      throw new AgencyError("FORBIDDEN", `Protected OS directory cannot be linked: ${resolved}`);
    }
  } else {
    const lower = resolved.replace(/\/+$/, "").toLowerCase() || "/";
    if (PROTECTED_SYSTEM_PATHS_POSIX.has(lower)) {
      throw new AgencyError("FORBIDDEN", `Protected OS directory cannot be linked: ${resolved}`);
    }
  }
  if (!fs.existsSync(resolved)) {
    throw new AgencyError("NOT_FOUND", `Local directory does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new AgencyError("VALIDATION_ERROR", `Local path is not a directory: ${resolved}`);
  }
  return resolved;
}

export function resolveProjectDirectory(
  dataDir: string,
  project: Pick<Project, "workspacePath" | "localPath">,
): { workspaceDir: string; mode: "linked" | "managed"; displayPath: string; relativePath: string } {
  const linked = String(project.localPath ?? "").trim();
  if (linked) {
    const resolved = validateLocalProductDirectory(linked);
    return { workspaceDir: resolved, mode: "linked", displayPath: resolved, relativePath: resolved };
  }
  const managed = resolveSafeWorkspacePath(dataDir, project.workspacePath);
  return {
    workspaceDir: managed.workspaceDir,
    mode: "managed",
    displayPath: managed.workspaceDir,
    relativePath: managed.relativePath,
  };
}

export function initProjectWorkspace(input: {
  dataDir: string;
  project: Project;
  contract?: Contract;
  lots: readonly ProjectLot[];
}): { relativePath: string; mode: "linked" | "managed"; directory: string; files: string[] } {
  const resolved = resolveProjectDirectory(input.dataDir, input.project);
  const workspaceDir = resolved.workspaceDir;
  fs.mkdirSync(workspaceDir, { recursive: true });
  const metaDir = resolved.mode === "linked" ? path.join(workspaceDir, ".anymodelbot") : workspaceDir;
  fs.mkdirSync(path.join(metaDir, "missions"), { recursive: true });
  fs.mkdirSync(path.join(metaDir, "qa"), { recursive: true });

  const briefLines: string[] = [
    `# ${input.project.title}`,
    "",
    `- Project ID: ${input.project.id}`,
    `- Status: ${input.project.status}`,
    `- Budget: ${input.project.budgetAmount} ${input.project.currency}`,
    `- Estimated Days: ${input.project.estimatedDays}`,
    `- Target Stack: ${input.project.targetStack.join(", ") || "standard"}`,
    "",
    "## Technical Specifications",
    input.project.technicalSpecs || "(none specified)",
  ];

  if (input.contract) {
    briefLines.push(
      "",
      "## Contractual Scope",
      input.contract.scopeSummary || "(none)",
      "",
      "## Deliverables",
      ...(input.contract.deliverables.length > 0
        ? input.contract.deliverables.map((d) => `- ${d}`)
        : ["- Per accepted quote"]),
    );
  }

  briefLines.push("", "## Project Lots");
  if (input.lots.length === 0) {
    briefLines.push("- No lots defined yet.");
  } else {
    for (const lot of input.lots) {
      briefLines.push(
        `### #${lot.lotOrder} ${lot.title} (${lot.ownerRole} · ${lot.status})`,
        lot.description || "(no description)",
        "Acceptance criteria:",
        ...(lot.acceptanceCriteria.length > 0
          ? lot.acceptanceCriteria.map((c) => `- ${c}`)
          : ["- Verified with test or command evidence"]),
        "",
      );
    }
  }

  const briefRel = resolved.mode === "linked" ? ".anymodelbot/BRIEF.md" : "BRIEF.md";
  fs.writeFileSync(path.join(workspaceDir, briefRel), briefLines.join("\n"), "utf8");
  const files = [briefRel];
  if (resolved.mode === "managed") {
    const readmePath = path.join(workspaceDir, "README.md");
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(
        readmePath,
        `# ${input.project.title}\n\nWorkspace initialized for AnyModelBot project \`${input.project.id}\`. See \`BRIEF.md\` for requirements and lots.\n`,
        "utf8",
      );
      files.push("README.md");
    }
  }

  return {
    relativePath: resolved.relativePath,
    mode: resolved.mode,
    directory: workspaceDir,
    files,
  };
}

function execAllowlisted(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          cwd,
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: CLI_MAX_BUFFER,
          shell: false,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
            return;
          }
          const code = typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : 1;
          resolve({
            exitCode: code,
            stdout: stdout ?? "",
            stderr: stderr || error.message || "command failed",
          });
        },
      );
    } catch (error) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: (error as Error).message || "spawn failed",
      });
    }
  });
}

function resolveNpmInvocation(subArgs: string[]): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCli)) {
      return { command: process.execPath, args: [npmCli, ...subArgs] };
    }
  }
  return { command: "npm", args: subArgs };
}

function resolveCliSpec(action: AgencyCliAction, missionBrief: string): { command: string; args: string[] } {
  const isWin = process.platform === "win32";
  switch (action) {
    case "git_status":
      return { command: "git", args: ["status", "--short"] };
    case "npm_test":
      return resolveNpmInvocation(["test"]);
    case "npm_typecheck":
      return resolveNpmInvocation(["run", "typecheck"]);
    case "npm_build":
      return resolveNpmInvocation(["run", "build"]);
    case "claude_brief":
      return { command: isWin ? "claude.cmd" : "claude", args: ["-p", missionBrief] };
    case "codex_brief":
      return { command: isWin ? "codex.cmd" : "codex", args: ["exec", missionBrief] };
    default:
      throw new AgencyError("VALIDATION_ERROR", `Unsupported cliAction: ${String(action)}`);
  }
}

export async function executeAgencyMission(input: {
  dataDir: string;
  project?: Project;
  mission: AgencyMission;
  mode: AgencyMissionExecutionMode;
  cliAction?: AgencyCliAction;
  modelClient?: ModelClient;
  defaultModel?: string;
  hasLlmEndpoint?: boolean;
  agentInstructions?: string;
  agentRules?: readonly string[];
}): Promise<{
  status: "completed" | "failed";
  outputSummary: string;
  evidencePaths: string[];
  artifactContent?: string;
}> {
  const workspaceDir = input.project
    ? resolveProjectDirectory(input.dataDir, input.project).workspaceDir
    : resolveSafeWorkspacePath(input.dataDir, `mission-sandbox/${input.mission.id}`).workspaceDir;
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "missions"), { recursive: true });

  const briefText =
    input.mission.brief?.trim() ||
    `# Mission: ${input.mission.title}\nRole: ${input.mission.agentRole}\nObjective: ${input.mission.objective}\n`;

  if (input.mode === "brief_export") {
    const relPath = `missions/${input.mission.id}.md`;
    fs.writeFileSync(path.join(workspaceDir, relPath), briefText, "utf8");
    return {
      status: "completed",
      outputSummary: `Execution brief exported to ${relPath}`,
      evidencePaths: [relPath],
      artifactContent: briefText,
    };
  }

  if (input.mode === "llm_draft") {
    if (!input.hasLlmEndpoint || !input.modelClient) {
      throw new AgencyError("VALIDATION_ERROR", "No AI model endpoint is configured in Settings");
    }
    let model = input.defaultModel?.trim() || "";
    if (!model) {
      const models = await input.modelClient.listModels();
      model = models[0] ?? "";
    }
    if (!model) {
      throw new AgencyError("VALIDATION_ERROR", "No available AI models returned by the configured endpoint");
    }

    const profile = getAgentProfile(input.mission.agentRole);
    const rulesLine = input.agentRules?.length
      ? `\nAgent rules:\n${input.agentRules.map((r) => `- ${r}`).join("\n")}`
      : "";
    const extraPrompt = input.agentInstructions?.trim()
      ? `\nConfigured instructions: ${input.agentInstructions.trim()}`
      : "";
    const responseText = await input.modelClient.streamChat(
      {
        model,
        messages: [
          {
            role: "system",
            content: `You are ${profile.name} (${profile.role}). Mission: ${profile.mission}.${extraPrompt}${rulesLine}\nStay strictly factual, concrete, and concise. Never invent verified test results or fake approvals.`,
          },
          {
            role: "user",
            content: `Produce the actionable technical deliverable / implementation plan for:\n\n${briefText}`,
          },
        ],
      },
      () => {},
    );

    const content = responseText.trim() || "(empty model response)";
    const relPath = `missions/${input.mission.id}-output.md`;
    fs.writeFileSync(path.join(workspaceDir, relPath), content, "utf8");
    return {
      status: "completed",
      outputSummary: content.slice(0, 600),
      evidencePaths: [relPath],
      artifactContent: content,
    };
  }

  if (input.mode === "cli_tool") {
    const action = input.cliAction ?? "git_status";
    const { command, args } = resolveCliSpec(action, briefText);
    const result = await execAllowlisted(command, args, workspaceDir);
    const relPath = `missions/${input.mission.id}-run.log`;
    const logContent = [
      `$ ${command} ${action === "claude_brief" || action === "codex_brief" ? "<brief>" : args.join(" ")}`,
      `exitCode=${result.exitCode}`,
      "",
      "--- STDOUT ---",
      result.stdout.trim() || "(empty)",
      "",
      "--- STDERR ---",
      result.stderr.trim() || "(empty)",
    ].join("\n");
    fs.writeFileSync(path.join(workspaceDir, relPath), logContent, "utf8");

    const summary = (result.stdout || result.stderr || `exit ${result.exitCode}`).trim().slice(0, 600);
    return {
      status: result.exitCode === 0 ? "completed" : "failed",
      outputSummary: summary,
      evidencePaths: [relPath],
      artifactContent: logContent,
    };
  }

  throw new AgencyError("VALIDATION_ERROR", `Unsupported mission execution mode: ${String(input.mode)}`);
}

export async function runProjectWorkspaceQa(input: {
  dataDir: string;
  project: Project;
}): Promise<{
  passed: boolean;
  status: "passed" | "failed";
  title: string;
  evidence: string;
  findings: string;
  logPath: string;
  commandsRun: string[];
}> {
  const resolved = resolveProjectDirectory(input.dataDir, input.project);
  const workspaceDir = resolved.workspaceDir;
  if (!fs.existsSync(workspaceDir)) {
    throw new AgencyError("CONFLICT", "Project workspace is not initialized yet. Initialize the workspace first.");
  }

  fs.mkdirSync(path.join(workspaceDir, "qa"), { recursive: true });
  const hasBrief =
    fs.existsSync(path.join(workspaceDir, "BRIEF.md")) ||
    fs.existsSync(path.join(workspaceDir, ".anymodelbot", "BRIEF.md"));
  const commandsRun: string[] = [];
  const logSections: string[] = [`BRIEF.md present: ${hasBrief}`];
  let allPassed = hasBrief;

  const pkgPath = path.join(workspaceDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    let scripts: Record<string, string> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (parsed?.scripts && typeof parsed.scripts === "object") scripts = parsed.scripts;
    } catch {
      allPassed = false;
      logSections.push("Invalid package.json JSON");
    }

    if (typeof scripts.typecheck === "string" && scripts.typecheck.trim()) {
      commandsRun.push("npm run typecheck");
      const spec = resolveNpmInvocation(["run", "typecheck"]);
      const r = await execAllowlisted(spec.command, spec.args, workspaceDir);
      logSections.push(`\n$ npm run typecheck (exit=${r.exitCode})\n${r.stdout}\n${r.stderr}`);
      if (r.exitCode !== 0) allPassed = false;
    }
    if (typeof scripts.test === "string" && scripts.test.trim()) {
      commandsRun.push("npm test");
      const spec = resolveNpmInvocation(["test"]);
      const r = await execAllowlisted(spec.command, spec.args, workspaceDir);
      logSections.push(`\n$ npm test (exit=${r.exitCode})\n${r.stdout}\n${r.stderr}`);
      if (r.exitCode !== 0) allPassed = false;
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = `qa/qa-${stamp}.log`;
  fs.writeFileSync(path.join(workspaceDir, logPath), logSections.join("\n"), "utf8");

  return {
    passed: allPassed,
    status: allPassed ? "passed" : "failed",
    title: "Automated workspace QA check",
    evidence: `${logPath}${commandsRun.length > 0 ? ` (${commandsRun.join(", ")})` : " (BRIEF.md check)"}`,
    findings: allPassed ? "" : hasBrief ? "One or more workspace scripts failed." : "Missing BRIEF.md in workspace.",
    logPath,
    commandsRun,
  };
}
