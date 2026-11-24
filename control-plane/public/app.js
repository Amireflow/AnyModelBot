(() => {
  "use strict";
  let token = "";
  let poll = 0;
  const $ = (id) => document.getElementById(id);
  const terminal = new Set(["succeeded", "failed", "cancelled", "rejected", "interrupted"]);
  const label = (status) => ({
    queued: "En attente",
    accepted: "Acceptée",
    running: "En cours",
    needs_you: "Validation requise",
    succeeded: "Terminée",
    failed: "Échec",
    cancelled: "Annulée",
    rejected: "Refusée",
    interrupted: "Interrompue",
    active: "Actif",
    paused: "En pause",
    revoked: "Révoqué",
  }[status] || status);
  const date = (value) => value ? new Date(value).toLocaleString("fr-FR") : "—";
  const setConnection = (connected, text) => {
    $("connection-dot").className = connected ? "dot online" : "dot";
    $("connection-label").textContent = text;
  };
  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
      cache: "no-store",
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    return payload;
  }
  function button(text, action, className = "secondary small") {
    const el = document.createElement("button");
    el.type = "button";
    el.className = className;
    el.textContent = text;
    el.addEventListener("click", action);
    return el;
  }
  function renderNodes(nodes) {
    const root = $("nodes");
    root.replaceChildren();
    const select = $("node-id");
    const previous = select.value;
    select.replaceChildren();
    if (!nodes.length) {
      root.className = "stack empty";
      root.textContent = "Aucun poste apparié. Le nœud local doit être connecté.";
      select.add(new Option("Aucun poste connecté", ""));
      return;
    }
    root.className = "stack";
    for (const node of nodes) {
      const card = document.createElement("article");
      card.className = "node-card";
      const top = document.createElement("div");
      top.className = "card-top";
      const name = document.createElement("strong");
      name.textContent = node.label || node.id;
      const state = document.createElement("span");
      state.className = `status ${node.desired_state === "revoked" ? "bad" : node.connected && node.state === "active" ? "good" : "warn"}`;
      state.textContent = node.desired_state === "revoked" ? "Révoqué" : node.connected ? label(node.state) : "Hors ligne";
      top.append(name, state);
      const meta = document.createElement("p");
      meta.className = "muted";
      meta.textContent = `${node.platform} / ${node.arch} · Bot ${node.bot_id}`;
      const id = document.createElement("code");
      id.textContent = node.id;
      const controls = document.createElement("div");
      controls.className = "actions";
      if (node.desired_state !== "revoked") {
        controls.append(button(node.desired_state === "paused" ? "Reprendre" : "Pause", async () => {
          try {
            await api(`/api/v1/nodes/${encodeURIComponent(node.id)}/${node.desired_state === "paused" ? "resume" : "pause"}`, { method: "POST" });
            await refresh();
          } catch (e) { setMessage("auth-message", e.message, true); }
        }));
        controls.append(button("Révoquer", async () => {
          if (!confirm("Révoquer ce poste et arrêter ses tâches actives ? Cette action nécessite un nouvel appariement local.")) return;
          try {
            await api(`/api/v1/nodes/${encodeURIComponent(node.id)}/revoke`, { method: "POST" });
            await refresh();
          } catch (e) { setMessage("auth-message", e.message, true); }
        }, "danger small"));
      }
      card.append(top, meta, id, controls);
      root.append(card);
      const option = new Option(`${node.label || node.id} · ${node.connected ? label(node.state) : "Hors ligne"}`, node.id);
      select.add(option);
    }
    if (nodes.some((n) => n.id === previous)) select.value = previous;
    else {
      const active = nodes.find((n) => n.connected && n.state === "active");
      if (active) select.value = active.id;
    }
  }
  function renderApprovals(items) {
    const root=$("approvals");root.replaceChildren();$("approval-count").textContent=`${items.length} demande(s)`;
    if(!items.length){root.className="task-list empty";root.textContent="Aucune action en attente d'approbation.";return;}
    root.className="task-list";
    for(const a of items){
      const card=document.createElement("article");card.className="task-card approval-card";
      const top=document.createElement("div");top.className="card-top";
      const title=document.createElement("strong");title.textContent=a.task_title||"Tâche FlowAuto";
      const status=document.createElement("span");status.className="status warn";status.textContent=a.decision_requested?"Décision transmise":"En attente";top.append(title,status);
      const tool=document.createElement("p");tool.className="approval-tool";tool.textContent=a.tool;
      const detail=document.createElement("p");detail.className="muted";detail.textContent=a.detail||a.reason||"Action Computer Use";
      const actions=document.createElement("div");actions.className="actions";
      if(!a.decision_requested)for(const [label,verb,style] of [["Approuver","approve","primary small"],["Refuser","deny","danger small"]])
        actions.append(button(label,async()=>{try{await api(`/api/v1/approvals/${encodeURIComponent(a.id)}/${verb}`,{method:"POST"});await refresh();}catch(e){setMessage("auth-message",e.message,true);}},style));
      card.append(top,tool,detail,actions);root.append(card);
    }
  }
  function renderTasks(tasks) {
    const root = $("tasks");
    root.replaceChildren();
    $("task-count").textContent = `${tasks.length} tâche${tasks.length > 1 ? "s" : ""}`;
    if (!tasks.length) {
      root.className = "task-list empty";
      root.textContent = "Aucune tâche pour le moment.";
      return;
    }
    root.className = "task-list";
    for (const task of tasks) {
      const card = document.createElement("article");
      card.className = "task-card";
      const head = document.createElement("div");
      head.className = "card-top";
      const title = document.createElement("strong");
      title.textContent = task.title;
      const status = document.createElement("span");
      status.className = `status ${task.status === "succeeded" ? "good" : terminal.has(task.status) ? "bad" : task.status === "needs_you" ? "warn" : "neutral"}`;
      status.textContent = label(task.status);
      head.append(title, status);
      const details = document.createElement("p");
      details.className = "muted";
      details.textContent = `${date(task.created_at)} · ${task.node_id}`;
      const summary = document.createElement("p");
      summary.textContent = task.summary || (task.cancel_requested ? "Annulation demandée…" : "En attente de mise à jour du poste.");
      const controls = document.createElement("div");
      controls.className = "actions";
      if (!terminal.has(task.status)) controls.append(button("Annuler", async () => {
        try { await api(`/api/v1/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST" }); await refresh(); }
        catch (e) { setMessage("task-message", e.message, true); }
      }, "danger small"));
      const id = document.createElement("code");
      id.textContent = task.id;
      card.append(head, details, summary, id, controls);
      root.append(card);
    }
  }
  function setMessage(id, message, error = false) {
    const el = $(id);
    el.textContent = message;
    el.className = error ? "hint error" : "hint";
  }
  async function refresh() {
    if (!token) return;
    try {
      const [nodeData,taskData,approvalData]=await Promise.all([api("/api/v1/nodes"),api("/api/v1/tasks?limit=50"),api("/api/v1/approvals?status=pending")]);
      renderNodes(nodeData.nodes||[]);renderTasks(taskData.tasks||[]);renderApprovals(approvalData.approvals||[]);
      setConnection(true, "Connecté");
      setMessage("auth-message", "Session administrateur active. Le token reste uniquement en mémoire.");
    } catch (e) {
      setConnection(false, "Erreur d'accès");
      setMessage("auth-message", e.message, true);
      if (/401|Unauthorized/i.test(e.message)) disconnect();
    }
  }
  function disconnect() {
    token = "";
    if (poll) clearInterval(poll);
    poll = 0;
    $("admin-token").value = "";
    setConnection(false, "Non authentifié");
    renderNodes([]);
    renderTasks([]);
    renderApprovals([]);
    setMessage("auth-message", "Déconnecté.");
  }
  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    token = $("admin-token").value.trim();
    await refresh();
    if (token && !poll) poll = setInterval(refresh, 5000);
  });
  $("logout").addEventListener("click", disconnect);
  $("refresh").addEventListener("click", refresh);
  $("task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!token) return setMessage("task-message", "Connecte-toi d'abord.", true);
    const body = {
      node_id: $("node-id").value,
      kind: "flowauto",
      title: $("task-title").value.trim(),
      instruction: $("task-instruction").value.trim(),
    };
    try {
      const result = await api("/api/v1/tasks", { method: "POST", body: JSON.stringify(body) });
      $("task-title").value = "";
      $("task-instruction").value = "";
      setMessage("task-message", `Tâche créée : ${result.task.id}`);
      await refresh();
    } catch (e) {
      setMessage("task-message", e.message, true);
    }
  });
  setConnection(false, "Non authentifié");
})();
