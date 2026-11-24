import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "../dsh-runtime/plugins/amb-execution-node-gate.mjs";

const originalBot = process.env.AMB_BOT_ID;
const originalExecutionBot = process.env.AMB_EXECUTION_BOT_ID;
afterEach(() => {
  if (originalBot === undefined) delete process.env.AMB_BOT_ID;
  else process.env.AMB_BOT_ID = originalBot;
  if (originalExecutionBot === undefined) delete process.env.AMB_EXECUTION_BOT_ID;
  else process.env.AMB_EXECUTION_BOT_ID = originalExecutionBot;
});

function agent(id: string, parentSession = "") {
  let guard: ((exec: { name: string }) => string | undefined) | undefined;
  const section = vi.fn();
  const tools = { guard: (fn: typeof guard) => { guard = fn; } };
  return {
    value: {
      id,
      session: { id, header: { parentSession } },
      ctx: { tools, systemPrompt: { section } },
    },
    get guard() { return guard; },
    section,
  };
}

describe("amb-execution-node-gate", () => {
  it("does not change other bots or ordinary chat sessions", () => {
    process.env.AMB_BOT_ID = "ordinary";
    process.env.AMB_EXECUTION_BOT_ID = "flowauto";
    let handler: ((event: { agent: ReturnType<typeof agent>["value"] }) => void) | undefined;
    apply({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as never);
    const chat = agent("web:console");
    handler?.({ agent: chat.value });
    expect(chat.guard).toBeUndefined();
  });

  it("allows only Computer Use and task_report in FlowAuto task sessions", () => {
    process.env.AMB_BOT_ID = "flowauto";
    process.env.AMB_EXECUTION_BOT_ID = "flowauto";
    let handler: ((event: { agent: ReturnType<typeof agent>["value"] }) => void) | undefined;
    apply({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as never);
    const task = agent("task-t_123");
    handler?.({ agent: task.value });
    expect(task.guard?.({ name: "task_report" })).toBeUndefined();
    expect(task.guard?.({ name: "mcp__computer-use__screenshot" })).toBeUndefined();
    expect(task.guard?.({ name: "mcp__computer-use__click" })).toBeUndefined();
    expect(task.guard?.({ name: "bash" })).toMatch(/restricted to Computer Use/);
    expect(task.guard?.({ name: "web_search" })).toMatch(/restricted to Computer Use/);
    expect(task.guard?.({ name: "spawn_agent" })).toMatch(/restricted to Computer Use/);
    expect(task.section).toHaveBeenCalledOnce();
    const rules = (task.section.mock.calls[0]?.[0] as { text: () => string }).text();
    expect(rules).toContain("explicitly approves that exact action through task_report(needs_you)");
    expect(rules).toContain("perform only the approved action");
  });

  it("applies the same tool boundary to nested subagents of a task", () => {
    process.env.AMB_BOT_ID = "flowauto";
    process.env.AMB_EXECUTION_BOT_ID = "flowauto";
    let handler: ((event: { agent: ReturnType<typeof agent>["value"] }) => void) | undefined;
    apply({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as never);
    const task = agent("task-t_123");
    const child = agent("subagent-1", "task-t_123");
    const grandchild = agent("subagent-2", "subagent-1");
    handler?.({ agent: task.value });
    handler?.({ agent: child.value });
    handler?.({ agent: grandchild.value });
    expect(child.guard?.({ name: "bash" })).toMatch(/restricted to Computer Use/);
    expect(grandchild.guard?.({ name: "web_search" })).toMatch(/restricted to Computer Use/);
  });
});
