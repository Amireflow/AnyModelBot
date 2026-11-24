import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store/db.js";
import { LocalExecutionNode, buildFlowAutoBrief, collectRemoteArtifacts, localTaskId, shouldEmitTaskUpdate, validateControlPlaneUrl } from "../src/execution-node/service.js";

describe("LocalExecutionNode", () => {
  let store: Store | undefined;
  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it("persists one stable workstation identity in the local database", () => {
    store = new Store(":memory:");
    const options = {
      store,
      tasks: {} as never,
      workspace: (botId: string) => `/tmp/workspaces/${botId}`,
      env: {},
    };
    const first = new LocalExecutionNode(options);
    const second = new LocalExecutionNode(options);
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("persists pause and makes revocation irreversible through the remote protocol", async () => {
    store = new Store(":memory:");
    const node = new LocalExecutionNode({ store, tasks: {} as never, workspace: () => "/tmp/workspace", env: {} });
    node.pause();
    expect(node.status().state).toBe("paused");
    expect(node.resume()).toBe(true);
    expect(node.status().state).toBe("active");
    await node.revoke();
    expect(node.status().state).toBe("revoked");
    expect(node.resume()).toBe(false);
  });

  it("requires a local one-shot environment flag to clear a revoked pairing", async () => {
    store = new Store(":memory:");
    const env: NodeJS.ProcessEnv = { AMB_EXECUTION_NODE_RESET: "1" };
    const node = new LocalExecutionNode({ store, tasks: {} as never, workspace: () => "/tmp/workspace", env });
    await node.revoke();
    expect(node.status().state).toBe("revoked");
    expect(node.resetRevocationForLocalPairing()).toBe(true);
    expect(node.status().state).toBe("active");
    expect(env.AMB_EXECUTION_NODE_RESET).toBeUndefined();
    expect(node.resetRevocationForLocalPairing()).toBe(false);
  });


  it("includes the FlowAuto safety policy without truncating a maximum-size request", () => {
    const instruction = "x".repeat(500);
    const brief = buildFlowAutoBrief(instruction);
    expect(brief).toContain(`OWNER REQUEST:\n${instruction}`);
    expect(brief).toContain("approved Computer Use");
    expect(brief).toContain("task_report(needs_you)");
    expect(brief).toContain("save only in this bot's workspace");
    expect(brief.length).toBeLessThanOrEqual(1_500);
    expect(() => buildFlowAutoBrief("x".repeat(501))).toThrow(/500 UTF-8 bytes/);
  });



  it("rejects invalid FlowAuto input with an explicit remote task rejection", async () => {
    store = new Store(":memory:");
    const node = new LocalExecutionNode({
      store, tasks: { create: vi.fn() } as never,
      workspace: () => "/tmp/workspace", env: {},
    });
    const internal = node as unknown as {
      submitTask(value: unknown): Promise<void>;
      send(value: Record<string, unknown>): void;
    };
    const sent: Record<string, unknown>[] = [];
    internal.send = (message) => sent.push(message);
    await internal.submitTask({
      id: "remote-flow-task-too-long",
      kind: "flowauto",
      title: "Oversized request",
      instruction: "x".repeat(501),
    });
    expect(sent.at(-1)).toMatchObject({
      type: "task.rejected",
      task_id: "remote-flow-task-too-long",
      code: "INVALID_TASK",
    });
    expect(store.listTasks({ limit: 10 })).toHaveLength(0);
  });

  it.each([
    { state: "paused" as const, code: "NODE_PAUSED" },
    { state: "revoked" as const, code: "NODE_REVOKED" },
  ])("includes the remote task id when rejecting a task on a $state node", async ({ state, code }) => {
    store = new Store(":memory:");
    const create = vi.fn();
    const node = new LocalExecutionNode({
      store,
      tasks: { create } as never,
      workspace: () => "/tmp/workspace",
      env: {},
    });
    if (state === "paused") node.pause();
    else await node.revoke();

    const internal = node as unknown as {
      submitTask(value: unknown): Promise<void>;
      send(value: Record<string, unknown>): void;
    };
    const sent: Record<string, unknown>[] = [];
    internal.send = (message) => sent.push(message);

    await internal.submitTask({
      id: "remote-paused-task-1",
      kind: "flowauto",
      title: "Paused task",
      instruction: "Generate one test image.",
    });

    expect(sent.at(-1)).toMatchObject({
      type: "task.rejected",
      task_id: "remote-paused-task-1",
      code,
    });
    expect(create).not.toHaveBeenCalled();
    expect(store.listTasks({ limit: 10 })).toHaveLength(0);
  });

  it("includes the remote task id when rejecting unsupported task fields", async () => {
    store = new Store(":memory:");
    const node = new LocalExecutionNode({
      store,
      tasks: { create: vi.fn() } as never,
      workspace: () => "/tmp/workspace",
      env: {},
    });
    const internal = node as unknown as {
      submitTask(value: unknown): Promise<void>;
      send(value: Record<string, unknown>): void;
    };
    const sent: Record<string, unknown>[] = [];
    internal.send = (message) => sent.push(message);

    await internal.submitTask({
      id: "remote-unsupported-task-1",
      kind: "flowauto",
      title: "Unsupported field",
      instruction: "Generate one test image.",
      unexpected: true,
    });

    expect(sent.at(-1)).toMatchObject({
      type: "task.rejected",
      task_id: "remote-unsupported-task-1",
      code: "UNSUPPORTED_TASK_FIELDS",
    });
  });

  it("passes the FlowAuto safety policy into the durable local task", async () => {
    store = new Store(":memory:");
    const bot = {
      origin: "user",
      app: null,
      settings: {
        permission: "workspace",
        computerUse: { enabled: true, approval: "ask-input" },
        memory: { enabled: false },
        apps: { mode: "selected", selected: [] },
        paused: false,
      },
    };
    vi.spyOn(store, "getBot").mockReturnValue(bot as never);
    vi.spyOn(store, "ensureConversation").mockReturnValue({ id: "flow-conversation" } as never);
    vi.spyOn(store, "listMessages").mockReturnValue([] as never);
    vi.spyOn(store, "addMessage").mockReturnValue(undefined as never);
    const create = vi.fn((input: { brief: string }) => ({ task: {} as never }));
    const node = new LocalExecutionNode({
      store,
      tasks: { create } as never,
      workspace: () => "/tmp/anymodelbot-flowauto-test",
      env: { AMB_EXECUTION_BOT_ID: "flow-bot" },
    });
    const internal = node as unknown as {
      submitTask(value: unknown): Promise<void>;
      send(value: Record<string, unknown>): void;
      reportOneTask(row: unknown, force?: boolean): Promise<void>;
    };
    internal.send = vi.fn();
    internal.reportOneTask = vi.fn(async () => {});

    await internal.submitTask({
      id: "remote-flow-task-1",
      kind: "flowauto",
      title: "Generate video",
      instruction: "Generate a product video in Google Flow.",
    });

    expect(create).toHaveBeenCalledOnce();
    const brief = create.mock.calls[0]?.[0]?.brief ?? "";
    expect(brief).toContain("Generate a product video in Google Flow.");
    expect(brief).toContain("approved Computer Use");
    expect(brief).toContain("task_report(needs_you)");
    expect(brief).toContain("save only in this bot's workspace");
    expect(brief.length).toBeLessThanOrEqual(1_500);
  });

  it("exports only real workspace files with relative paths and bounded metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "amb-remote-artifacts-"));
    const taskFolder = path.join(root, "tasks", "render");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "amb-outside-"));
    try {
      fs.mkdirSync(taskFolder, { recursive: true });
      fs.writeFileSync(path.join(taskFolder, "final.mp4"), Buffer.alloc(1_024));
      fs.writeFileSync(path.join(root, "preview.png"), Buffer.from("png"));
      fs.writeFileSync(path.join(outside, "private.txt"), "must not leave workspace");
      fs.writeFileSync(path.join(outside, "leak.mp4"), Buffer.alloc(256));
      fs.symlinkSync(path.join(outside, "private.txt"), path.join(taskFolder, "private.txt"));

      const artifacts = collectRemoteArtifacts(root, taskFolder, [
        "final.mp4", path.join(root, "preview.png"), path.join(outside, "private.txt"),
        "missing.mp4", "private.txt",
      ]);

      expect(artifacts).toEqual([
        { path: "tasks/render/final.mp4", size: 1_024, kind: "video" },
        { path: "preview.png", size: 3, kind: "image" },
      ]);
      expect(artifacts.every((item) => !path.isAbsolute(item.path))).toBe(true);

      const linkedFolder = path.join(root, "tasks", "linked");
      fs.symlinkSync(outside, linkedFolder, "dir");
      expect(collectRemoteArtifacts(root, linkedFolder, ["leak.mp4"])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("replays task updates when only the verified artifact manifest changes", () => {
    const before = { status: "running" as const, summary: "Rendering", artifacts: "[]" };
    const after = { status: "running" as const, summary: "Rendering", artifacts: '[{"path":"tasks/render/final.mp4"}]' };
    expect(shouldEmitTaskUpdate(before, after)).toBe(true);
    expect(shouldEmitTaskUpdate(before, before)).toBe(false);
  });

  it("allows only TLS Control Plane URLs except loopback development", () => {
    expect(validateControlPlaneUrl("wss://control.example.test/node").protocol).toBe("wss:");
    expect(validateControlPlaneUrl("ws://127.0.0.1:8787/node").hostname).toBe("127.0.0.1");
    expect(() => validateControlPlaneUrl("ws://control.example.test/node")).toThrow(/wss/);
    expect(() => validateControlPlaneUrl("https://control.example.test/node")).toThrow(/WebSocket/);
    expect(() => validateControlPlaneUrl("wss://user:pass@control.example.test/node")).toThrow(/credentials/);
  });

  it("reports task states only when changed, unless a reconnect forces a snapshot", () => {
    const current = { status: "running" as const, summary: "Generating a video" };
    expect(shouldEmitTaskUpdate(current, current)).toBe(false);
    expect(shouldEmitTaskUpdate(current, { status: "succeeded", summary: "Video verified" })).toBe(true);
    expect(shouldEmitTaskUpdate(current, current, true)).toBe(true);
  });

  it("derives deterministic local task ids without trusting remote ids as paths", () => {
    expect(localTaskId("node-1", "job-123")).toBe(localTaskId("node-1", "job-123"));
    expect(localTaskId("node-1", "job-123")).not.toBe(localTaskId("node-2", "job-123"));
    expect(localTaskId("node-1", "../Downloads")).toMatch(/^t_[a-f0-9]{12}$/);
  });

  it("accepts a remote answer only for the matching pending FlowAuto question", () => {
    store = new Store(":memory:");
    const answerText = vi.fn(() => true);
    const approvals = { listen: () => () => {}, decide: () => true, answerText, sweep: () => {} };
    const node = new LocalExecutionNode({
      store, tasks: {} as never, approvals: approvals as never,
      workspace: () => "/tmp/workspace", env: { AMB_EXECUTION_BOT_ID: "flow-bot" },
    });
    const internal = node as unknown as {
      db: Store["db"];
      send(value: Record<string, unknown>): void;
      applyRemoteQuestionAnswer(value: Record<string, unknown>): void;
    };
    internal.db.prepare(
      "INSERT INTO execution_node_tasks(remote_task_id,local_task_id,status,created_at,updated_at) VALUES(?,?,?,?,?)",
    ).run("remote-task-1", "local-task-1", "needs_you", Date.now(), Date.now());
    const question = {
      id: "question-1", kind: "question", status: "pending", tool: "task_report",
      blocking: false, botId: "flow-bot", taskId: "local-task-1",
    };
    vi.spyOn(store, "getApproval").mockReturnValue(question as never);
    const sent: Record<string, unknown>[] = [];
    internal.send = (message) => sent.push(message);

    internal.applyRemoteQuestionAnswer({
      task_id: "remote-task-1", question_id: "question-1", answer: "Keep the video local",
    });

    expect(answerText).toHaveBeenCalledWith("question-1", "Keep the video local", "control-plane");
    expect(sent.at(-1)).toMatchObject({
      type: "task.question.answer_ack", task_id: "remote-task-1", question_id: "question-1", applied: true,
    });
  });

  it("rejects remote answers for stale, foreign or mismatched questions", () => {
    store = new Store(":memory:");
    const answerText = vi.fn(() => true);
    const approvals = { listen: () => () => {}, decide: () => true, answerText, sweep: () => {} };
    const node = new LocalExecutionNode({
      store, tasks: {} as never, approvals: approvals as never,
      workspace: () => "/tmp/workspace", env: { AMB_EXECUTION_BOT_ID: "flow-bot" },
    });
    const internal = node as unknown as {
      db: Store["db"];
      send(value: Record<string, unknown>): void;
      applyRemoteQuestionAnswer(value: Record<string, unknown>): void;
    };
    internal.db.prepare(
      "INSERT INTO execution_node_tasks(remote_task_id,local_task_id,status,created_at,updated_at) VALUES(?,?,?,?,?)",
    ).run("remote-task-1", "local-task-1", "needs_you", Date.now(), Date.now());
    const base = {
      id: "question-1", kind: "question", status: "pending", tool: "task_report",
      blocking: false, botId: "flow-bot", taskId: "local-task-1",
    };
    const getApproval = vi.spyOn(store, "getApproval");
    const sent: Record<string, unknown>[] = [];
    internal.send = (message) => sent.push(message);
    const frame = { task_id: "remote-task-1", question_id: "question-1", answer: "Publish" };

    getApproval.mockReturnValue({ ...base, botId: "another-bot" } as never);
    internal.applyRemoteQuestionAnswer(frame);
    expect(answerText).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: "task.question.answer_ack", applied: false });

    getApproval.mockReturnValue({ ...base, status: "answered" } as never);
    internal.applyRemoteQuestionAnswer(frame);
    expect(answerText).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: "task.question.answer_ack", applied: false });

    getApproval.mockReturnValue(base as never);
    internal.applyRemoteQuestionAnswer({ ...frame, task_id: "unknown-remote-task" });
    expect(answerText).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: "task.question.answer_ack", applied: false });
  });

});
