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


test("task instruction limit counts UTF-8 bytes rather than characters", async (t) => {
  const server=await setup();let node;
  t.after(async()=>{try{node?.ws.close();}catch{}await server.close();});
  node=await connectNode(server.wsUrl,"utf8-limit-node");
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/nodes")).json();return d.nodes.length===1?d:undefined;});
  const exact=await request(server.base,"/api/v1/tasks",ADMIN,{method:"POST",body:JSON.stringify({
    node_id:"utf8-limit-node",kind:"flowauto",title:"UTF-8 boundary",instruction:"é".repeat(250),
  })});
  assert.equal(exact.status,201);
  const tooLong=await request(server.base,"/api/v1/tasks",ADMIN,{method:"POST",body:JSON.stringify({
    node_id:"utf8-limit-node",kind:"flowauto",title:"UTF-8 overflow",instruction:"é".repeat(251),
  })});
  assert.equal(tooLong.status,400);
});

test("authenticated node receives tasks and task API exposes workstation connectivity", async (t) => {
  const s = await setup();
  let node;
  let reconnected;
  t.after(async () => { try { node?.ws.close(); reconnected?.ws.close(); } catch {} await s.close(); });
  node = await connectNode(s.wsUrl);
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
  let tasks = await (await request(s.base, "/api/v1/tasks")).json();
  let task = tasks.tasks.find((item) => item.id === taskId);
  assert.equal(task.status, "running");
  assert.equal(task.node_connected, true);
  assert.equal(task.node_state, "active");
  assert.ok(task.node_last_seen_at > 0);

  node.ws.close();
  tasks = await waitFor(async () => {
    const data = await (await request(s.base, "/api/v1/tasks")).json();
    const row = data.tasks.find((item) => item.id === taskId);
    return row && !row.node_connected ? data : undefined;
  });
  task = tasks.tasks.find((item) => item.id === taskId);
  assert.equal(task.status, "running");
  assert.equal(task.node_connected, false);
  assert.ok(task.node_last_seen_at > 0);

  reconnected = await connectNode(s.wsUrl);
  tasks = await waitFor(async () => {
    const data = await (await request(s.base, "/api/v1/tasks")).json();
    const row = data.tasks.find((item) => item.id === taskId);
    return row?.node_connected ? data : undefined;
  });
  task = tasks.tasks.find((item) => item.id === taskId);
  assert.equal(task.status, "running");
  assert.equal(task.node_connected, true);
});

test("task updates persist only safe relative artifact metadata", async (t) => {
  const s = await setup();
  let node;
  t.after(async () => { try { node?.ws.close(); } catch {} await s.close(); });
  node = await connectNode(s.wsUrl, "artifact-node");
  await waitFor(async () => {
    const data = await (await request(s.base, "/api/v1/nodes")).json();
    return data.nodes.length === 1 ? data : undefined;
  });
  const created = await request(s.base, "/api/v1/tasks", ADMIN, {
    method: "POST",
    body: JSON.stringify({ node_id: "artifact-node", kind: "flowauto", title: "Artifact test", instruction: "Create one video." }),
  });
  assert.equal(created.status, 201);
  const taskId = (await created.json()).task.id;
  await waitFor(() => node.messages.find((m) => m.type === "task.submit" && m.task?.id === taskId));
  node.ws.send(JSON.stringify({ type: "task.accepted", task_id: taskId, local_task_id: "t_artifact" }));
  await waitFor(async () => {
    const data = await (await request(s.base, "/api/v1/tasks")).json();
    return data.tasks.find((item) => item.id === taskId)?.status === "accepted";
  });

  node.ws.send(JSON.stringify({
    type: "task.update",
    task_id: taskId,
    local_task_id: "t_artifact",
    status: "running",
    summary: "Video vérifiée.",
    artifacts: [
      { path: "tasks/render/final.mp4", size: 2048, kind: "video" },
      { path: "../private.txt", size: 20, kind: "document" },
      { path: "/Users/example/.ssh/id_ed25519", size: 500, kind: "file" },
      { path: "tasks/render/invalid.mp4", size: "2048", kind: "video" },
      { path: "tasks/render/duplicate.mp4", size: 100, kind: "video" },
      { path: "tasks/render/duplicate.mp4", size: 100, kind: "video" },
    ],
  }));
  const task = await waitFor(async () => {
    const data = await (await request(s.base, "/api/v1/tasks")).json();
    const row = data.tasks.find((item) => item.id === taskId);
    return row?.artifacts?.length ? row : undefined;
  });
  assert.deepEqual(task.artifacts, [
    { path: "tasks/render/final.mp4", size: 2048, kind: "video" },
    { path: "tasks/render/duplicate.mp4", size: 100, kind: "video" },
  ]);
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

  node.ws.send(JSON.stringify({type:"task.update",task_id:taskId,status:"running",summary:"Stale running snapshot"}));
  node.ws.send(JSON.stringify({type:"task.rejected",task_id:taskId,code:"LATE_REJECTION",message:"Late rejection"}));
  await new Promise(resolve=>setTimeout(resolve,40));
  const tasks=await(await request(server.base,"/api/v1/tasks")).json();
  const finalTask=tasks.tasks.find(task=>task.id===taskId);
  assert.equal(finalTask.status,"succeeded");
  assert.equal(finalTask.summary,"Completed.");
});




test("cancelling a remote task cancels pending approvals and ignores late decisions", async (t) => {
  const server=await setup();let node;
  t.after(async()=>{try{node?.ws.close();}catch{}await server.close();});
  node=await connectNode(server.wsUrl,"task-cancel-approval-node");
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected?d:undefined;});
  const created=await request(server.base,"/api/v1/tasks",ADMIN,{method:"POST",body:JSON.stringify({
    node_id:"task-cancel-approval-node",kind:"flowauto",title:"Cancel approval test",instruction:"Generate and verify the video.",
  })});
  assert.equal(created.status,201);const taskId=(await created.json()).task.id;
  await waitFor(()=>node.messages.find(m=>m.type==="task.submit"&&m.task?.id===taskId));
  node.ws.send(JSON.stringify({type:"task.accepted",task_id:taskId,local_task_id:"local-cancel-task-1"}));
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/tasks")).json();return d.tasks.find(task=>task.id===taskId)?.status==="accepted";});
  const approvalId="task-cancel-approval-1";
  node.ws.send(JSON.stringify({type:"task.approval",task_id:taskId,approval:{
    id:approvalId,tool:"mcp__computer-use__click",detail:"Confirm Generate",created_at:Date.now(),expires_at:Date.now()+60000,
  }}));
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/approvals?status=pending")).json();return d.approvals.find(a=>a.id===approvalId);});
  const cancelled=await request(server.base,"/api/v1/tasks/"+taskId+"/cancel",ADMIN,{method:"POST"});
  assert.equal(cancelled.status,200);
  const cancelFrame=await waitFor(()=>node.messages.find(m=>m.type==="task.cancel"&&m.task_id===taskId));
  assert.equal(cancelFrame.task_id,taskId);
  const approvals=await(await request(server.base,"/api/v1/approvals?status=all")).json();
  assert.equal(approvals.approvals.find(a=>a.id===approvalId)?.status,"cancelled");
  node.ws.send(JSON.stringify({type:"task.cancelled",task_id:taskId,cancelled:true}));
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/tasks")).json();return d.tasks.find(task=>task.id===taskId)?.status==="cancelled";});
  node.ws.send(JSON.stringify({type:"task.approval.resolved",task_id:taskId,approval_id:approvalId,status:"allowed",decided_by:"late-message",decided_at:Date.now() }));
  await new Promise(resolve=>setTimeout(resolve,40));
  const after=await(await request(server.base,"/api/v1/approvals?status=all")).json();
  assert.equal(after.approvals.find(a=>a.id===approvalId)?.status,"cancelled");
});

test("local workstation revocation cancels every pending remote approval", async (t) => {
  const server=await setup();let node;
  t.after(async()=>{try{node?.ws.close();}catch{}await server.close();});
  node=await connectNode(server.wsUrl,"local-revocation-node");
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected?d:undefined;});
  const created=await request(server.base,"/api/v1/tasks",ADMIN,{method:"POST",body:JSON.stringify({
    node_id:"local-revocation-node",kind:"flowauto",title:"Revoke test",instruction:"Generate and verify the video.",
  })});
  assert.equal(created.status,201);const taskId=(await created.json()).task.id;
  await waitFor(()=>node.messages.find(m=>m.type==="task.submit"&&m.task?.id===taskId));
  for (const id of ["local-revocation-approval-1","local-revocation-approval-2"]) {
    node.ws.send(JSON.stringify({type:"task.approval",task_id:taskId,approval:{
      id,tool:"mcp__computer-use__click",detail:"Confirm browser action",created_at:Date.now(),expires_at:Date.now()+60000,
    }}));
  }
  await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/approvals?status=pending")).json();return d.approvals.length===2?d:undefined;});
  node.ws.send(JSON.stringify({type:"node.revoked",node_id:"local-revocation-node"}));
  const resolved=await waitFor(async()=>{const d=await(await request(server.base,"/api/v1/approvals?status=all")).json();return d.approvals.length===2&&d.approvals.every(a=>a.status==="cancelled")?d:undefined;});
  assert.equal(resolved.approvals.length,2);
  const tasks=await(await request(server.base,"/api/v1/tasks")).json();
  assert.equal(tasks.tasks.find(task=>task.id===taskId).status,"cancelled");
});
test("FlowAuto task questions can be answered remotely and resolved locally", async (t) => {
  const s=await setup();let node;
  t.after(async()=>{try{node?.ws.close();}catch{}await s.close();});
  node=await connectNode(s.wsUrl,"question-node");
  await waitFor(async()=>{const d=await(await request(s.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected?d:undefined;});
  const created=await request(s.base,"/api/v1/tasks",ADMIN,{method:"POST",body:JSON.stringify({
    node_id:"question-node",kind:"flowauto",title:"Publish decision",instruction:"Prepare and verify the video.",
  })});
  assert.equal(created.status,201);const taskId=(await created.json()).task.id;
  await waitFor(()=>node.messages.find(m=>m.type==="task.submit"&&m.task?.id===taskId));
  const questionId="flowauto-question-1";
  const payload=JSON.stringify([{id:"answer",question:"May I publish the verified video?",options:[{label:"Publish"},{label:"Keep local"}]}]);
  node.ws.send(JSON.stringify({type:"task.question",task_id:taskId,question:{
    id:questionId,tool:"task_report",detail:"May I publish the verified video?",payload,created_at:Date.now(),
  }}));
  const pending=await waitFor(async()=>{const d=await(await request(s.base,"/api/v1/approvals?status=pending")).json();return d.approvals.find(a=>a.id===questionId);});
  assert.equal(pending.kind,"question");assert.equal(pending.payload,payload);
  const all=await(await request(s.base,"/api/v1/approvals?status=all")).json();
  assert.deepEqual(all.approvals.map((a)=>a.id),[questionId]);
  const wrongAction=await request(s.base,`/api/v1/approvals/${questionId}/approve`,ADMIN,{method:"POST"});
  assert.equal(wrongAction.status,409);
  const firstAnswer=await request(s.base,`/api/v1/approvals/${questionId}/answer`,ADMIN,{method:"POST",body:JSON.stringify({answer:"Publish"})});
  assert.equal(firstAnswer.status,202);
  await waitFor(()=>node.messages.find(m=>m.type==="task.question.answer"&&m.question_id===questionId&&m.answer==="Publish"));
  const duplicate=await request(s.base,`/api/v1/approvals/${questionId}/answer`,ADMIN,{method:"POST",body:JSON.stringify({answer:"Second answer"})});
  assert.equal(duplicate.status,409);
  node.ws.send(JSON.stringify({type:"task.question.answer_ack",task_id:taskId,question_id:questionId,applied:false,reason:"The local question was already closed."}));
  await waitFor(async()=>{const d=await(await request(s.base,"/api/v1/approvals?status=pending")).json();const q=d.approvals.find(a=>a.id===questionId);return q&&!q.decision_requested&&q.result;});
  const retry=await request(s.base,`/api/v1/approvals/${questionId}/answer`,ADMIN,{method:"POST",body:JSON.stringify({answer:"Keep local"})});
  assert.equal(retry.status,202);
  await waitFor(()=>node.messages.find(m=>m.type==="task.question.answer"&&m.question_id===questionId&&m.answer==="Keep local"));
  const result=JSON.stringify({answers:[{id:"answer",selected:["Keep local"]}]});
  node.ws.send(JSON.stringify({type:"task.approval.resolved",task_id:taskId,approval_id:questionId,status:"answered",decided_by:"control-plane",decided_at:Date.now(),result}));
  const resolved=await waitFor(async()=>{const d=await(await request(s.base,"/api/v1/approvals?status=all")).json();return d.approvals.find(a=>a.id===questionId&&a.status==="answered");});
  assert.equal(resolved.result,result);assert.equal(resolved.decision_requested,false);
});

test("answers to FlowAuto questions are replayed after the workstation reconnects", async (t) => {
  const s=await setup();let first,second;
  t.after(async()=>{try{first?.ws.close();second?.ws.close();}catch{}await s.close();});
  first=await connectNode(s.wsUrl,"question-reconnect-node");
  await waitFor(async()=>{const d=await(await request(s.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected?d:undefined;});
  const created=await request(s.base,"/api/v1/tasks",ADMIN,{method:"POST",body:JSON.stringify({
    node_id:"question-reconnect-node",kind:"flowauto",title:"Reconnect question",instruction:"Prepare a publishable video.",
  })});
  assert.equal(created.status,201);const taskId=(await created.json()).task.id;
  await waitFor(()=>first.messages.find(m=>m.type==="task.submit"&&m.task?.id===taskId));
  const questionId="flowauto-question-reconnect-1";
  first.ws.send(JSON.stringify({type:"task.question",task_id:taskId,question:{
    id:questionId,tool:"task_report",detail:"Publish now?",payload:JSON.stringify([{id:"answer",question:"Publish now?",options:[]}]),created_at:Date.now(),
  }}));
  await waitFor(async()=>{const d=await(await request(s.base,"/api/v1/approvals?status=pending")).json();return d.approvals.find(a=>a.id===questionId);});
  first.ws.close();
  await waitFor(async()=>{const d=await(await request(s.base,"/api/v1/nodes")).json();return d.nodes[0]?.connected===false?d:undefined;});
  const answer=await request(s.base,`/api/v1/approvals/${questionId}/answer`,ADMIN,{method:"POST",body:JSON.stringify({answer:"No, keep the file local."})});
  assert.equal(answer.status,202);assert.equal((await answer.json()).delivery,"queued_until_reconnect");
  second=await connectNode(s.wsUrl,"question-reconnect-node");
  const replay=await waitFor(()=>second.messages.find(m=>m.type==="task.question.answer"&&m.question_id===questionId));
  assert.equal(replay.answer,"No, keep the file local.");
  assert.equal(second.messages.some(m=>m.type==="task.approval.decision"&&m.approval_id===questionId),false);
});


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


test("a task rejection from the workstation closes the matching queued task", async (t) => {
  const server = await setup();
  let node;
  t.after(async () => { try { node?.ws.close(); } catch {} await server.close(); });

  node = await connectNode(server.wsUrl, "rejection-node");
  await waitFor(async () => {
    const data = await (await request(server.base, "/api/v1/nodes")).json();
    return data.nodes.find((item) => item.id === "rejection-node")?.connected ? data : undefined;
  });

  const created = await request(server.base, "/api/v1/tasks", ADMIN, {
    method: "POST",
    body: JSON.stringify({
      node_id: "rejection-node",
      kind: "flowauto",
      title: "Paused workstation task",
      instruction: "Generate one test image.",
    }),
  });
  assert.equal(created.status, 201);
  const taskId = (await created.json()).task.id;
  await waitFor(() => node.messages.find((message) => message.type === "task.submit" && message.task?.id === taskId));

  node.ws.send(JSON.stringify({
    type: "task.rejected",
    task_id: taskId,
    code: "NODE_PAUSED",
    message: "The workstation is paused.",
  }));

  const data = await waitFor(async () => {
    const response = await (await request(server.base, "/api/v1/tasks")).json();
    const task = response.tasks.find((item) => item.id === taskId);
    return task?.status === "rejected" ? response : undefined;
  });
  const task = data.tasks.find((item) => item.id === taskId);
  assert.equal(task.status, "rejected");
  assert.equal(task.summary, "The workstation is paused.");
});


test("late cancellation acknowledgements cannot overwrite a terminal task", async (t) => {
  const server = await setup();
  let node;
  t.after(async () => { try { node?.ws.close(); } catch {} await server.close(); });

  node = await connectNode(server.wsUrl, "late-cancel-node");
  await waitFor(async () => {
    const data = await (await request(server.base, "/api/v1/nodes")).json();
    return data.nodes.find((item) => item.id === "late-cancel-node")?.connected ? data : undefined;
  });

  const created = await request(server.base, "/api/v1/tasks", ADMIN, {
    method: "POST",
    body: JSON.stringify({
      node_id: "late-cancel-node",
      kind: "flowauto",
      title: "Task completed during cancellation",
      instruction: "Generate and verify one image.",
    }),
  });
  assert.equal(created.status, 201);
  const taskId = (await created.json()).task.id;
  await waitFor(() => node.messages.find((message) => message.type === "task.submit" && message.task?.id === taskId));

  node.ws.send(JSON.stringify({
    type: "task.update",
    task_id: taskId,
    status: "succeeded",
    summary: "The image was generated and verified.",
  }));
  await waitFor(async () => {
    const data = await (await request(server.base, "/api/v1/tasks")).json();
    return data.tasks.find((item) => item.id === taskId)?.status === "succeeded" ? data : undefined;
  });

  node.ws.send(JSON.stringify({ type: "task.cancelled", task_id: taskId, cancelled: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const data = await (await request(server.base, "/api/v1/tasks")).json();
  const task = data.tasks.find((item) => item.id === taskId);
  assert.equal(task.status, "succeeded");
  assert.equal(task.summary, "The image was generated and verified.");
});
