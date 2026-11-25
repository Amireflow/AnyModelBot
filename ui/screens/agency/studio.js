import { useEffect, useRef, useState } from "preact/hooks";
import { BotAvatar } from "../../components/avatar.js";
import { Markdown } from "../../components/markdown.js";
import { CopyButton, html, Icon, Spinner } from "../../components/ui.js";
import { api, sseParser } from "../../lib/api.js";
import { getLang, t } from "../../lib/i18n.js";
import { agentAvatarOf } from "./agent-avatars.js";
import { readFilePayload } from "./copilot.js";

const enc = encodeURIComponent;
const COMMANDS = [
  ["npm_test", "npm test"],
  ["npm_typecheck", "typecheck"],
  ["npm_build", "build"],
  ["git_status", "git status"],
  ["npm_install", "npm install"],
];

const SUBAGENT_DEFAULT_ROLES = {
  architect: "architect",
  ui_ux: "ui_ux",
  frontend: "developer",
  backend: "developer",
  qa: "qa_technical",
};

const MAX_ATTACH = 8;

export function ProjectStudio({ orgId, project, onChanged }) {
  const [files, setFiles] = useState([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [command, setCommand] = useState("npm_test");
  const [terminalOut, setTerminalOut] = useState("");
  const [snapshots, setSnapshots] = useState([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState("");

  // Conversational Lovable/Bolt workbench state
  const [mode, setMode] = useState("plan");
  const [targetSubagent, setTargetSubagent] = useState("");
  const [messages, setMessages] = useState([]);
  const [plan, setPlan] = useState(null);
  const [subagents, setSubagents] = useState([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [dragging, setDragging] = useState(false);

  // Live SSE streaming feedback
  const [activeSubagent, setActiveSubagent] = useState(null);
  const [liveSteps, setLiveSteps] = useState([]);

  // Right pane tabs & preview viewport
  const [workspaceTab, setWorkspaceTab] = useState("preview");
  const [viewport, setViewport] = useState("desktop"); // desktop | tablet | mobile
  const [previewNonce, setPreviewNonce] = useState(1);

  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const threadRef = useRef(null);
  const chatUploadRef = useRef(null);
  const treeUploadRef = useRef(null);

  const openFile = async (relPath) => {
    if (!relPath) return;
    setSelectedPath(relPath);
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/file?path=${enc(relPath)}`);
      setContent(res.content || "");
    } catch (err) {
      setError(err.message);
    }
  };

  const loadSnapshots = async () => {
    if (!orgId || !project?.id) return;
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/snapshots`);
      const items = res.items || [];
      setSnapshots(items);
      if (items.length && !items.some((s) => s.commitHash === selectedSnapshot)) {
        setSelectedSnapshot(items[0].commitHash);
      }
    } catch {
      setSnapshots([]);
    }
  };

  const loadFiles = async (preferPath = "") => {
    if (!orgId || !project?.id) return;
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/files`);
      const list = res.items || [];
      setFiles(list);
      const next = preferPath || (list.some((f) => f.path === selectedPath) ? selectedPath : (list[0]?.path || ""));
      if (next) await openFile(next);
      else { setSelectedPath(""); setContent(""); }
      void loadSnapshots();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadStudioState = async () => {
    if (!orgId || !project?.id) return;
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/state`);
      setMessages(Array.isArray(res.messages) ? res.messages : []);
      setPlan(res.plan || null);
      setSubagents(Array.isArray(res.subagents) ? res.subagents : []);
    } catch {
      setMessages([]);
      setPlan(null);
    }
  };

  useEffect(() => {
    setNotice("");
    setError("");
    setLiveSteps([]);
    setActiveSubagent(null);
    setTerminalOut("");
    void loadFiles();
    void loadStudioState();
  }, [orgId, project?.id]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, liveSteps.length, busy]);

  const handleChatFiles = async (fileList) => {
    if (!fileList?.length) return;
    setError("");
    const incoming = Array.from(fileList).slice(0, Math.max(0, MAX_ATTACH - attachments.length));
    try {
      const parsed = await Promise.all(incoming.map(readFilePayload));
      setAttachments((prev) => [...prev, ...parsed].slice(0, MAX_ATTACH));
    } catch (err) {
      setError(err.message);
    }
  };

  const sendStudioTurn = async (opts = {}) => {
    if (!orgId || !project?.id || busy) return;
    const text = (opts.message ?? input).trim();
    const runMode = opts.mode ?? mode;
    const executePlan = opts.executePlan === true;
    const focusSubagent = opts.targetSubagent ?? (targetSubagent || undefined);
    const attached = opts.skipAttachments ? [] : [...attachments];

    if (!text && !executePlan && attached.length === 0) return;

    setBusy("chat");
    setError("");
    setNotice("");
    setLiveSteps([]);
    setActiveSubagent(null);

    const optimisticText = text || (executePlan ? t("agency.studioApprovePlanBtn") : attached.map((f) => f.name).join(", "));
    const optimisticId = `opt-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        role: "user",
        mode: runMode,
        text: optimisticText,
        at: new Date().toISOString(),
        files: attached.map((f) => f.name),
      },
    ]);
    if (opts.message == null) setInput("");
    if (!opts.skipAttachments) setAttachments([]);

    try {
      const response = await fetch(`/amb/api/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/chat-stream`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-amb-lang": getLang() },
        body: JSON.stringify({
          message: text,
          mode: runMode,
          executePlan,
          targetSubagent: focusSubagent,
          files: attached,
        }),
      });
      if (!response.ok || !response.body) {
        const errPayload = await response.json().catch(() => ({}));
        throw new Error(errPayload.error || `HTTP ${response.status}`);
      }

      let finalPayload = null;
      let streamError = "";
      const parser = sseParser((eventName, data) => {
        if (eventName === "plan" && data?.plan) {
          setPlan(data.plan);
        } else if (eventName === "subagent_start" && data) {
          setActiveSubagent(data);
        } else if (eventName === "step" && data) {
          setLiveSteps((prev) => [...prev.slice(-40), data]);
        } else if (eventName === "subagent_done") {
          setActiveSubagent(null);
        } else if (eventName === "message" && data?.message) {
          setMessages((prev) => [...prev, data.message]);
        } else if (eventName === "done") {
          finalPayload = data;
        } else if (eventName === "error") {
          streamError = data?.error || "Studio execution failed";
        }
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push("\n\n");
      if (streamError) throw new Error(streamError);

      if (finalPayload?.state?.messages) {
        setMessages(finalPayload.state.messages);
      }
      if (finalPayload?.plan) {
        setPlan(finalPayload.plan);
      }

      const modified = Array.isArray(finalPayload?.modifiedFiles) ? finalPayload.modifiedFiles : [];
      await loadFiles(modified[0] || "");
      if (modified.length > 0 || runMode === "build") {
        setPreviewNonce((n) => n + 1);
        if (modified.some((p) => p === "index.html" || p === "public/index.html" || p.endsWith(".css") || p.endsWith(".js"))) {
          setWorkspaceTab("preview");
        }
      }
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
      setActiveSubagent(null);
    }
  };

  const clearHistory = async () => {
    if (!orgId || !project?.id || busy) return;
    if (!window.confirm(t("agency.studioClearConfirm"))) return;
    try {
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/history`, { method: "DELETE" });
      setMessages([]);
      setPlan(null);
      setLiveSteps([]);
    } catch (err) {
      setError(err.message);
    }
  };

  const createFile = async (e) => {
    e.preventDefault();
    const rel = newFilePath.trim();
    if (!rel) return;
    setBusy("create"); setError(""); setNotice("");
    try {
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/file`, {
        method: "PUT",
        body: { path: rel, content: "" },
      });
      setNewFilePath("");
      await loadFiles(rel);
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const saveFile = async () => {
    if (!selectedPath) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/file`, {
        method: "PUT",
        body: { path: selectedPath, content },
      });
      setPreviewNonce((n) => n + 1);
      setNotice(`${selectedPath} ✓`);
      await loadFiles(selectedPath);
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const deleteFile = async () => {
    if (!selectedPath) return;
    setBusy("del"); setError("");
    try {
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/file?path=${enc(selectedPath)}`, { method: "DELETE" });
      setPreviewNonce((n) => n + 1);
      await loadFiles();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const runCheck = async () => {
    setBusy("run"); setError(""); setNotice("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/run`, {
        method: "POST",
        body: { action: command },
      });
      setTerminalOut(`$ ${command} (exit=${res.exitCode})\n${res.output || ""}`);
      setWorkspaceTab("ops");
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const rollbackSnapshot = async (commitHash) => {
    setBusy("rollback"); setError(""); setNotice("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/rollback`, {
        method: "POST",
        body: commitHash ? { commitHash } : {},
      });
      setNotice(t("agency.studioRollbackDone", { commit: (res.restoredCommit || "").slice(0, 7) }));
      await loadFiles();
      setPreviewNonce((n) => n + 1);
      onChanged?.();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const uploadStudioDocs = async (fileList) => {
    if (!fileList?.length) return;
    setBusy("upload"); setError(""); setNotice("");
    try {
      const docs = await Promise.all(Array.from(fileList).slice(0, 10).map(readFilePayload));
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/upload-docs`, {
        method: "POST",
        body: { files: docs },
      });
      const firstDoc = res.writtenFiles?.[0] || "";
      setNotice(t("agency.studioDocsUploaded", { count: (res.writtenFiles || []).length }));
      await loadFiles(firstDoc);
      onChanged?.();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const openFileInCode = (relPath) => {
    setWorkspaceTab("code");
    void openFile(relPath);
  };

  const hasIndex = files.some((f) => f.path === "index.html" || f.path === "public/index.html");
  const previewPath = files.some((f) => f.path === "public/index.html") ? "public/index.html" : "index.html";
  const previewUrl = `/amb/api/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/preview/${previewPath}?v=${previewNonce}`;

  const renderPlanCard = (pl, compact = false) => {
    if (!pl) return null;
    const canApprove = pl.status !== "running" && pl.tasks?.length > 0;
    return html`<div class="agency-studio-plan-card">
      <div class="agency-studio-plan-head">
        <div>
          <strong>${t("agency.studioPlanTitle")}</strong>
          ${pl.summary && html`<p>${pl.summary}</p>`}
        </div>
        <span class=${"agency-whatsapp-state " + pl.status}>${t(`agency.studioPlanStatus.${pl.status}`)}</span>
      </div>
      ${pl.designDirection && !compact && html`<small class="agency-muted"><strong>${t("agency.studioDesignLabel")}:</strong> ${pl.designDirection}</small>`}
      ${pl.architecture && !compact && html`<small class="agency-muted"><strong>${t("agency.studioArchLabel")}:</strong> ${pl.architecture}</small>`}
      ${pl.stack?.length > 0 && html`<div class="agency-copilot-attachments">
        ${pl.stack.map((s) => html`<span class="agency-studio-stack-pill">${s}</span>`)}
      </div>`}
      ${pl.tasks?.length > 0 && html`<div class="agency-studio-task-list">
        ${pl.tasks.map((tk) => html`<div class="agency-studio-task-row">
          <${BotAvatar} char=${agentAvatarOf(SUBAGENT_DEFAULT_ROLES[tk.subagent] || "developer")} size=${22} state=${tk.status === "running" ? "working" : "idle"} />
          <div class="agency-studio-task-body">
            <strong>${tk.title}</strong>
            <small>${t(`agency.studioSubagentNames.${tk.subagent}`)}${tk.targetFiles?.length ? ` · ${tk.targetFiles.join(", ")}` : ""}</small>
          </div>
          <span class=${"agency-whatsapp-state " + tk.status}>${tk.status}</span>
        </div>`)}
      </div>`}
      ${canApprove && html`<div class="agency-commercial-actions">
        <button class="btn primary" type="button" disabled=${!!busy} onClick=${() => sendStudioTurn({ mode: "build", executePlan: true, message: "", skipAttachments: true })}>
          <${Icon} name="spark" size="sm" />${t("agency.studioApprovePlanBtn")}
        </button>
      </div>`}
    </div>`;
  };

  return html`<section class="agency-studio-workbench">
    <div
      class=${"agency-studio-chat" + (dragging ? " dragging" : "")}
      onDragOver=${(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave=${() => setDragging(false)}
      onDrop=${(e) => { e.preventDefault(); setDragging(false); void handleChatFiles(e.dataTransfer?.files); }}
    >
      <div class="agency-studio-chat-top">
        <div class="agency-studio-mode-switch" role="tablist" aria-label=${t("agency.studioModeLabel")}>
          <button type="button" role="tab" aria-selected=${mode === "plan"} class=${mode === "plan" ? "active" : ""} onClick=${() => setMode("plan")}>${t("agency.studioModePlan")}</button>
          <button type="button" role="tab" aria-selected=${mode === "build"} class=${mode === "build" ? "active" : ""} onClick=${() => setMode("build")}>${t("agency.studioModeBuild")}</button>
        </div>
        <div class="agency-studio-chat-tools">
          <select class="field" aria-label=${t("agency.studioSubagentFilterLabel")} value=${targetSubagent} onChange=${(e) => setTargetSubagent(e.currentTarget.value)}>
            <option value="">${t("agency.studioSubagentAuto")}</option>
            <option value="architect">${t("agency.studioSubagentNames.architect")}</option>
            <option value="ui_ux">${t("agency.studioSubagentNames.ui_ux")}</option>
            <option value="frontend">${t("agency.studioSubagentNames.frontend")}</option>
            <option value="backend">${t("agency.studioSubagentNames.backend")}</option>
            <option value="qa">${t("agency.studioSubagentNames.qa")}</option>
          </select>
          ${messages.length > 0 && html`<button class="text" type="button" disabled=${!!busy} onClick=${clearHistory}>${t("agency.copilotClearBtn")}</button>`}
        </div>
      </div>

      ${error && html`<div class="agency-alert" role="alert">${error}</div>`}
      ${notice && html`<p class="agency-research-feedback" role="status">${notice}</p>`}

      <div class="agency-studio-thread" ref=${threadRef}>
        ${!messages.length && html`<div class="agency-studio-welcome">
          <span class="agency-quick-icon tone-purple"><${Icon} name="code" size="lg" /></span>
          <div>
            <h2>${project.title}</h2>
            <p>${t("agency.studioWelcomeDesc")}</p>
          </div>
          <div class="agency-studio-starters">
            <button type="button" class="agency-copilot-prompt" disabled=${!!busy} onClick=${() => sendStudioTurn({ mode: "plan", message: t("agency.studioStarterPlan") })}>
              <span>${t("agency.studioStarterPlan")}</span>
            </button>
            <button type="button" class="agency-copilot-prompt" disabled=${!!busy} onClick=${() => sendStudioTurn({ mode: "build", message: t("agency.studioStarterBuild") })}>
              <span>${t("agency.studioStarterBuild")}</span>
            </button>
            <button type="button" class="agency-copilot-prompt" disabled=${!!busy} onClick=${() => sendStudioTurn({ mode: "build", targetSubagent: "ui_ux", message: t("agency.studioStarterDesign") })}>
              <span>${t("agency.studioStarterDesign")}</span>
            </button>
            <button type="button" class="agency-copilot-prompt" disabled=${!!busy} onClick=${() => sendStudioTurn({ mode: "build", targetSubagent: "qa", message: t("agency.studioStarterQa") })}>
              <span>${t("agency.studioStarterQa")}</span>
            </button>
          </div>
          <small class="agency-muted">${t("agency.studioDropDocsHint")}</small>
        </div>`}

        ${messages.map((m) => m.role === "user"
          ? html`<article key=${m.id} class="agency-copilot-msg user">
              <div class="agency-studio-msg-tag">${m.mode === "plan" ? t("agency.studioModePlan") : t("agency.studioModeBuild")}</div>
              <p class="agency-copilot-user-text">${m.text}</p>
              ${m.files?.length > 0 && html`<div class="agency-copilot-attachments">
                ${m.files.map((fname) => html`<span class="agency-copilot-chip"><${Icon} name="doc" size="sm" />${fname}</span>`)}
              </div>`}
            </article>`
          : html`<article key=${m.id} class="agency-copilot-msg assistant">
              <div class="agency-copilot-msg-head">
                <div class="agency-copilot-msg-meta">
                  <strong>Studio IA</strong>
                  <span class="agency-whatsapp-state">${m.mode === "plan" ? t("agency.studioModePlan") : t("agency.studioModeBuild")}</span>
                </div>
                <${CopyButton} text=${m.text} />
              </div>
              <${Markdown} text=${m.text} />
              ${m.plan && renderPlanCard(m.plan, true)}
              ${m.subagentRuns?.length > 0 && html`<details class="agency-copilot-actions-list" open>
                <summary>${t("agency.studioSubagentRunsTitle")} (${m.subagentRuns.length})</summary>
                ${m.subagentRuns.map((run) => html`<div class="agency-copilot-action-row">
                  <span class="agency-agent-inline">
                    <${BotAvatar} char=${agentAvatarOf(SUBAGENT_DEFAULT_ROLES[run.subagent] || "developer")} size=${20} state="idle" />
                    <strong class="agency-truncate">${t(`agency.studioSubagentNames.${run.subagent}`)} · ${run.title}</strong>
                  </span>
                  <span class=${"agency-whatsapp-state " + (run.ok ? "accepted" : "blocked")}>${run.ok ? "OK" : "ERR"}</span>
                </div>`)}
              </details>`}
              ${m.modifiedFiles?.length > 0 && html`<div class="agency-copilot-attachments">
                ${m.modifiedFiles.map((f) => html`<button type="button" class="agency-studio-file-pill" onClick=${() => openFileInCode(f)}>
                  <${Icon} name="doc" size="sm" /><span>${f}</span>
                </button>`)}
              </div>`}
            </article>`)}

        ${busy === "chat" && html`<div class="agency-studio-live-stream">
          <div class="agency-loading">
            <${Spinner} />
            ${activeSubagent
              ? html`<span><strong>${activeSubagent.displayName || t(`agency.studioSubagentNames.${activeSubagent.subagent}`)}</strong> · ${activeSubagent.title}</span>`
              : html`<span>${mode === "plan" ? t("agency.studioPlanningStatus") : t("agency.studioBuildingStatus")}</span>`}
          </div>
          ${activeSubagent?.skills?.length > 0 && html`<div class="agency-copilot-attachments">
            ${activeSubagent.skills.map((sk) => html`<span class="agency-studio-stack-pill">${sk}</span>`)}
          </div>`}
          ${liveSteps.length > 0 && html`<div class="agency-studio-steps">
            ${liveSteps.slice(-6).map((st) => html`<div class="agency-audit-row">
              <strong>[${st.subagent || "agent"}] #${st.step} · ${st.tool}${st.target ? ` (${st.target})` : ""}</strong>
              <span class=${"agency-whatsapp-state " + (st.ok ? "accepted" : "blocked")}>${st.ok ? "OK" : "ERR"}</span>
            </div>`)}
          </div>`}
        </div>`}
      </div>

      ${attachments.length > 0 && html`<div class="agency-copilot-attachments">
        ${attachments.map((att, idx) => html`<span class="agency-copilot-chip">
          <${Icon} name="doc" size="sm" />
          <span>${att.name}</span>
          <button class="text" type="button" aria-label=${t("agency.close")} onClick=${() => setAttachments((p) => p.filter((_, i) => i !== idx))}><${Icon} name="close" size="sm" /></button>
        </span>`)}
      </div>`}

      <form class="agency-copilot-form" onSubmit=${(e) => { e.preventDefault(); void sendStudioTurn(); }}>
        <input
          ref=${chatUploadRef}
          class="agency-copilot-file-input"
          type="file"
          multiple
          accept=".txt,.md,.markdown,.csv,.json,.js,.mjs,.ts,.tsx,.jsx,.html,.css,.xml,.yaml,.yml,.sql,.pdf,.png,.jpg,.jpeg,.webp,.svg"
          onChange=${(e) => { void handleChatFiles(e.currentTarget.files); e.currentTarget.value = ""; }}
        />
        <button class="btn" type="button" disabled=${!!busy || attachments.length >= MAX_ATTACH} title=${t("agency.studioUploadDocsBtn")} onClick=${() => chatUploadRef.current?.click()}>
          <${Icon} name="doc" size="sm" />${t("agency.copilotAttachBtn")}
        </button>
        <input
          class="field"
          value=${input}
          placeholder=${mode === "plan" ? t("agency.studioPlanPlaceholder") : t("agency.studioBuildPlaceholder")}
          onInput=${(e) => setInput(e.currentTarget.value)}
        />
        <button class="btn primary" type="submit" disabled=${!!busy || (!input.trim() && attachments.length === 0)}>
          ${busy === "chat" ? html`<${Spinner} />` : html`<${Icon} name="spark" size="sm" />`}
          ${mode === "plan" ? t("agency.studioDiscussBtn") : t("agency.studioBuildBtn")}
        </button>
      </form>
    </div>

    <div class="agency-studio-workspace">
      <div class="agency-studio-ws-head">
        <div class="agency-subtabs" role="tablist">
          <button type="button" role="tab" aria-selected=${workspaceTab === "preview"} class=${workspaceTab === "preview" ? "active" : ""} onClick=${() => setWorkspaceTab("preview")}>${t("agency.studioTabPreview")}</button>
          <button type="button" role="tab" aria-selected=${workspaceTab === "code"} class=${workspaceTab === "code" ? "active" : ""} onClick=${() => setWorkspaceTab("code")}>${t("agency.studioTabCode")} (${files.length})</button>
          <button type="button" role="tab" aria-selected=${workspaceTab === "plan"} class=${workspaceTab === "plan" ? "active" : ""} onClick=${() => setWorkspaceTab("plan")}>${t("agency.studioTabPlan")}</button>
          <button type="button" role="tab" aria-selected=${workspaceTab === "ops"} class=${workspaceTab === "ops" ? "active" : ""} onClick=${() => setWorkspaceTab("ops")}>${t("agency.studioTabOps")}</button>
        </div>
        ${workspaceTab === "preview" && hasIndex && html`<div class="agency-commercial-actions">
          <button class=${"btn" + (viewport === "desktop" ? " primary" : "")} type="button" onClick=${() => setViewport("desktop")}>Desktop</button>
          <button class=${"btn" + (viewport === "tablet" ? " primary" : "")} type="button" onClick=${() => setViewport("tablet")}>Tablette</button>
          <button class=${"btn" + (viewport === "mobile" ? " primary" : "")} type="button" onClick=${() => setViewport("mobile")}>Mobile</button>
          <button class="btn" type="button" onClick=${() => setPreviewNonce((n) => n + 1)}>${t("agency.studioPreviewRefresh")}</button>
          <a class="btn" href=${previewUrl} target="_blank" rel="noopener">${t("agency.studioOpenNewTab")}</a>
        </div>`}
      </div>

      ${workspaceTab === "preview" && html`<div class="agency-studio-preview-pane">
        ${hasIndex
          ? html`<iframe class=${"agency-studio-frame " + viewport} title=${t("agency.studioPreviewTitle")} src=${previewUrl}></iframe>`
          : html`<div class="agency-empty">
              <${Icon} name="code" size="lg" />
              <strong>${t("agency.studioNoPreviewTitle")}</strong>
              <p>${t("agency.studioNoPreviewDesc")}</p>
            </div>`}
      </div>`}

      ${workspaceTab === "code" && html`<div class="agency-studio-grid">
        <div class="agency-studio-tree">
          <div class="agency-commercial-head">
            <strong>${t("agency.studioFilesTitle")}</strong>
            <div class="agency-commercial-actions">
              <input ref=${treeUploadRef} class="agency-copilot-file-input" type="file" multiple onChange=${(e) => { void uploadStudioDocs(e.currentTarget.files); e.currentTarget.value = ""; }} />
              <button class="btn" type="button" disabled=${!!busy} onClick=${() => treeUploadRef.current?.click()}><${Icon} name="doc" size="sm" />${t("agency.studioUploadDocsBtn")}</button>
            </div>
          </div>
          <form class="agency-studio-new-file" onSubmit=${createFile}>
            <input class="field" value=${newFilePath} placeholder=${t("agency.studioNewFilePlaceholder")} onInput=${(e) => setNewFilePath(e.currentTarget.value)} />
            <button class="btn" type="submit" disabled=${!!busy || !newFilePath.trim()}>${t("agency.studioNewFileBtn")}</button>
          </form>
          <div class="agency-studio-file-list">
            ${files.map((f) => html`<button type="button" class=${"agency-studio-file" + (f.path === selectedPath ? " active" : "")} title=${f.path} onClick=${() => openFile(f.path)}>${f.path}</button>`)}
          </div>
        </div>
        <div class="agency-studio-editor">
          <div class="agency-commercial-head">
            <strong class="agency-truncate" title=${selectedPath || ""}>${selectedPath || t("agency.studioNoFileSelected")}</strong>
            <div class="agency-commercial-actions">
              <button class="btn primary" type="button" disabled=${!selectedPath || !!busy} onClick=${saveFile}>${t("agency.studioSaveFileBtn")}</button>
              <button class="text" type="button" disabled=${!selectedPath || !!busy} onClick=${deleteFile}>${t("agency.studioDeleteFileBtn")}</button>
            </div>
          </div>
          <textarea
            class="field mono agency-studio-textarea"
            rows="20"
            value=${content}
            onInput=${(e) => setContent(e.currentTarget.value)}
            onKeyDown=${(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void saveFile(); } }}
          ></textarea>
        </div>
      </div>`}

      ${workspaceTab === "plan" && html`<div class="agency-studio-plan-pane">
        ${plan ? renderPlanCard(plan, false) : html`<div class="agency-empty">
          <strong>${t("agency.studioNoPlanTitle")}</strong>
          <p>${t("agency.studioNoPlanDesc")}</p>
        </div>`}
        <div class="agency-studio-subagents-section">
          <h3>${t("agency.studioSubagentsHeading")}</h3>
          <div class="agency-studio-subagent-grid">
            ${subagents.map((sa) => html`<article class="agency-studio-subagent-card">
              <div class="agency-agent-row-main">
                <${BotAvatar} char=${agentAvatarOf(sa.agencyRole)} size=${34} state=${activeSubagent?.subagent === sa.id ? "working" : "idle"} />
                <div>
                  <strong>${t(`agency.studioSubagentNames.${sa.id}`)}</strong>
                  <small>${sa.focus}</small>
                </div>
              </div>
              ${sa.skills?.length > 0 && html`<div class="agency-copilot-attachments">
                ${sa.skills.map((sk) => html`<span class="agency-studio-stack-pill">${sk}</span>`)}
              </div>`}
              <div class="agency-commercial-actions">
                <button class="btn" type="button" onClick=${() => { setTargetSubagent(sa.id); setMode("build"); }}>${t("agency.studioFocusSubagentBtn")}</button>
              </div>
            </article>`)}
          </div>
        </div>
      </div>`}

      ${workspaceTab === "ops" && html`<div class="agency-studio-ops-pane">
        <div class="agency-studio-toolbar">
          <div class="agency-commercial-actions">
            <select class="field" aria-label=${t("agency.cliActionLabel")} value=${command} onChange=${(e) => setCommand(e.currentTarget.value)}>
              ${COMMANDS.map(([id, label]) => html`<option value=${id}>${label}</option>`)}
            </select>
            <button class="btn primary" type="button" disabled=${!!busy} onClick=${runCheck}>${t("agency.studioRunCheckBtn")}</button>
          </div>
          ${snapshots.length > 0 && html`<div class="agency-commercial-actions">
            <select class="field" aria-label=${t("agency.studioSnapshotLabel")} value=${selectedSnapshot} onChange=${(e) => setSelectedSnapshot(e.currentTarget.value)}>
              ${snapshots.map((s) => html`<option value=${s.commitHash}>${s.commitHash.slice(0, 7)} · ${s.message.replace(/^studio:\s*/i, "").slice(0, 32)}</option>`)}
            </select>
            <button class="btn" type="button" disabled=${!!busy} onClick=${() => rollbackSnapshot(selectedSnapshot)}>${t("agency.studioRollbackBtn")}</button>
          </div>`}
        </div>
        ${terminalOut && html`<pre class="agency-studio-terminal mono">${terminalOut}</pre>`}
        ${snapshots.length > 0 && html`<div class="agency-studio-snapshots-list">
          ${snapshots.map((s) => html`<div class="agency-audit-row">
            <strong>${s.commitHash.slice(0, 7)} · ${s.message.replace(/^studio:\s*/i, "")}</strong>
            <button class="btn" type="button" disabled=${!!busy} onClick=${() => rollbackSnapshot(s.commitHash)}>${t("agency.studioRollbackBtn")}</button>
          </div>`)}
        </div>`}
      </div>`}
    </div>
  </section>`;
}
