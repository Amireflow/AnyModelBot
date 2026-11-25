import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgencyError } from "./errors.js";
import type {
  AgencyAgentRole,
  AgentProfile,
  DetectedDevTool,
  Project,
  ProjectLot,
} from "./types.js";

export const AGENCY_AGENT_PROFILES: readonly AgentProfile[] = [
  {
    role: "prospecting",
    name: "Prospecting Agent",
    mission: "Discover, enrich, and deduplicate B2B prospects from compliant web and CRM sources.",
    canWriteCode: false,
    canApproveExternal: false,
    independentFromBuild: true,
    defaultTools: ["web-research", "company-research-import"],
  },
  {
    role: "qualification",
    name: "Qualification Agent",
    mission: "Score leads, assess fit/urgency/budget/authority, and log verified research evidence.",
    canWriteCode: false,
    canApproveExternal: false,
    independentFromBuild: true,
    defaultTools: ["qualification-rubric", "research-evidence"],
  },
  {
    role: "commercial",
    name: "Commercial Agent",
    mission: "Run WhatsApp/commercial threads, clarify client needs, and guide bounded negotiation.",
    canWriteCode: false,
    canApproveExternal: false,
    independentFromBuild: true,
    defaultTools: ["whatsapp-cloud", "needs-qualification", "proposal-tiers"],
  },
  {
    role: "estimator",
    name: "Estimator & Quote Agent",
    mission: "Generate deterministic estimates, versioned quotes, and draft contracts within agency guardrails.",
    canWriteCode: false,
    canApproveExternal: false,
    independentFromBuild: true,
    defaultTools: ["service-catalog", "commercial-rules", "quote-builder"],
  },
  {
    role: "project_manager",
    name: "Project Manager Agent",
    mission: "Orchestrate contract-to-production handoff, break scope into lots, track scope changes and timelines.",
    canWriteCode: false,
    canApproveExternal: false,
    independentFromBuild: true,
    defaultTools: ["lot-planner", "scope-change-control", "timeline-audit"],
  },
  {
    role: "architect",
    name: "Software Architect Agent",
    mission: "Produce isolated technical specifications, target stack decisions, security boundaries, and interface contracts.",
    canWriteCode: true,
    canApproveExternal: false,
    independentFromBuild: false,
    defaultTools: ["architecture-spec", "git", "node"],
  },
  {
    role: "developer",
    name: "Fullstack Developer Agent",
    mission: "Implement verified project lots inside the project workspace using approved local dev tools and tests.",
    canWriteCode: true,
    canApproveExternal: false,
    independentFromBuild: false,
    defaultTools: ["claude", "codex", "code", "git", "npm"],
  },
  {
    role: "ui_ux",
    name: "UI/UX & Frontend Agent",
    mission: "Design accessible interfaces, responsive states, visual hierarchy, and design-system tokens.",
    canWriteCode: true,
    canApproveExternal: false,
    independentFromBuild: false,
    defaultTools: ["code", "browser-preview", "design-system"],
  },
  {
    role: "qa_functional",
    name: "Independent Functional QA",
    mission: "Verify user journeys, business rules, and acceptance criteria against contractual scope.",
    canWriteCode: false,
    canApproveExternal: false,
    independentFromBuild: true,
    defaultTools: ["e2e-runner", "acceptance-checklist"],
  },
  {
    role: "qa_technical",
    name: "Independent Technical QA",
    mission: "Verify typecheck, unit/integration suites, builds, migrations, and reproducibility with logs.",
    canWriteCode: false,
    canApproveExternal: false,
    independentFromBuild: true,
    defaultTools: ["vitest", "tsc", "npm"],
  },
  {
    role: "qa_ui_ux",
    name: "Independent UI/UX QA",
    mission: "Inspect real browser rendering, console errors, responsiveness, and i18n coverage.",
    canWriteCode: false,
    canApproveExternal: false,
    independentFromBuild: true,
    defaultTools: ["browser-inspect", "i18n-check"],
  },
  {
    role: "qa_security",
    name: "Independent Security QA",
    mission: "Audit tenant isolation, auth boundaries, consent enforcement, approval hashes, and secret redaction.",
    canWriteCode: false,
    canApproveExternal: false,
    independentFromBuild: true,
    defaultTools: ["security-audit", "policy-gate"],
  },
  {
    role: "retention",
    name: "Client Success & Retention Agent",
    mission: "Manage post-delivery acceptance, satisfaction checks, maintenance renewals, and upsell opportunities.",
    canWriteCode: false,
    canApproveExternal: false,
    independentFromBuild: true,
    defaultTools: ["followup-scheduler", "crm-timeline"],
  },
];

export function getAgentProfile(role: AgencyAgentRole): AgentProfile {
  const found = AGENCY_AGENT_PROFILES.find((p) => p.role === role);
  if (!found) {
    throw new AgencyError("VALIDATION_ERROR", `Unknown agency agent role: ${String(role)}`, {
      role,
    });
  }
  return found;
}

interface ToolProbeSpec {
  id: string;
  name: string;
  command: string;
  winCmd?: string;
  category: DetectedDevTool["category"];
}

const TOOL_PROBES: readonly ToolProbeSpec[] = [
  { id: "git", name: "Git", command: "git", category: "vcs" },
  { id: "node", name: "Node.js", command: "node", category: "runtime" },
  { id: "npm", name: "npm", command: "npm", winCmd: "npm.cmd", category: "runtime" },
  { id: "antigravity", name: "Antigravity IDE", command: "antigravity", winCmd: "antigravity.cmd", category: "ide" },
  { id: "code", name: "VS Code", command: "code", winCmd: "code.cmd", category: "ide" },
  { id: "cursor", name: "Cursor", command: "cursor", winCmd: "cursor.cmd", category: "ide" },
  { id: "windsurf", name: "Windsurf", command: "windsurf", winCmd: "windsurf.cmd", category: "ide" },
  { id: "claude", name: "Claude Code CLI", command: "claude", winCmd: "claude.cmd", category: "cli_agent" },
  { id: "codex", name: "OpenAI Codex CLI", command: "codex", winCmd: "codex.cmd", category: "cli_agent" },
  { id: "gemini", name: "Gemini CLI", command: "gemini", winCmd: "gemini.cmd", category: "cli_agent" },
  { id: "aider", name: "Aider", command: "aider", category: "cli_agent" },
  { id: "opencode", name: "OpenCode", command: "opencode", winCmd: "opencode.cmd", category: "cli_agent" },
];

/**
 * Read-only local developer toolchain detection using fixed command names (never user input).
 */
export function detectLocalDevTools(): DetectedDevTool[] {
  const isWin = process.platform === "win32";
  const npmCli = isWin ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : "";
  return TOOL_PROBES.map((spec) => {
    try {
      let output = "";
      if (isWin && spec.id === "npm" && fs.existsSync(npmCli)) {
        output = execFileSync(process.execPath, [npmCli, "--version"], {
          timeout: 1500,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } else {
        const executable = isWin && spec.winCmd ? spec.winCmd : spec.command;
        output = execFileSync(executable, ["--version"], {
          timeout: 1500,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      }
      const version = output.split(/\r?\n/)[0]?.trim() || "detected";
      return {
        id: spec.id,
        name: spec.name,
        command: spec.command,
        category: spec.category,
        available: true,
        version: version.slice(0, 80),
      };
    } catch {
      return {
        id: spec.id,
        name: spec.name,
        command: spec.command,
        category: spec.category,
        available: false,
        version: "",
      };
    }
  });
}

export interface BuildExecutionBriefInput {
  project: Project;
  lot?: ProjectLot;
  agentRole: AgencyAgentRole;
  preferredTool?: string;
  objective?: string;
  availableTools?: readonly DetectedDevTool[];
}

export function buildProjectExecutionBrief(input: BuildExecutionBriefInput): string {
  const profile = getAgentProfile(input.agentRole);
  const available = (input.availableTools ?? []).filter((t) => t.available).map((t) => t.id);
  const chosenTool =
    input.preferredTool?.trim() ||
    profile.defaultTools.find((t) => available.includes(t)) ||
    profile.defaultTools[0] ||
    "node";

  const lines: string[] = [
    `# Execution Brief — ${input.project.title}`,
    `- Agent Role: ${profile.name} (${profile.role})`,
    `- Independent QA Separation: ${profile.independentFromBuild ? "yes (read/verify only)" : "no (implementation role)"}`,
    `- Workspace Path: ${input.project.workspacePath}`,
    `- Preferred Tool: ${chosenTool}`,
    `- Detected Local Tools: ${available.length > 0 ? available.join(", ") : "none recorded"}`,
    `- Target Stack: ${input.project.targetStack.length > 0 ? input.project.targetStack.join(", ") : "standard web/node stack"}`,
  ];

  if (input.lot) {
    lines.push(
      ``,
      `## Assigned Lot #${input.lot.lotOrder}: ${input.lot.title}`,
      `- Description: ${input.lot.description || "(none)"}`,
      `- Dependencies: ${input.lot.dependencies.length > 0 ? input.lot.dependencies.join(", ") : "none"}`,
      `- Estimated Hours: ${input.lot.estimatedHours}h`,
      `- Acceptance Criteria:`,
      ...(input.lot.acceptanceCriteria.length > 0
        ? input.lot.acceptanceCriteria.map((c) => `  - ${c}`)
        : ["  - Passes unit/integration verification with recorded evidence"]),
    );
  }

  lines.push(
    ``,
    `## Objective`,
    input.objective?.trim() || profile.mission,
    ``,
    `## Governance & Guardrails`,
    `- Stay inside project workspace (${input.project.workspacePath}); never modify external unrelated apps.`,
    `- Record reproducible command output, test counts, and artifact paths as evidence.`,
    `- Never bypass owner approval gates for scope changes or production deployments.`,
  );

  return lines.join("\n");
}
