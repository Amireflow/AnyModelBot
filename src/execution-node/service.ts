import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { type RawData } from "ws";
import type { Store, Bot } from "../store/db.js";
import type { TaskService } from "../tasks/service.js";
import type { ApprovalCenter, ApprovalEvent } from "../agent/approvals.js";
import { logger, registerSecret } from "../log.js";

const log = logger("execution-node");
const NODE_ID_KEY = "execution-node.id.v1";
const NODE_STATE_KEY = "execution-node.state.v1";
const HEARTBEAT_MS = 15_000;
const MAX_FRAME_BYTES = 64 * 1024;
const TASK_BUDGET_USD = 1;

type NodeState = "active" | "paused" | "revoked";
type RemoteTaskStatus = "receiving" | "queued" | "running" | "needs_you" | "succeeded" | "failed" | "cancelled" | "rejected" | "interrupted";

export interface LocalExecutionNodeOptions {
  store: Store;
  tasks: TaskService;
  approvals?: Pick<ApprovalCenter, "listen" | "decide" | "answerText" | "sweep">;
  workspace(botId: string): string;
  env?: NodeJS.ProcessEnv;
  onNotice?(level: "info" | "warn", message: string): void;
}

interface RemoteTaskRequest {
  id: string;
  kind: "flowauto";
  title: string;
  instruction: string;
}

interface RemoteTaskRow {
  remote_task_id: string;
  local_task_id: string;
  status: RemoteTaskStatus;
  summary: string;
  created_at: number;
  updated_at: number;
}

const FLOWAUTO_POLICY = [
  "LOCAL EXECUTION POLICY — this task is limited to FlowAuto / Google Flow.",
  "Use only the already-open Chrome profile and the FlowAuto / Google Flow interface. Do not switch browser profiles or Google accounts, sign in, inspect credentials, or read browser session data. If an account chooser, login prompt, or unexpected permission dialog appears, stop and ask the local owner.",
  "Use the approved Computer Use interface for browser interaction. Every click, keystroke, or other input action requires the owner's local approval. Do not bypass this approval through scripts, shell commands, extensions APIs, or direct network calls.",
  "Never publish, share, externally upload, send, spend credits, change account settings, or delete content without first asking the owner through task_report(needs_you) and waiting for the owner's decision. Do not claim an action succeeded until the resulting UI state has been checked.",
  "Save deliverables only inside this bot's workspace. If Chrome's download flow cannot save there, stop and ask the owner rather than writing outside the workspace.",
  "Verify generated images and videos in the UI; for videos, inspect playback and the final rendered result. Report what was actually verified, any limitations, and the workspace-relative output path.",
].join("\n");

export function validateControlPlaneUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Control Plane URL must be an absolute WebSocket URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("Control Plane connections must use wss:// (ws:// is allowed only for localhost development).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Control Plane URL must not contain credentials, query parameters, or a fragment.");
  }
  return url;
}

export function localTaskId(nodeId: string, remoteTaskId: string): string {
  return `t_${crypto.createHash("sha256").update(nodeId + ":" + remoteTaskId).digest("hex").slice(0, 12)}`;
}

function clip(value: string, max: number): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function decodeFrame(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTerminal(status: RemoteTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "rejected" || status === "interrupted";
}

export function shouldEmitTaskUpdate(
  previous: { status: RemoteTaskStatus; summary: string },
  next: { status: RemoteTaskStatus; summary: string },
  force = false,
): boolean {
  return force || previous.status !== next.status || previous.summary !== next.summary;
}

/**
 * Outbound-only workstation node. Remote requests are converted into the app's existing durable TaskService;
 * this module never executes arbitrary shell commands or accepts remote filesystem paths.
 */
export class LocalExecutionNode {
  readonly id: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly controlUrl: string;
  private readonly token: string;
  private readonly botId: string;
  private readonly db: Store["db"];
  private socket: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private stopping = false;
  private inbound = Promise.resolve();
  private state: NodeState;
  private unlistenApprovals: (() => void) | undefined;

  constructor(private readonly o: LocalExecutionNodeOptions) {
    this.env = o.env ?? process.env;
    this.controlUrl = String(this.env.AMB_EXECUTION_CONTROL_URL ?? "").trim();
    this.token = String(this.env.AMB_EXECUTION_CONTROL_TOKEN ?? "").trim();
    this.botId = String(this.env.AMB_EXECUTION_BOT_ID ?? "").trim();
    const storedId = o.store.getKV(NODE_ID_KEY);
    this.id = storedId || crypto.randomUUID();
    if (!storedId) o.store.setKV(NODE_ID_KEY, this.id);
    const savedState = o.store.getKV(NODE_STATE_KEY);
    this.state = savedState === "paused" || savedState === "revoked" ? savedState : "active";
    this.db = o.store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_node_tasks (
        remote_task_id TEXT PRIMARY KEY,
        local_task_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS execution_node_tasks_status ON execution_node_tasks(status, updated_at);
    `);
    this.unlistenApprovals = o.approvals?.listen((event) => this.approvalEvent(event));
  }

  status(): {
    id: string;
    state: NodeState;
    connected: boolean;
    configured: boolean;
    botId: string;
    controlHost: string;
    pendingTasks: number;
  } {
    let controlHost = "";
    try { controlHost = this.controlUrl ? new URL(this.controlUrl).host : ""; } catch { /* invalid until start() */ }
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM execution_node_tasks WHERE status IN ('receiving','queued','running','needs_you')",
    ).get() as { count: number };
    return {
      id: this.id,
      state: this.state,
      connected: this.socket?.readyState === WebSocket.OPEN,
      configured: !!(this.controlUrl && this.token && this.botId),
      botId: this.botId,
      controlHost,
      pendingTasks: Number(row?.count ?? 0),
    };
  }

  start(agentAvailable: boolean): boolean {
    if (!this.controlUrl && !this.token && !this.botId) return false;
    if (!this.controlUrl || !this.token || !this.botId) {
      this.notice("warn", "Execution Node disabled: set AMB_EXECUTION_CONTROL_URL, AMB_EXECUTION_CONTROL_TOKEN and AMB_EXECUTION_BOT_ID together.");
      return false;
    }
    if (this.token.length < 24) {
      this.notice("warn", "Execution Node disabled: the Control Plane token must contain at least 24 characters.");
      return false;
    }
    try { validateControlPlaneUrl(this.controlUrl); }
    catch (error) {
      this.notice("warn", `Execution Node disabled: ${(error as Error).message}`);
      return false;
    }
    if (!agentAvailable) {
      this.notice("warn", "Execution Node disabled: the local DSH agent is unavailable.");
      return false;
    }
    const bot = this.o.store.getBot(this.botId);
    const policyError = this.botPolicyError(bot);
    if (policyError) {
      this.notice("warn", `Execution Node disabled: ${policyError}`);
      return false;
    }
    if (this.state === "revoked" && !this.resetRevocationForLocalPairing()) {
      this.notice("warn", "Execution Node pairing has been revoked. Set AMB_EXECUTION_NODE_RESET=1 locally and provide a newly issued Control Plane token to re-pair.");
      return false;
    }
    registerSecret(this.token);
    this.stopping = false;
    this.connect();
    return true;
  }

  /**
   * One-shot local re-pair gate. The reset flag must be set in the local process environment;
   * a remote message can never clear a revoked state.
   */
  resetRevocationForLocalPairing(): boolean {
    if (this.state !== "revoked" || this.env.AMB_EXECUTION_NODE_RESET !== "1") return false;
    delete this.env.AMB_EXECUTION_NODE_RESET;
    this.setState("active");
    this.notice("warn", "Local re-pair reset accepted. Remove AMB_EXECUTION_NODE_RESET from the launcher environment and keep the newly issued Control Plane token.");
    return true;
  }

  pause(): void {
    if (this.state === "revoked") return;
    this.setState("paused");
    this.send({ type: "node.state", node_id: this.id, state: this.state, at: Date.now() });
  }

  resume(): boolean {
    if (this.state === "revoked") return false;
    this.setState("active");
    this.send({ type: "node.state", node_id: this.id, state: this.state, at: Date.now() });
    return true;
  }

  async revoke(): Promise<void> {
    this.setState("revoked");
    this.send({ type: "node.revoked", node_id: this.id, at: Date.now() });
    const rows = this.db.prepare(
      "SELECT local_task_id FROM execution_node_tasks WHERE status IN ('receiving','queued','running','needs_you')",
    ).all() as Array<{ local_task_id: string }>;
    for (const row of rows) await this.o.tasks.stopTask(String(row.local_task_id), "execution-node-revoked").catch(() => false);
    this.clearTimers();
    this.socket?.close(1000, "node revoked");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "node.goodbye", node_id: this.id, at: Date.now() });
      this.socket.close(1000, "application shutdown");
    } else this.socket?.terminate();
    this.socket = undefined;
    this.unlistenApprovals?.();
    this.unlistenApprovals = undefined;
  }

  private reportTaskRequests(): void {
    this.o.approvals?.sweep();
    for (const row of this.o.store.listApprovals({ limit: 500 })) {
      if (!row.taskId) continue;
      const remote = this.db.prepare(
        "SELECT remote_task_id FROM execution_node_tasks WHERE local_task_id = ?",
      ).get(row.taskId) as { remote_task_id: string } | undefined;
      if (!remote) continue;
      const isComputerApproval = row.kind === "approval" && row.tool.startsWith("mcp__computer-use__");
      const isTaskQuestion = row.kind === "question" && row.tool === "task_report" && !row.blocking;
      if (!isComputerApproval && !isTaskQuestion) continue;
      if (isComputerApproval) {
        this.send({
          type: "task.approval",
          task_id: remote.remote_task_id,
          approval: {
            id: row.id, tool: row.tool, detail: clip(row.detail, 700), reason: clip(row.reason, 300),
            created_at: row.createdAt, expires_at: row.expiresAt,
          },
        });
      } else {
        this.send({
          type: "task.question",
          task_id: remote.remote_task_id,
          question: { id: row.id, tool: row.tool, detail: clip(row.detail, 700), payload: row.payload, created_at: row.createdAt },
        });
      }
      if (row.status !== "pending") {
        this.send({
          type: "task.approval.resolved", task_id: remote.remote_task_id, approval_id: row.id,
          status: row.status, decided_by: row.decidedBy, decided_at: row.decidedAt, result: row.result,
        });
      }
    }
  }

  private approvalEvent(event: ApprovalEvent): void {
    const row = event.row;
    const isComputerApproval = row.kind === "approval" && row.tool.startsWith("mcp__computer-use__");
    const isTaskQuestion = row.kind === "question" && row.tool === "task_report" && !row.blocking;
    if ((!isComputerApproval && !isTaskQuestion) || !row.taskId) return;
    const remote = this.db.prepare(
      "SELECT remote_task_id FROM execution_node_tasks WHERE local_task_id = ?",
    ).get(row.taskId) as { remote_task_id: string } | undefined;
    if (!remote) return;
    if (event.type === "created" && isComputerApproval) {
      this.send({
        type: "task.approval", task_id: remote.remote_task_id,
        approval: { id: row.id, tool: row.tool, detail: clip(row.detail, 700), reason: clip(row.reason, 300),
          created_at: row.createdAt, expires_at: row.expiresAt },
      });
    } else if (event.type === "created" && isTaskQuestion) {
      this.send({
        type: "task.question", task_id: remote.remote_task_id,
        question: { id: row.id, tool: row.tool, detail: clip(row.detail, 700), payload: row.payload, created_at: row.createdAt },
      });
    } else {
      this.send({
        type: "task.approval.resolved", task_id: remote.remote_task_id, approval_id: row.id,
        status: row.status, decided_by: row.decidedBy, decided_at: row.decidedAt, result: row.result,
      });
    }
  }

  private applyRemoteApproval(message: Record<string, unknown>): void {
    const taskId = typeof message.task_id === "string" ? message.task_id : "";
    const approvalId = typeof message.approval_id === "string" ? message.approval_id : "";
    const allow = message.allow === true;
    const remote = taskId ? this.getRemoteTask(taskId) : undefined;
    const approval = approvalId ? this.o.store.getApproval(approvalId) : undefined;
    const valid = !!remote && !!approval &&
      approval.status === "pending" &&
      approval.kind === "approval" &&
      approval.botId === this.botId &&
      approval.taskId === remote.local_task_id &&
      approval.tool.startsWith("mcp__computer-use__");
    const applied = valid && !!this.o.approvals?.decide(approvalId, allow, "control-plane");
    this.send({
      type: "task.approval.decision_ack",
      task_id: taskId,
      approval_id: approvalId,
      applied,
      reason: applied ? "" : "Approval is no longer pending or is not part of this FlowAuto task.",
    });
  }


  private applyRemoteQuestionAnswer(message: Record<string, unknown>): void {
    const taskId = typeof message.task_id === "string" ? message.task_id : "";
    const questionId = typeof message.question_id === "string" ? message.question_id : "";
    const answer = typeof message.answer === "string" ? message.answer.trim() : "";
    const remote = taskId ? this.getRemoteTask(taskId) : undefined;
    const question = questionId ? this.o.store.getApproval(questionId) : undefined;
    const valid = !!remote && !!question &&
      Buffer.byteLength(answer, "utf8") > 0 && Buffer.byteLength(answer, "utf8") <= 2_000 &&
      question.status === "pending" && question.kind === "question" && question.tool === "task_report" &&
      question.blocking === false && question.botId === this.botId && question.taskId === remote.local_task_id;
    const applied = valid && !!this.o.approvals?.answerText(questionId, answer, "control-plane");
    this.send({
      type: "task.question.answer_ack", task_id: taskId, question_id: questionId, applied,
      reason: applied ? "" : "Question is no longer pending or is not part of this FlowAuto task.",
    });
  }

  private notice(level: "info" | "warn", message: string): void {
    log[level](message);
    this.o.onNotice?.(level, message);
  }

  private setState(state: NodeState): void {
    this.state = state;
    this.o.store.setKV(NODE_STATE_KEY, state);
  }

  private botPolicyError(bot: Bot | undefined): string | undefined {
    if (!bot) return `configured execution bot "${this.botId}" was not found`;
    if (bot.origin !== "user" || bot.app) return "the execution bot must be a user-owned bot, not a catalog bot";
    if (bot.settings.permission !== "workspace") return "the execution bot must use Workspace permission (Full access is refused)";
    if (!bot.settings.computerUse.enabled || bot.settings.computerUse.approval !== "ask-input") {
      return "enable Computer Use and require approval before every input action (ask-input)";
    }
    if (bot.settings.memory.enabled) return "disable memory on the dedicated execution bot to avoid mixing private chat context into remote tasks";
    if (bot.settings.apps.mode !== "selected" || bot.settings.apps.selected.length) {
      return "set connected apps to Selected with no apps enabled on the execution bot";
    }
    if (bot.settings.paused) return "the execution bot's background tasks are paused";
    return undefined;
  }

  private connect(): void {
    if (this.stopping || this.state === "revoked" || this.socket) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.controlUrl, {
        headers: { authorization: `Bearer ${this.token}` },
        handshakeTimeout: 10_000,
        maxPayload: MAX_FRAME_BYTES,
      });
    } catch (error) {
      this.scheduleReconnect((error as Error).message);
      return;
    }
    this.socket = socket;
    socket.on("open", () => {
      if (this.socket !== socket || this.stopping) return;
      this.reconnectAttempt = 0;
      this.send({
        type: "node.hello",
        protocol: 1,
        node_id: this.id,
        label: os.hostname().slice(0, 80),
        platform: process.platform,
        arch: process.arch,
        bot_id: this.botId,
        capabilities: ["flowauto", "computer-use-approval"],
        state: this.state,
        at: Date.now(),
      });
      this.heartbeat = setInterval(() => {
        this.send({
          type: "node.heartbeat",
          node_id: this.id,
          state: this.state,
          pending_tasks: this.status().pendingTasks,
          at: Date.now(),
        });
        void this.reportTaskStates();
      }, HEARTBEAT_MS);
      this.heartbeat.unref?.();
      void this.reportTaskStates(true);
      this.reportTaskRequests();
      this.notice("info", "Execution Node connected to the Control Plane.");
    });
    socket.on("message", (data: RawData) => {
      if (this.socket !== socket || this.stopping) return;
      const raw = decodeFrame(data);
      if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) {
        this.send({ type: "node.error", code: "FRAME_TOO_LARGE" });
        return;
      }
      this.inbound = this.inbound.then(() => this.handleFrame(raw)).catch((error) => {
        log.warn("execution node message failed", { message: (error as Error).message.slice(0, 300) });
      });
    });
    socket.on("error", (error) => {
      log.warn("execution node socket error", { message: error.message.slice(0, 200) });
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.clearHeartbeat();
      if (!this.stopping && this.state !== "revoked") this.scheduleReconnect("connection closed");
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopping || this.state === "revoked" || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    log.warn("execution node reconnect scheduled", { delayMs: delay, reason: reason.slice(0, 160) });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private send(value: Record<string, unknown>): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify(value)); }
    catch (error) { log.warn("execution node send failed", { message: (error as Error).message.slice(0, 160) }); }
  }

  /** Resolve only after ws accepts the frame; task snapshots are persisted only after this succeeds. */
  private async sendReliable(value: Record<string, unknown>): Promise<boolean> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    return new Promise<boolean>((resolve) => {
      try {
        socket.send(JSON.stringify(value), (error) => {
          if (error) log.warn("execution node reliable send failed", { message: error.message.slice(0, 160) });
          resolve(!error);
        });
      } catch (error) {
        log.warn("execution node reliable send failed", { message: (error as Error).message.slice(0, 160) });
        resolve(false);
      }
    });
  }

  private async handleFrame(raw: string): Promise<void> {
    let message: unknown;
    try { message = JSON.parse(raw); }
    catch { this.send({ type: "node.error", code: "INVALID_JSON" }); return; }
    if (!isObject(message) || typeof message.type !== "string") {
      this.send({ type: "node.error", code: "INVALID_MESSAGE" });
      return;
    }
    switch (message.type) {
      case "node.ping":
        this.send({ type: "node.pong", node_id: this.id, at: Date.now() });
        return;
      case "node.pause":
        this.pause();
        return;
      case "node.resume":
        if (!this.resume()) this.send({ type: "node.error", code: "NODE_REVOKED" });
        return;
      case "node.revoke":
        await this.revoke();
        return;
      case "task.submit":
        await this.submitTask(message.task);
        return;
      case "task.cancel":
        await this.cancelTask(message.task_id);
        return;
      case "task.approval.decision":
        this.applyRemoteApproval(message);
        return;
      case "task.question.answer":
        this.applyRemoteQuestionAnswer(message);
        return;
      default:
        this.send({ type: "node.error", code: "UNKNOWN_MESSAGE" });
    }
  }

  private async submitTask(value: unknown): Promise<void> {
    if (this.state !== "active") {
      this.send({ type: "task.rejected", code: this.state === "paused" ? "NODE_PAUSED" : "NODE_REVOKED" });
      return;
    }
    if (!isObject(value)) {
      this.send({ type: "task.rejected", code: "INVALID_TASK" });
      return;
    }
    const allowed = new Set(["id", "kind", "title", "instruction"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      this.send({ type: "task.rejected", code: "UNSUPPORTED_TASK_FIELDS" });
      return;
    }
    const remoteId = typeof value.id === "string" ? value.id.trim() : "";
    const kind = value.kind;
    const title = typeof value.title === "string" ? clip(value.title, 60) : "";
    const instruction = typeof value.instruction === "string" ? value.instruction.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(remoteId) || kind !== "flowauto" || !title || !instruction || Buffer.byteLength(instruction, "utf8") > 800) {
      this.send({ type: "task.rejected", task_id: remoteId || undefined, code: "INVALID_TASK" });
      return;
    }
    const bot = this.o.store.getBot(this.botId);
    const policyError = this.botPolicyError(bot);
    if (policyError) {
      this.send({ type: "task.rejected", task_id: remoteId, code: "EXECUTION_POLICY_NOT_MET", message: policyError });
      return;
    }
    const localId = localTaskId(this.id, remoteId);
    const existing = this.db.prepare("SELECT * FROM execution_node_tasks WHERE remote_task_id = ?").get(remoteId) as RemoteTaskRow | undefined;
    if (existing && this.o.store.getTask(existing.local_task_id)) {
      this.send({ type: "task.accepted", task_id: remoteId, local_task_id: existing.local_task_id, duplicate: true });
      await this.reportOneTask(existing, true);
      return;
    }
    if (existing && isTerminal(existing.status)) {
      this.send({ type: "task.rejected", task_id: remoteId, code: existing.status.toUpperCase(), message: existing.summary });
      return;
    }
    const now = Date.now();
    this.db.prepare(
      "INSERT OR IGNORE INTO execution_node_tasks(remote_task_id,local_task_id,status,summary,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(remoteId, localId, "receiving", "", now, now);
    const workspace = path.resolve(this.o.workspace(this.botId));
    fs.mkdirSync(workspace, { recursive: true });
    const peerId = `execution-node-${crypto.createHash("sha256").update(this.id + ":" + remoteId).digest("hex").slice(0, 16)}`;
    const conversation = this.o.store.ensureConversation(this.botId, "web", peerId, `FlowAuto · ${title}`);
    const marker = `[Execution Node task ${remoteId}]`;
    const alreadyRecorded = this.o.store.listMessages(conversation.id, 10).some((item) => item.role === "user" && item.content.startsWith(marker));
    if (!alreadyRecorded) this.o.store.addMessage(conversation.id, "user", `${marker}\n${instruction}`);
    const brief = `OWNER REQUEST:\n${instruction}`;
    const created = this.o.tasks.create({
      id: localId,
      botId: this.botId,
      conversationId: conversation.id,
      title: `FlowAuto: ${title}`,
      brief,
      budgetUsd: TASK_BUDGET_USD,
      anytime: false,
      root: workspace,
    });
    if (!created.task) {
      const reason = clip(created.error || "Local task queue refused the request.", 400);
      this.updateRemoteTask(remoteId, localId, "rejected", reason);
      this.send({ type: "task.rejected", task_id: remoteId, code: "LOCAL_QUEUE_REJECTED", message: reason });
      return;
    }
    this.updateRemoteTask(remoteId, localId, "queued", "");
    this.send({ type: "task.accepted", task_id: remoteId, local_task_id: localId, duplicate: false });
    await this.reportOneTask(this.getRemoteTask(remoteId)!, true);
  }

  private async cancelTask(value: unknown): Promise<void> {
    const remoteId = typeof value === "string" ? value.trim() : "";
    if (!remoteId) {
      this.send({ type: "task.cancelled", code: "INVALID_TASK_ID" });
      return;
    }
    const row = this.getRemoteTask(remoteId);
    if (!row) {
      this.send({ type: "task.cancelled", task_id: remoteId, cancelled: false });
      return;
    }
    const stopped = await this.o.tasks.stopTask(row.local_task_id, "execution-node-control-plane").catch(() => false);
    const local = this.o.store.getTask(row.local_task_id);
    const status = stopped || local?.endReason === "stopped" ? "cancelled" : this.taskStatus(row.local_task_id);
    this.updateRemoteTask(remoteId, row.local_task_id, status, status === "cancelled" ? "Stopped by the Control Plane." : row.summary);
    this.send({ type: "task.cancelled", task_id: remoteId, local_task_id: row.local_task_id, cancelled: status === "cancelled" });
  }

  private getRemoteTask(id: string): RemoteTaskRow | undefined {
    return this.db.prepare("SELECT * FROM execution_node_tasks WHERE remote_task_id = ?").get(id) as RemoteTaskRow | undefined;
  }

  private updateRemoteTask(id: string, localId: string, status: RemoteTaskStatus, summary: string): void {
    this.db.prepare(
      "UPDATE execution_node_tasks SET local_task_id = ?, status = ?, summary = ?, updated_at = ? WHERE remote_task_id = ?",
    ).run(localId, status, clip(summary, 500), Date.now(), id);
  }

  private taskStatus(localId: string): RemoteTaskStatus {
    const task = this.o.store.getTask(localId);
    if (!task) return "receiving";
    if (task.endReason === "stopped" || task.endReason === "archived") return "cancelled";
    const run = this.o.store.latestRun(localId);
    if (!run) return "queued";
    if (run.state === "running" || run.state === "settling") return "running";
    if (run.state === "queued") return "queued";
    const outcome = String(run.outcome || "");
    if (outcome === "done") return "succeeded";
    if (outcome === "needs_you") return "needs_you";
    if (outcome === "interrupted") return "interrupted";
    if (outcome === "stopped") return "cancelled";
    if (run.state === "ended") return "failed";
    return "queued";
  }

  private async reportOneTask(row: RemoteTaskRow, force = false): Promise<void> {
    const status = this.taskStatus(row.local_task_id);
    const run = this.o.store.latestRun(row.local_task_id);
    const summary = clip(String(run?.report?.message || run?.error || row.summary || ""), 400);
    const changed = shouldEmitTaskUpdate(row, { status, summary }, force);
    if (!changed) return;
    const sent = await this.sendReliable({
      type: "task.update",
      task_id: row.remote_task_id,
      local_task_id: row.local_task_id,
      status,
      summary,
      at: Date.now(),
    });
    // Leave the old snapshot in SQLite when disconnected or when ws rejects the frame; reconnect can replay it.
    if (sent && (status !== row.status || summary !== row.summary)) {
      this.updateRemoteTask(row.remote_task_id, row.local_task_id, status, summary);
    }
  }

  private async reportTaskStates(force = false): Promise<void> {
    const rows = this.db.prepare(
      "SELECT * FROM execution_node_tasks ORDER BY updated_at DESC LIMIT 100",
    ).all() as RemoteTaskRow[];
    for (const row of rows) await this.reportOneTask(row, force);
  }
}
