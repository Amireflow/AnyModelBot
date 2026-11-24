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

test("remote Computer Use approvals can be reviewed and relayed to the workstation", async (t) => {
  const s=await setup();let node;t.after(async()=>{try{node?.ws.close();}catch{}await s.close();});
  node=await connectNode(s.wsUrl,"approval-node");
  await waitFor(async()=>{const d=await(await request(s.base,"/api/v1/nodes")).json();return d.nodes.length===1?d:undefined;});
  const created=await request(s.base,"/api/v1/tasks",ADMIN,{method:"POST",body:JSON.stringify({node_id:"approval-node",kind:"flowauto",title:"Approval test",instruction:"Click Generate"})});
  assert.equal(created.status,201);const taskId=(await created.json()).task.id;
  await waitFor(()=>node.messages.find(m=>m.type==="task.submit"&&m.task?.id===taskId));
  const approvalId="approval-test-1";
  node.ws.send(JSON.stringify({type:"task.approval",task_id:taskId,approval:{id:approvalId,tool:"mcp__computer-use__click",detail:"x: 200, y: 300",created_at:Date.now(),expires_at:Date.now()+60000}}));
  await waitFor(async()=>{const d=await(await request(s.base,"/api/v1/approvals?status=pending")).json();return d.approvals.find(a=>a.id===approvalId);});
  const response=await request(s.base,`/api/v1/approvals/${approvalId}/approve`,ADMIN,{method:"POST"});assert.equal(response.status,202);
  await waitFor(()=>node.messages.find(m=>m.type==="task.approval.decision"&&m.approval_id===approvalId));
  node.ws.send(JSON.stringify({type:"task.approval.resolved",task_id:taskId,approval_id:approvalId,status:"allowed",decided_by:"control-plane",decided_at:Date.now()}));
  await waitFor(async()=>{const d=await(await request(s.base,"/api/v1/approvals?status=all")).json();return d.approvals.find(a=>a.id===approvalId)?.status==="allowed";});
});

test("approval decisions queued while offline are replayed after node reconnect", async (t) => {
  const server=await setup();let first,second;
  t.after(async()=>{try{first?.ws.close();second?.ws.close();}catch{}await server.close();});
  first=await connectNode(server.wsUrl,"approval-reconnect-node");
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected?d:undefined;});
  const created=await request(server.base,"/api/v1/tasks",ADMIN,{method:"POST",body:JSON.stringify({
    node_id:"approval-reconnect-node",kind:"flowauto",title:"Reconnect approval",instruction:"Click Generate",
  })});
  assert.equal(created.status,201);const taskId=(await created.json()).task.id;
  await waitFor(()=>first.messages.find(m=>m.type==="task.submit"&&m.task?.id===taskId));
  const approvalId="approval-reconnect-1";
  first.ws.send(JSON.stringify({type:"task.approval",task_id:taskId,approval:{
    id:approvalId,tool:"mcp__computer-use__click",detail:"Generate button",created_at:Date.now(),expires_at:Date.now()+60000,
  }}));
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/approvals?status=pending")).json();return d.approvals.find(a=>a.id===approvalId);});
  first.ws.close();
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected===false?d:undefined;});
  const decision=await request(server.base,`/api/v1/approvals/${approvalId}/deny`,ADMIN,{method:"POST"});
  assert.equal(decision.status,202);
  assert.equal((await decision.json()).delivery,"queued_until_reconnect");
  second=await connectNode(server.wsUrl,"approval-reconnect-node");
  const replay=await waitFor(()=>second.messages.find(m=>m.type==="task.approval.decision"&&m.approval_id===approvalId));
  assert.equal(replay.allow,false);
});


test("expired approvals cannot be approved or replayed after reconnect", async (t) => {
  const server=await setup();let first,second;
  t.after(async()=>{try{first?.ws.close();second?.ws.close();}catch{}await server.close();});
  first=await connectNode(server.wsUrl,"approval-expiry-node");
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected?d:undefined;});
  const created=await request(server.base,"/api/v1/tasks",ADMIN,{method:"POST",body:JSON.stringify({
    node_id:"approval-expiry-node",kind:"flowauto",title:"Expiry test",instruction:"Click Generate",
  })});
  assert.equal(created.status,201);const taskId=(await created.json()).task.id;
  await waitFor(()=>first.messages.find(m=>m.type==="task.submit"&&m.task?.id===taskId));
  const approvalId="approval-expiry-1";
  first.ws.send(JSON.stringify({type:"task.approval",task_id:taskId,approval:{
    id:approvalId,tool:"mcp__computer-use__click",detail:"Generate",created_at:Date.now(),expires_at:Date.now()+500,
  }}));
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/approvals?status=pending")).json();return d.approvals.find(a=>a.id===approvalId);});
  first.ws.close();
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected===false?d:undefined;});
  await new Promise(resolve=>setTimeout(resolve,550));
  const listed=await(await request(server.base,"/api/v1/approvals?status=all")).json();
  assert.equal(listed.approvals.find(a=>a.id===approvalId)?.status,"expired");
  const decision=await request(server.base,`/api/v1/approvals/${approvalId}/approve`,ADMIN,{method:"POST"});
  assert.equal(decision.status,409);
  second=await connectNode(server.wsUrl,"approval-expiry-node");
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected?d:undefined;});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(second.messages.some(m=>m.type==="task.approval.decision"&&m.approval_id===approvalId),false);
});

test("terminal tasks cancel pending approvals and late resolutions cannot reopen them", async (t) => {
  const server=await setup();let node;
  t.after(async()=>{try{node?.ws.close();}catch{}await server.close();});
  node=await connectNode(server.wsUrl,"approval-terminal-node");
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected?d:undefined;});
  const created=await request(server.base,"/api/v1/tasks",ADMIN,{method:"POST",body:JSON.stringify({
    node_id:"approval-terminal-node",kind:"flowauto",title:"Terminal test",instruction:"Click Generate",
  })});
  assert.equal(created.status,201);const taskId=(await created.json()).task.id;
  await waitFor(()=>node.messages.find(m=>m.type==="task.submit"&&m.task?.id===taskId));
  const approvalId="approval-terminal-1";
  node.ws.send(JSON.stringify({type:"task.approval",task_id:taskId,approval:{
    id:approvalId,tool:"mcp__computer-use__click",detail:"Generate",created_at:Date.now(),expires_at:Date.now()+60000,
  }}));
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/approvals?status=pending")).json();return d.approvals.find(a=>a.id===approvalId);});
  node.ws.send(JSON.stringify({type:"task.update",task_id:taskId,status:"succeeded",summary:"Completed."}));
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/approvals?status=all")).json();return d.approvals.find(a=>a.id===approvalId)?.status==="cancelled";});
  node.ws.send(JSON.stringify({type:"task.approval.resolved",task_id:taskId,approval_id:approvalId,status:"allowed",decided_by:"late-message",decided_at:Date.now()}));
  await new Promise(resolve=>setTimeout(resolve,40));
  const listed=await(await request(server.base,"/api/v1/approvals?status=all")).json();
  assert.equal(listed.approvals.find(a=>a.id===approvalId)?.status,"cancelled");
  node.ws.send(JSON.stringify({type:"task.approval",task_id:taskId,approval:{
    id:"approval-after-terminal",tool:"mcp__computer-use__click",created_at:Date.now(),expires_at:Date.now()+60000,
  }}));
  await new Promise(resolve=>setTimeout(resolve,40));
  const final=await(await request(server.base,"/api/v1/approvals?status=all")).json();
  assert.equal(final.approvals.some(a=>a.id==="approval-after-terminal"),false);
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
