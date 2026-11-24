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
  const formatBytes = (value) => {
    const size = Number(value) || 0;
    if (size < 1024) return size + " o";
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " Ko";
    return (size / (1024 * 1024)).toFixed(1) + " Mo";
  };
  const artifactKind = (kind) => ({ image: "Image", video: "Vidéo", audio: "Audio", document: "Document", file: "Fichier" }[kind] || "Fichier");
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
    if(!items.length){root.className="task-list empty";root.textContent="Aucune action en attente.";return;}
    root.className="task-list";
    for(const a of items){
      const isQuestion=a.kind==="question"||a.tool==="task_report";
      const card=document.createElement("article");card.className="task-card approval-card";
      const top=document.createElement("div");top.className="card-top";
      const title=document.createElement("strong");title.textContent=a.task_title||"Tâche FlowAuto";
      const status=document.createElement("span");status.className="status warn";status.textContent=a.decision_requested?(isQuestion?"Réponse transmise":"Décision transmise"):"En attente";top.append(title,status);
      const detail=document.createElement("p");detail.className=isQuestion?"question-detail":"approval-tool";detail.textContent=a.detail||(isQuestion?"Question de la tâche":"Action Computer Use");
      card.append(top,detail);
      const actions=document.createElement("div");actions.className="actions";
      if(isQuestion){
        let questionItems=[];
        try{const parsed=JSON.parse(a.payload||"[]");if(Array.isArray(parsed))questionItems=parsed;}catch{}
        const schema=questionItems[0]&&typeof questionItems[0]==="object"?questionItems[0]:{};
        const answer=document.createElement("textarea");answer.className="approval-answer";answer.rows=3;answer.maxLength=2000;answer.placeholder="Saisis ta réponse ou sélectionne un choix…";
        if(Array.isArray(schema.options)&&schema.options.length){
          const choices=document.createElement("div");choices.className="actions";
          for(const option of schema.options){
            if(typeof option?.label!=="string"||!option.label.trim())continue;
            choices.append(button(option.label,()=>{answer.value=schema.multiSelect?[answer.value.trim(),option.label].filter(Boolean).join(", "):option.label;},"secondary small"));
          }
          card.append(choices);
        }
        if(schema.default){
          const fallback=document.createElement("p");fallback.className="muted";fallback.textContent=`Sans réponse, la tâche continuera avec le choix par défaut : ${schema.default}`;card.append(fallback);
        }
        if(!a.decision_requested){
          const send=button("Envoyer la réponse",async()=>{
            const value=answer.value.trim();if(!value)return setMessage("auth-message","Saisis une réponse avant de l’envoyer.",true);
            send.disabled=true;
            try{await api(`/api/v1/approvals/${encodeURIComponent(a.id)}/answer`,{method:"POST",body:JSON.stringify({answer:value})});await refresh();}
            catch(e){send.disabled=false;setMessage("auth-message",e.message,true);}
          },"primary small");
          card.append(answer);actions.append(send);
        }else{
          const waiting=document.createElement("p");waiting.className="muted";waiting.textContent="Réponse en attente de confirmation du poste local.";card.append(waiting);
        }
        if(a.result){const result=document.createElement("p");result.className="hint error";result.textContent=a.result;card.append(result);}
      }else{
        const tool=document.createElement("p");tool.className="approval-tool";tool.textContent=a.tool;
        const reason=document.createElement("p");reason.className="muted";reason.textContent=a.reason||"Action Computer Use";
        card.append(tool,reason);
        if(!a.decision_requested)for(const [label,verb,style] of [["Approuver","approve","primary small"],["Refuser","deny","danger small"]])
          actions.append(button(label,async()=>{try{await api(`/api/v1/approvals/${encodeURIComponent(a.id)}/${verb}`,{method:"POST"});await refresh();}catch(e){setMessage("auth-message",e.message,true);}},style));
      }
      card.append(actions);root.append(card);
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
      const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
      let artifactSection = null;
      if (artifacts.length) {
        artifactSection = document.createElement("div");
        artifactSection.className = "artifact-list";
        const heading = document.createElement("p");
        heading.className = "muted";
        heading.textContent = "Fichiers vérifiés sur le poste";
        artifactSection.append(heading);
        for (const artifact of artifacts) {
          const item = document.createElement("div");
          item.className = "artifact-item";
          const file = document.createElement("code");
          file.textContent = artifact.path || "Fichier";
          const meta = document.createElement("span");
          meta.textContent = artifactKind(artifact.kind) + " · " + formatBytes(artifact.size);
          item.append(file, meta);
          artifactSection.append(item);
        }
      }
      card.append(head, details, summary);
      if (artifactSection) card.append(artifactSection);
      card.append(id, controls);
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
  const instructionInput = $("task-instruction");
  const instructionCount = $("task-instruction-count");
  const updateInstructionCount = () => {
    const bytes = new TextEncoder().encode(instructionInput.value.trim()).length;
    instructionCount.textContent = `${bytes} / 500 octets UTF-8`;
  };
  instructionInput.addEventListener("input", updateInstructionCount);
  updateInstructionCount();

  $("task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!token) return setMessage("task-message", "Connecte-toi d'abord.", true);
    const body = {
      node_id: $("node-id").value,
      kind: "flowauto",
      title: $("task-title").value.trim(),
      instruction: $("task-instruction").value.trim(),
    };
    if (new TextEncoder().encode(body.instruction).length > 500) {
      return setMessage("task-message", "L'instruction dépasse la limite de 500 octets UTF-8.", true);
    }
    try {
      const result = await api("/api/v1/tasks", { method: "POST", body: JSON.stringify(body) });
      $("task-title").value = "";
      $("task-instruction").value = "";
      updateInstructionCount();
      setMessage("task-message", `Tâche créée : ${result.task.id}`);
      await refresh();
    } catch (e) {
      setMessage("task-message", e.message, true);
    }
  });
  setConnection(false, "Non authentifié");
})();
