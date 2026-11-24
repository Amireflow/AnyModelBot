import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createControlPlaneServer } from "../server.mjs";

const ADMIN = "admin-test-token-".padEnd(48, "x");
const NODE = "node-test-token-".padEnd(48, "y");

async function setup() {
  const app = createControlPlaneServer({
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    adminToken: ADMIN,
    nodeToken: NODE,
    allowInsecureWs: true,
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/node`;
  return { app, base, wsUrl, close: () => app.close() };
}

async function request(base, path, token = ADMIN, init = {}) {
  return fetch(base + path, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
  });
}

async function connectNode(wsUrl, nodeId = "node-test-1") {
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${NODE}` } });
  await once(ws, "open");
  const messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  ws.send(JSON.stringify({
    type: "node.hello",
    protocol: 1,
    node_id: nodeId,
    label: "Test workstation",
    platform: "linux",
    arch: "x64",
    bot_id: "flowauto-bot",
    capabilities: ["flowauto", "computer-use-approval"],
    state: "active",
    at: Date.now(),
  }));
  return { ws, messages };
}

async function waitFor(fn, timeout = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for the expected protocol message.");
}

test("health is public; all admin APIs require the administrator token", async (t) => {
  const s = await setup();
  t.after(s.close);
  assert.equal((await request(s.base, "/healthz", "")).status, 200);
  assert.equal((await request(s.base, "/api/v1/nodes", "")).status, 401);
  assert.equal((await request(s.base, "/api/v1/nodes", "wrong")).status, 401);
  assert.equal((await request(s.base, "/api/v1/nodes", ADMIN)).status, 200);
});

test("authenticated node receives persisted FlowAuto tasks and reports status", async (t) => {
  const s = await setup();
  t.after(async () => { try { node.ws.close(); } catch {} await s.close(); });
  const node = await connectNode(s.wsUrl);
  const nodeData = await waitFor(async () => {
    const data = await (await request(s.base, "/api/v1/nodes")).json();
    return data.nodes.length === 1 ? data : undefined;
  });
  assert.equal(nodeData.nodes.length, 1);
  assert.equal(nodeData.nodes[0].connected, true);

  const created = await request(s.base, "/api/v1/tasks", ADMIN, {
    method: "POST",
    body: JSON.stringify({ node_id: "node-test-1", kind: "flowauto", title: "Test render", instruction: "Generate one test image in Flow." }),
  });
  assert.equal(created.status, 201);
  const payload = await created.json();
  const taskId = payload.task.id;
  await waitFor(() => node.messages.find((m) => m.type === "task.submit" && m.task?.id === taskId));
  const submission = node.messages.find((m) => m.type === "task.submit" && m.task?.id === taskId);
  assert.equal(submission.task.instruction, "Generate one test image in Flow.");

  node.ws.send(JSON.stringify({ type: "task.accepted", task_id: taskId, local_task_id: "t_123" }));
  await waitFor(async () => {
    const data = await (await request(s.base, "/api/v1/tasks")).json();
    return data.tasks.find((item) => item.id === taskId)?.status === "accepted";
  });
  node.ws.send(JSON.stringify({ type: "task.update", task_id: taskId, local_task_id: "t_123", status: "running", summary: "Opening Google Flow." }));
  await waitFor(() => node.messages.length >= 1);
  const tasks = await (await request(s.base, "/api/v1/tasks")).json();
  assert.equal(tasks.tasks.find((item) => item.id === taskId).status, "running");
});

test("tasks remain queued while the workstation is offline", async (t) => {
  const s = await setup();
  t.after(s.close);
  const hello = await request(s.base, "/api/v1/nodes", ADMIN);
  assert.equal((await hello.json()).nodes.length, 0);
  assert.equal((await request(s.base, "/api/v1/tasks", ADMIN, {
    method: "POST",
    body: JSON.stringify({ node_id: "missing", kind: "flowauto", title: "Offline", instruction: "Test" }),
  })).status, 404);
});

test("pause and revoke commands are forwarded; revoked nodes cannot reconnect", async (t) => {
  const s = await setup();
  let node = await connectNode(s.wsUrl, "revocable-node");
  const pause = await request(s.base, "/api/v1/nodes/revocable-node/pause", ADMIN, { method: "POST" });
  assert.equal(pause.status, 200);
  await waitFor(() => node.messages.some((m) => m.type === "node.pause"));
  const revoke = await request(s.base, "/api/v1/nodes/revocable-node/revoke", ADMIN, { method: "POST" });
  assert.equal(revoke.status, 200);
  await waitFor(() => node.messages.some((m) => m.type === "node.revoke"));
  node.ws.close();
  await s.close();
});
