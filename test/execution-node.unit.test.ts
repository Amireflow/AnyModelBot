import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store/db.js";
import { LocalExecutionNode, localTaskId, shouldEmitTaskUpdate, validateControlPlaneUrl } from "../src/execution-node/service.js";

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
