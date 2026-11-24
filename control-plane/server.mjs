import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const MAX_HTTP_BODY = 64 * 1024;
const MAX_WS_FRAME = 64 * 1024;
const HEARTBEAT_STALE_MS = 45_000;
const DISPATCH_RETRY_MS = 15_000;
const TASK_STATUSES = new Set(["queued", "accepted", "running", "needs_you", "succeeded", "failed", "cancelled", "rejected", "interrupted"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "rejected", "interrupted"]);
const APPROVAL_STATUSES = new Set(["pending", "allowed", "rejected", "expired", "cancelled", "answered"]);
const NODE_STATES = new Set(["active", "paused", "revoked"]);

function clip(value, max = 500) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function equalSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function bearer(req) {
  const value = String(req.headers.authorization ?? "");
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() ?? "";
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function rejectUpgrade(socket, status, message) {
  const reason = status === 401 ? "Unauthorized" : status === 426 ? "Upgrade Required" : "Not Found";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  socket.destroy();
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_HTTP_BODY) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
    return value;
  } catch {
    throw Object.assign(new Error("Invalid JSON request body."), { status: 400 });
  }
}

function initDatabase(db) {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      arch TEXT NOT NULL DEFAULT '',
      bot_id TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      protocol INTEGER NOT NULL DEFAULT 1,
      reported_state TEXT NOT NULL DEFAULT 'active',
      desired_state TEXT NOT NULL DEFAULT 'active',
      connected INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id),
      kind TEXT NOT NULL CHECK(kind = 'flowauto'),
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      summary TEXT NOT NULL DEFAULT '',
      local_task_id TEXT NOT NULL DEFAULT '',
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      last_dispatch_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tasks_node_status ON tasks(node_id, status, created_at);
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), node_id TEXT NOT NULL REFERENCES nodes(id),
      tool TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0,
      decision TEXT NOT NULL DEFAULT '', decision_requested INTEGER NOT NULL DEFAULT 0,
      decided_at INTEGER NOT NULL DEFAULT 0, decided_by TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS approvals_task_status ON approvals(task_id,status,created_at);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
  `);
}

function nodeView(row, connected) {
  return {
    id: row.id,
    label: row.label,
    platform: row.platform,
    arch: row.arch,
    bot_id: row.bot_id,
    capabilities: JSON.parse(row.capabilities || "[]"),
    protocol: Number(row.protocol),
    state: row.reported_state,
    desired_state: row.desired_state,
    connected: !!connected,
    last_seen_at: Number(row.last_seen_at),
    stale: !connected && Date.now() - Number(row.last_seen_at) > HEARTBEAT_STALE_MS,
    created_at: Number(row.created_at),
  };
}

function approvalView(r) {
  return {id:r.id,task_id:r.task_id,node_id:r.node_id,tool:r.tool,detail:r.detail,reason:r.reason,status:r.status,
    created_at:Number(r.created_at),expires_at:Number(r.expires_at)||null,decision_requested:!!r.decision_requested,
    decided_at:Number(r.decided_at)||null,decided_by:r.decided_by||null,result:r.result||""};
}
function taskView(row) {
  return {
    id: row.id,
    node_id: row.node_id,
    kind: row.kind,
    title: row.title,
    instruction: row.instruction,
    status: row.status,
    summary: row.summary,
    local_task_id: row.local_task_id || null,
    cancel_requested: !!row.cancel_requested,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    completed_at: Number(row.completed_at) || null,
  };
}

export function createControlPlaneServer(options = {}) {
  const env = options.env ?? process.env;
  const adminToken = options.adminToken ?? env.AMB_CP_ADMIN_TOKEN ?? "";
  const nodeToken = options.nodeToken ?? env.AMB_CP_NODE_TOKEN ?? "";
  const trustProxy = options.trustProxy ?? env.AMB_CP_TRUST_PROXY === "1";
  const allowInsecureWs = options.allowInsecureWs ?? env.AMB_CP_ALLOW_INSECURE === "1";
  const host = options.host ?? env.HOST ?? "0.0.0.0";
  const port = Number(options.port ?? env.PORT ?? 8787);
  const dbPath = options.dbPath ?? env.AMB_CP_DB ?? path.join(ROOT, "data", "control-plane.sqlite");

  if (adminToken.length < 32) throw new Error("AMB_CP_ADMIN_TOKEN must contain at least 32 characters.");
  if (nodeToken.length < 24) throw new Error("AMB_CP_NODE_TOKEN must contain at least 24 characters.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535.");

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(dbPath);
  initDatabase(db);
  if (dbPath !== ":memory:") {
    try { fs.chmodSync(dbPath, 0o600); } catch { /* platform-specific */ }
  }

  const connections = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME, perMessageDeflate: false });
  let closing = false;
  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    expirePendingApprovals(now);
    for (const [nodeId, socket] of connections) {
      const row = db.prepare("SELECT last_seen_at FROM nodes WHERE id = ?").get(nodeId);
      if (!row || now - Number(row.last_seen_at) > HEARTBEAT_STALE_MS) {
        socket.terminate();
        markNodeOffline(nodeId, socket);
      } else {
        void send(socket, { type: "node.ping", node_id: nodeId, at: now });
      }
    }
  }, 15_000);
  heartbeatTimer.unref?.();

  const logEvent = (nodeId, taskId, type, payload = {}) => {
    db.prepare("INSERT INTO events(node_id, task_id, event_type, payload, created_at) VALUES(?,?,?,?,?)")
      .run(clip(nodeId, 100), clip(taskId, 100), clip(type, 80), JSON.stringify(payload).slice(0, 4000), Date.now());
  };

  const expirePendingApprovals = (at = Date.now()) => {
    const expired = db.prepare(
      "SELECT id, task_id, node_id FROM approvals WHERE status = 'pending' AND expires_at > 0 AND expires_at <= ?",
    ).all(at);
    if (!expired.length) return 0;
    const result = db.prepare(
      "UPDATE approvals SET status='expired', decision_requested=0, decided_at=?, decided_by='timeout' WHERE status='pending' AND expires_at > 0 AND expires_at <= ?",
    ).run(at, at);
    for (const approval of expired) {
      logEvent(approval.node_id, approval.task_id, "task.approval.resolved", { approval_id: approval.id, status: "expired" });
    }
    return Number(result.changes);
  };

  const cancelPendingApprovals = (taskId, nodeId, reason, at = Date.now()) => {
    const result = db.prepare(
      "UPDATE approvals SET status='cancelled', decision_requested=0, decided_at=?, decided_by=? WHERE task_id=? AND status='pending'",
    ).run(at, clip(reason, 80), taskId);
    const count = Number(result.changes);
    if (count) logEvent(nodeId, taskId, "task.approvals.cancelled", { count, reason: clip(reason, 80) });
    return count;
  };

  const send = (socket, payload) => new Promise((resolve) => {
    if (socket?.readyState !== WebSocket.OPEN) return resolve(false);
    try {
      socket.send(JSON.stringify(payload), (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });

  const dispatchPending = async (nodeId, force = false) => {
    const socket = connections.get(nodeId);
    if (socket?.readyState !== WebSocket.OPEN) return;
    const node = db.prepare("SELECT desired_state, reported_state FROM nodes WHERE id = ?").get(nodeId);
    if (!node || node.desired_state !== "active" || node.reported_state !== "active") return;
    const now = Date.now();
    const tasks = db.prepare(`
      SELECT * FROM tasks
      WHERE node_id = ? AND status = 'queued' AND cancel_requested = 0
        AND (? = 1 OR last_dispatch_at <= ?)
      ORDER BY created_at ASC LIMIT 50
    `).all(nodeId, force ? 1 : 0, now - DISPATCH_RETRY_MS);
    for (const task of tasks) {
      const sent = await send(socket, {
        type: "task.submit",
        task: { id: task.id, kind: task.kind, title: task.title, instruction: task.instruction },
      });
      if (sent) {
        db.prepare("UPDATE tasks SET last_dispatch_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
          .run(now, now, task.id);
        logEvent(nodeId, task.id, "task.dispatched");
      }
    }

    const cancels = db.prepare(
      "SELECT id FROM tasks WHERE node_id = ? AND cancel_requested = 1 AND status NOT IN ('cancelled','succeeded','failed','rejected','interrupted') LIMIT 50",
    ).all(nodeId);
    for (const task of cancels) await send(socket, { type: "task.cancel", task_id: task.id });
  };

  const markNodeOffline = (nodeId, socket) => {
    if (connections.get(nodeId) !== socket) return;
    connections.delete(nodeId);
    db.prepare("UPDATE nodes SET connected = 0, updated_at = ? WHERE id = ?").run(Date.now(), nodeId);
    logEvent(nodeId, "", "node.disconnected");
  };

  const handleNodeMessage = async (socket, message) => {
    const nodeId = socket.nodeId;
    if (!nodeId) return;
    const now = Date.now();

    switch (message.type) {
      case "node.heartbeat": {
        const state = NODE_STATES.has(message.state) ? message.state : "active";
        db.prepare("UPDATE nodes SET reported_state = ?, connected = 1, last_seen_at = ?, updated_at = ? WHERE id = ?")
          .run(state, now, now, nodeId);
        if (state === "active") await dispatchPending(nodeId);
        return;
      }
      case "node.state": {
        const state = NODE_STATES.has(message.state) ? message.state : "";
        if (!state || state === "revoked") return;
        db.prepare("UPDATE nodes SET reported_state = ?, connected = 1, last_seen_at = ?, updated_at = ? WHERE id = ?")
          .run(state, now, now, nodeId);
        logEvent(nodeId, "", "node.state", { state });
        if (state === "active") await dispatchPending(nodeId, true);
        return;
      }
      case "node.pong":
        db.prepare("UPDATE nodes SET last_seen_at = ?, connected = 1 WHERE id = ?").run(now, nodeId);
        return;
      case "node.goodbye":
        socket.close(1000, "node goodbye");
        return;
      case "node.revoked": {
        db.prepare("UPDATE nodes SET reported_state = 'revoked', desired_state = 'revoked', connected = 0, updated_at = ? WHERE id = ?")
          .run(now, nodeId);
        db.prepare(`UPDATE tasks SET status = 'cancelled', summary = 'Execution node revoked.', cancel_requested = 0, completed_at = ?, updated_at = ?
          WHERE node_id = ? AND status NOT IN ('succeeded','failed','cancelled','rejected','interrupted')`)
          .run(now, now, nodeId);
        logEvent(nodeId, "", "node.revoked");
        socket.close(1000, "node revoked");
        return;
      }
      case "node.error":
        logEvent(nodeId, "", "node.error", { code: clip(message.code, 80) });
        return;
      case "task.accepted": {
        const taskId = String(message.task_id ?? "");
        const localId = clip(message.local_task_id, 100);
        if (!taskId || !db.prepare("SELECT id FROM tasks WHERE id = ? AND node_id = ?").get(taskId, nodeId)) return;
        db.prepare("UPDATE tasks SET status = 'accepted', local_task_id = ?, summary = '', updated_at = ? WHERE id = ? AND status = 'queued'")
          .run(localId, now, taskId);
        logEvent(nodeId, taskId, "task.accepted", { local_task_id: localId });
        return;
      }
      case "task.rejected": {
        const taskId = String(message.task_id ?? "");
        if (!taskId || !db.prepare("SELECT id FROM tasks WHERE id = ? AND node_id = ?").get(taskId, nodeId)) return;
        const reason = clip(message.message || message.code || "Rejected by the local execution node.", 500);
        db.prepare("UPDATE tasks SET status = 'rejected', summary = ?, cancel_requested = 0, completed_at = ?, updated_at = ? WHERE id = ?")
          .run(reason, now, now, taskId);
        cancelPendingApprovals(taskId, nodeId, "task_rejected", now);
        logEvent(nodeId, taskId, "task.rejected", { code: clip(message.code, 80) });
        return;
      }
      case "task.update": {
        const taskId = String(message.task_id ?? "");
        const status = String(message.status ?? "");
        if (!taskId || !TASK_STATUSES.has(status) || !db.prepare("SELECT id FROM tasks WHERE id = ? AND node_id = ?").get(taskId, nodeId)) return;
        const summary = clip(message.summary, 500);
        const localId = clip(message.local_task_id, 100);
        db.prepare(`
          UPDATE tasks SET status = ?, summary = ?, local_task_id = CASE WHEN ? = '' THEN local_task_id ELSE ? END,
            completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
            cancel_requested = CASE WHEN ? = 'cancelled' THEN 0 ELSE cancel_requested END,
            updated_at = ? WHERE id = ?
        `).run(status, summary, localId, localId, TERMINAL.has(status) ? 1 : 0, now, status, now, taskId);
        if (TERMINAL.has(status)) cancelPendingApprovals(taskId, nodeId, "task_terminal", now);
        logEvent(nodeId, taskId, "task.update", { status });
        return;
      }
      case "task.approval": {
        const taskId=String(message.task_id??""), a=message.approval;
        if(!taskId||!a||typeof a!=="object"||typeof a.id!=="string"||!/^[A-Za-z0-9._:-]{1,100}$/.test(a.id)||
          typeof a.tool!=="string"||!a.tool.startsWith("mcp__computer-use__")||
          !db.prepare("SELECT id FROM tasks WHERE id=? AND node_id=? AND status IN ('queued','accepted','running','needs_you')").get(taskId,nodeId)) return;
        const createdAt=a.created_at===undefined?now:Number(a.created_at);
        const expiresAt=a.expires_at===undefined?0:Number(a.expires_at);
        if(!Number.isSafeInteger(createdAt)||createdAt<=0||!Number.isSafeInteger(expiresAt)||expiresAt<0)return;
        const inserted=db.prepare("INSERT OR IGNORE INTO approvals(id,task_id,node_id,tool,detail,reason,status,created_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)")
          .run(a.id,taskId,nodeId,clip(a.tool,180),clip(a.detail,700),clip(a.reason,300),createdAt,expiresAt);
        if(Number(inserted.changes)===0)return;
        logEvent(nodeId,taskId,"task.approval.created",{approval_id:a.id});
        expirePendingApprovals(now);
        return;
      }
      case "task.approval.resolved": {
        const taskId=String(message.task_id??""), id=String(message.approval_id??""), status=String(message.status??"");
        if(!taskId||!id||!["allowed","rejected","expired","cancelled","answered"].includes(status))return;
        expirePendingApprovals(now);
        const updated=db.prepare("UPDATE approvals SET status=?,decision_requested=0,decided_at=?,decided_by=? WHERE id=? AND task_id=? AND node_id=? AND status='pending'")
          .run(status,Number(message.decided_at)||now,clip(message.decided_by,80),id,taskId,nodeId);
        if(Number(updated.changes)>0)logEvent(nodeId,taskId,"task.approval.resolved",{approval_id:id,status});
        return;
      }
      case "task.approval.decision_ack": {
        const id=String(message.approval_id??""); if(!id)return;
        if(message.applied!==true) db.prepare("UPDATE approvals SET decision_requested=0,result=? WHERE id=? AND node_id=? AND status='pending'")
          .run(clip(message.reason||"Local workstation rejected the decision.",300),id,nodeId);
        return;
      }
      case "task.cancelled": {
        const taskId = String(message.task_id ?? "");
        if (!taskId || !db.prepare("SELECT id FROM tasks WHERE id = ? AND node_id = ?").get(taskId, nodeId)) return;
        if (message.cancelled === true) {
          db.prepare("UPDATE tasks SET status = 'cancelled', summary = 'Stopped from the Control Plane.', cancel_requested = 0, completed_at = ?, updated_at = ? WHERE id = ?")
            .run(now, now, taskId);
          cancelPendingApprovals(taskId, nodeId, "task_cancelled", now);
        } else {
          db.prepare("UPDATE tasks SET cancel_requested = 0, updated_at = ? WHERE id = ?").run(now, taskId);
        }
        logEvent(nodeId, taskId, "task.cancelled", { cancelled: message.cancelled === true });
        return;
      }
      default:
        logEvent(nodeId, "", "node.unknown_message", { type: clip(message.type, 80) });
    }
  };

  const acceptHello = async (socket, message) => {
    if (message.protocol !== 1 || typeof message.node_id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,100}$/.test(message.node_id) ||
        typeof message.bot_id !== "string" || !message.bot_id.trim() ||
        !Array.isArray(message.capabilities) ||
        !message.capabilities.includes("flowauto") ||
        !message.capabilities.includes("computer-use-approval") ||
        !["active", "paused"].includes(message.state)) {
      socket.close(4002, "invalid node hello");
      return;
    }
    const id = message.node_id;
    const now = Date.now();
    const existing = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    if (existing?.desired_state === "revoked") {
      socket.close(4003, "node revoked; local re-pair required");
      return;
    }
    if (existing && existing.bot_id !== message.bot_id) {
      socket.close(4004, "paired bot identity changed");
      return;
    }
    const reported = message.state;
    const desired = existing?.desired_state || reported;
    db.prepare(`
      INSERT INTO nodes(id,label,platform,arch,bot_id,capabilities,protocol,reported_state,desired_state,connected,last_seen_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,1,?,?,1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        label=excluded.label, platform=excluded.platform, arch=excluded.arch, capabilities=excluded.capabilities,
        protocol=excluded.protocol, reported_state=excluded.reported_state, connected=1,
        last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at
    `).run(
      id, clip(message.label, 80), clip(message.platform, 40), clip(message.arch, 40),
      clip(message.bot_id, 100), JSON.stringify(message.capabilities.slice(0, 20)),
      reported, desired, now, existing?.created_at ?? now, now,
    );

    socket.nodeId = id;
    const previous = connections.get(id);
    if (previous && previous !== socket) previous.close(4000, "replaced by a newer connection");
    connections.set(id, socket);
    logEvent(id, "", "node.connected", { platform: clip(message.platform, 40), arch: clip(message.arch, 40) });

    expirePendingApprovals(now);
    if (desired === "paused" && reported !== "paused") {
      await send(socket, { type: "node.pause" });
    } else if (desired === "active" && reported === "paused") {
      await send(socket, { type: "node.resume" });
    } else if (desired === "active") {
      await dispatchPending(id, true);
    }

    const queued = db.prepare("SELECT id FROM tasks WHERE node_id = ? AND cancel_requested = 1 AND status NOT IN ('cancelled','succeeded','failed','rejected','interrupted')").all(id);
    for (const task of queued) await send(socket, { type: "task.cancel", task_id: task.id });
    const pending=db.prepare("SELECT id,task_id,decision FROM approvals WHERE node_id=? AND status='pending' AND decision_requested=1").all(id);
    for(const a of pending) await send(socket,{type:"task.approval.decision",task_id:a.task_id,approval_id:a.id,allow:a.decision==="allow"});
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") return json(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) {
      if (!equalSecret(bearer(req), adminToken)) return json(res, 401, { error: "Unauthorized" });
      try {
        if (url.pathname === "/api/v1/nodes" && req.method === "GET") {
          const rows = db.prepare("SELECT * FROM nodes ORDER BY created_at DESC").all();
          return json(res, 200, { nodes: rows.map((row) => nodeView(row, connections.has(row.id))) });
        }
        if (url.pathname === "/api/v1/tasks" && req.method === "GET") {
          const nodeId = url.searchParams.get("node_id");
          const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
          const rows = nodeId
            ? db.prepare("SELECT * FROM tasks WHERE node_id = ? ORDER BY created_at DESC LIMIT ?").all(nodeId, limit)
            : db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit);
          return json(res, 200, { tasks: rows.map(taskView) });
        }
        if (url.pathname === "/api/v1/tasks" && req.method === "POST") {
          const body = await readJson(req);
          const allowed = new Set(["node_id", "kind", "title", "instruction"]);
          if (Object.keys(body).some((key) => !allowed.has(key))) return json(res, 400, { error: "Unsupported task fields." });
          const nodeId = typeof body.node_id === "string" ? body.node_id.trim() : "";
          const kind = body.kind ?? "flowauto";
          const title = clip(body.title, 60);
          const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
          const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId);
          if (!node) return json(res, 404, { error: "Execution node not found. Connect the workstation first." });
          if (node.desired_state === "revoked") return json(res, 409, { error: "This node is revoked and must be paired locally again." });
          if (kind !== "flowauto" || !title || !instruction || Buffer.byteLength(instruction, "utf8") > 500) {
            return json(res, 400, { error: "A FlowAuto task requires a title and an instruction of at most 500 UTF-8 bytes." });
          }
          const id = crypto.randomUUID();
          const now = Date.now();
          db.prepare("INSERT INTO tasks(id,node_id,kind,title,instruction,status,created_at,updated_at) VALUES(?,?, 'flowauto', ?, ?, 'queued', ?, ?)")
            .run(id, nodeId, title, instruction, now, now);
          logEvent(nodeId, id, "task.created");
          void dispatchPending(nodeId, true);
          const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
          return json(res, 201, { task: taskView(row) });
        }
        if(url.pathname==="/api/v1/approvals"&&req.method==="GET"){
          expirePendingApprovals();
          const status=url.searchParams.get("status")||"pending";
          if(status!=="all"&&!APPROVAL_STATUSES.has(status))return json(res,400,{error:"Invalid approval status."});
          const rows=status==="all"?db.prepare("SELECT a.*,t.title FROM approvals a JOIN tasks t ON t.id=a.task_id ORDER BY a.created_at DESC LIMIT 100").all():
            db.prepare("SELECT a.*,t.title FROM approvals a JOIN tasks t ON t.id=a.task_id WHERE a.status=? ORDER BY a.created_at DESC LIMIT 100").all(status);
          return json(res,200,{approvals:rows.map(r=>({...approvalView(r),task_title:r.title}))});
        }
        const dm=/^\/api\/v1\/approvals\/([A-Za-z0-9._:-]+)\/(approve|deny)$/.exec(url.pathname);
        if(dm&&req.method==="POST"){
          expirePendingApprovals();
          const [,id,action]=dm,a=db.prepare("SELECT * FROM approvals WHERE id=?").get(id);
          if(!a)return json(res,404,{error:"Approval not found."});
          const now=Date.now();
          const decision=action==="approve"?"allow":"deny";
          const claimed=db.prepare("UPDATE approvals SET decision=?,decision_requested=1,decided_by='control-plane' WHERE id=? AND status='pending' AND decision_requested=0 AND (expires_at=0 OR expires_at>?)")
            .run(decision,id,now);
          if(Number(claimed.changes)===0)return json(res,409,{error:"Approval is no longer actionable."});
          const delivered=await send(connections.get(a.node_id),{type:"task.approval.decision",task_id:a.task_id,approval_id:id,allow:decision==="allow"});
          logEvent(a.node_id,a.task_id,"task.approval.decision_requested",{approval_id:id,decision,delivered});
          return json(res,202,{approval:approvalView(db.prepare("SELECT * FROM approvals WHERE id=?").get(id)),delivery:delivered?"sent":"queued_until_reconnect"});
        }
        const cancelMatch = /^\/api\/v1\/tasks\/([A-Za-z0-9._:-]+)\/cancel$/.exec(url.pathname);
        if (cancelMatch && req.method === "POST") {
          const id = cancelMatch[1];
          const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
          if (!task) return json(res, 404, { error: "Task not found." });
          if (TERMINAL.has(task.status)) return json(res, 200, { task: taskView(task), already_terminal: true });
          const now = Date.now();
          db.prepare("UPDATE approvals SET status='cancelled',decision_requested=0,decided_at=?,decided_by='task_cancelled' WHERE task_id=? AND status='pending'").run(now,id);
          if (task.status === "queued" && !task.local_task_id) {
            db.prepare("UPDATE tasks SET status='cancelled', summary='Cancelled before dispatch.', cancel_requested=0, completed_at=?, updated_at=? WHERE id=?")
              .run(now, now, id);
          } else {
            db.prepare("UPDATE tasks SET cancel_requested=1, updated_at=? WHERE id=?").run(now, id);
            const socket = connections.get(task.node_id);
            if (socket) await send(socket, { type: "task.cancel", task_id: id });
          }
          logEvent(task.node_id, id, "task.cancel_requested");
          return json(res, 200, { task: taskView(db.prepare("SELECT * FROM tasks WHERE id=?").get(id)) });
        }
        const nodeAction = /^\/api\/v1\/nodes\/([A-Za-z0-9._:-]+)\/(pause|resume|revoke)$/.exec(url.pathname);
        if (nodeAction && req.method === "POST") {
          const [, id, action] = nodeAction;
          const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
          if (!node) return json(res, 404, { error: "Execution node not found." });
          if (action === "resume" && node.desired_state === "revoked") return json(res, 409, { error: "Revoked nodes cannot be resumed remotely. Re-pair on the workstation." });
          const desired = action === "revoke" ? "revoked" : action === "pause" ? "paused" : "active";
          db.prepare("UPDATE nodes SET desired_state=?, updated_at=? WHERE id=?").run(desired, Date.now(), id);
          const socket = connections.get(id);
          if (socket) {
            await send(socket, { type: action === "pause" ? "node.pause" : action === "resume" ? "node.resume" : "node.revoke" });
          }
          if (action === "revoke") {
            const now = Date.now();
            db.prepare("UPDATE approvals SET status='cancelled',decision_requested=0,decided_at=?,decided_by='node_revoked' WHERE node_id=? AND status='pending'").run(now,id);
            db.prepare(`UPDATE tasks SET status='cancelled', summary='Execution node revoked.', cancel_requested=0, completed_at=?, updated_at=?
              WHERE node_id=? AND status NOT IN ('succeeded','failed','cancelled','rejected','interrupted')`).run(now, now, id);
          }
          logEvent(id, "", `node.${action}_requested`);
          return json(res, 200, { node: nodeView(db.prepare("SELECT * FROM nodes WHERE id = ?").get(id), connections.has(id)) });
        }
        return json(res, 404, { error: "Not found." });
      } catch (error) {
        return json(res, Number(error?.status) || 500, { error: Number(error?.status) ? error.message : "Internal server error." });
      }
    }

    const assets = {
      "/": ["index.html", "text/html; charset=utf-8"],
      "/app.js": ["app.js", "text/javascript; charset=utf-8"],
      "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    };
    const asset = assets[url.pathname];
    if (req.method === "GET" && asset) {
      try {
        const body = fs.readFileSync(path.join(PUBLIC, asset[0]));
        res.writeHead(200, {
          "content-type": asset[1],
          "content-length": body.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "permissions-policy": "camera=(), microphone=(), geolocation=()",
        });
        return res.end(body);
      } catch {
        return json(res, 500, { error: "Dashboard asset unavailable." });
      }
    }
    return json(res, 404, { error: "Not found." });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/node") return rejectUpgrade(socket, 404, "Not found.");
    const secure = !!req.socket.encrypted || (trustProxy && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https");
    if (!secure && !allowInsecureWs) return rejectUpgrade(socket, 426, "Use wss:// for workstation connections.");
    if (!equalSecret(bearer(req), nodeToken)) return rejectUpgrade(socket, 401, "Unauthorized.");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket) => {
    let helloTimer = setTimeout(() => socket.close(4001, "node hello timeout"), 10_000);
    helloTimer.unref?.();
    socket.on("message", (data) => {
      if (data.length > MAX_WS_FRAME) return socket.close(1009, "frame too large");
      let message;
      try { message = JSON.parse(Buffer.from(data).toString("utf8")); }
      catch { return socket.close(4002, "invalid JSON"); }
      if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
        return socket.close(4002, "invalid frame");
      }
      if (!socket.nodeId) {
        if (message.type !== "node.hello") return socket.close(4002, "node.hello required first");
        clearTimeout(helloTimer);
        void acceptHello(socket, message);
        return;
      }
      void handleNodeMessage(socket, message).catch(() => socket.close(1011, "node message failed"));
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (socket.nodeId) markNodeOffline(socket.nodeId, socket);
    });
    socket.on("error", () => {
      if (socket.nodeId) markNodeOffline(socket.nodeId, socket);
    });
  });

  return {
    server,
    db,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      closing = true;
      clearInterval(heartbeatTimer);
      for (const socket of wss.clients) socket.terminate();
      connections.clear();
      await new Promise((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => wss.close(resolve));
      db.prepare("UPDATE nodes SET connected = 0, updated_at = ?").run(Date.now());
      db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = createControlPlaneServer();
  const address = await app.listen();
  console.log(`Control Plane listening on ${typeof address === "object" ? address.address : "?"}:${typeof address === "object" ? address.port : "?"}`);
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
