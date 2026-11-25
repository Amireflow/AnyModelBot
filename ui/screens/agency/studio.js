import { useEffect, useRef, useState } from "preact/hooks";
import { BotAvatar } from "../../components/avatar.js";
import { html, Icon, Spinner } from "../../components/ui.js";
import { api, sseParser } from "../../lib/api.js";
import { getLang, t } from "../../lib/i18n.js";
import { agentAvatarOf } from "./agent-avatars.js";
import { readFilePayload } from "./copilot.js";

const enc = encodeURIComponent;
const TEMPLATES = [
  ["vitrine-html", "Site vitrine (HTML/CSS/JS)"],
  ["webapp-node-preact", "Application Web (Node + Tests)"],
  ["api-node-ts", "API Service (Node + TypeScript)"],
  ["saas-dashboard-app", "Dashboard SaaS (KPIs + Filtres)"],
  ["ecommerce-storefront", "Boutique E-commerce (Catalogue + Panier)"],
];
const COMMANDS = [
  ["npm_test", "npm test"],
  ["npm_typecheck", "typecheck"],
  ["npm_build", "build"],
  ["git_status", "git status"],
  ["npm_install", "npm install"],
];
const STUDIO_ROLES = ["developer", "ui_ux", "architect"];

export function ProjectStudio({ orgId, project, onChanged }) {
  const [files, setFiles] = useState([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [template, setTemplate] = useState("vitrine-html");
  const [command, setCommand] = useState("npm_test");
  const [agentRole, setAgentRole] = useState("developer");
  const [instruction, setInstruction] = useState("");
  const [lastSteps, setLastSteps] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState("");
  const uploadInputRef = useRef(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [previewNonce, setPreviewNonce] = useState(1);
  const [mobilePreview, setMobilePreview] = useState(false);

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

  useEffect(() => {
    setNotice("");
    setError("");
    setLastSteps([]);
    void loadFiles();
  }, [orgId, project?.id]);

  const scaffold = async () => {
    setBusy("scaffold"); setError(""); setNotice("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/scaffold`, {
        method: "POST",
        body: { template },
      });
      await loadFiles(res.files?.[0] || res.created?.[0] || "index.html");
      setPreviewNonce((n) => n + 1);
      onChanged?.();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
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
      setNotice(`exit=${res.exitCode}: ${(res.output || "").slice(0, 220)}`);
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const runAiBuilder = async (e) => {
    e.preventDefault();
    if (!instruction.trim()) return;
    setBusy("ai"); setError(""); setNotice(""); setLastSteps([]);
    try {
      const response = await fetch(`/amb/api/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/ai-agent-stream`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-amb-lang": getLang() },
        body: JSON.stringify({ instruction, agentRole }),
      });
      if (!response.ok || !response.body) {
        const errPayload = await response.json().catch(() => ({}));
        throw new Error(errPayload.error || `HTTP ${response.status}`);
      }
      let finalPayload = null;
      let streamError = "";
      const parser = sseParser((eventName, data) => {
        if (eventName === "step" && data) {
          setLastSteps((prev) => [...prev, data]);
        } else if (eventName === "done") {
          finalPayload = data;
        } else if (eventName === "error") {
          streamError = data?.error || "Agent studio failed";
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
      const res = finalPayload || {};
      setNotice(res.summary || "");
      if (Array.isArray(res.steps) && res.steps.length) setLastSteps(res.steps);
      setInstruction("");
      await loadFiles(res.modifiedFiles?.[0] || "");
      setPreviewNonce((n) => n + 1);
      onChanged?.();
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

  const hasIndex = files.some((f) => f.path === "index.html" || f.path === "public/index.html");
  const previewPath = files.some((f) => f.path === "public/index.html") ? "public/index.html" : "index.html";
  const previewUrl = `/amb/api/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/preview/${previewPath}?v=${previewNonce}`;

  return html`<section class="agency-project-section agency-studio">
    <div class="agency-studio-toolbar">
      <div class="agency-commercial-actions">
        <label class="agency-stage-select"><span>${t("agency.studioScaffoldLabel")}</span>
          <select class="field" value=${template} onChange=${(e) => setTemplate(e.currentTarget.value)}>
            ${TEMPLATES.map(([id, label]) => html`<option value=${id}>${label}</option>`)}
          </select>
        </label>
        <button class="btn" type="button" disabled=${!!busy} onClick=${scaffold}>${t("agency.studioScaffoldBtn")}</button>
      </div>
      <div class="agency-commercial-actions">
        <select class="field" aria-label=${t("agency.cliActionLabel")} value=${command} onChange=${(e) => setCommand(e.currentTarget.value)}>
          ${COMMANDS.map(([id, label]) => html`<option value=${id}>${label}</option>`)}
        </select>
        <button class="btn" type="button" disabled=${!!busy} onClick=${runCheck}>${t("agency.studioRunCheckBtn")}</button>
        ${snapshots.length > 0 && html`
          <select class="field" aria-label=${t("agency.studioSnapshotLabel")} value=${selectedSnapshot} onChange=${(e) => setSelectedSnapshot(e.currentTarget.value)}>
            ${snapshots.map((s) => html`<option value=${s.commitHash}>${s.commitHash.slice(0, 7)} · ${s.message.replace(/^studio:\s*/i, "").slice(0, 28)}</option>`)}
          </select>
          <button class="btn" type="button" disabled=${!!busy} onClick=${() => rollbackSnapshot(selectedSnapshot)}>${t("agency.studioRollbackBtn")}</button>
        `}
      </div>
    </div>
    <form class="agency-copilot-form" onSubmit=${runAiBuilder}>
      <${BotAvatar} key=${agentRole} char=${agentAvatarOf(agentRole)} size=${30} state=${busy === "ai" ? "working" : "idle"} />
      <select class="field" aria-label=${t("agency.missionRoleLabel")} value=${agentRole} onChange=${(e) => setAgentRole(e.currentTarget.value)}>
        ${STUDIO_ROLES.map((r) => html`<option value=${r}>${t(`agency.agentRoleNames.${r}`)}</option>`)}
      </select>
      <input class="field" value=${instruction} placeholder=${t("agency.studioAgentPlaceholder")} onInput=${(e) => setInstruction(e.currentTarget.value)} />
      <button class="btn primary" type="submit" disabled=${!!busy || !instruction.trim()}>
        ${busy === "ai" ? html`<${Spinner} />` : html`<${Icon} name="spark" size="sm" />`}${t("agency.studioAgentRunBtn")}
      </button>
    </form>
    ${error && html`<div class="agency-alert" role="alert">${error}</div>`}
    ${notice && html`<p class="agency-research-feedback" role="status">${notice}</p>`}
    ${lastSteps.length > 0 && html`<details class="agency-brief-details">
      <summary>${t("agency.studioStepsTitle")} (${lastSteps.length})</summary>
      <div class="agency-studio-steps">
        ${lastSteps.map((st) => html`<div class="agency-audit-row">
          <strong>#${st.step} · ${st.tool}${st.target ? ` (${st.target})` : ""}</strong>
          <span class=${"agency-whatsapp-state " + (st.ok ? "accepted" : "blocked")}>${st.ok ? "OK" : "ERR"}</span>
        </div>`)}
      </div>
    </details>`}
    <div class="agency-studio-grid">
      <div class="agency-studio-tree">
        <div class="agency-commercial-head">
          <strong>${t("agency.studioFilesTitle")}</strong>
          <div class="agency-commercial-actions">
            <input ref=${uploadInputRef} class="agency-copilot-file-input" type="file" multiple onChange=${(e) => { void uploadStudioDocs(e.currentTarget.files); e.currentTarget.value = ""; }} />
            <button class="btn" type="button" disabled=${!!busy} onClick=${() => uploadInputRef.current?.click()}><${Icon} name="doc" size="sm" />${t("agency.studioUploadDocsBtn")}</button>
            <span class="agency-count-pill">${files.length}</span>
          </div>
        </div>
        <form class="agency-studio-new-file" onSubmit=${createFile}>
          <input class="field" value=${newFilePath} placeholder=${t("agency.studioNewFilePlaceholder")} onInput=${(e) => setNewFilePath(e.currentTarget.value)} />
          <button class="btn" type="submit" disabled=${!!busy || !newFilePath.trim()}>${t("agency.studioNewFileBtn")}</button>
        </form>
        <div class="agency-studio-file-list">
          ${files.map((f) => html`<button type="button" class=${"agency-studio-file" + (f.path === selectedPath ? " active" : "")} onClick=${() => openFile(f.path)}>${f.path}</button>`)}
        </div>
      </div>
      <div class="agency-studio-editor">
        <div class="agency-commercial-head">
          <strong>${selectedPath || "—"}</strong>
          <div class="agency-commercial-actions">
            <button class="btn primary" type="button" disabled=${!selectedPath || !!busy} onClick=${saveFile}>${t("agency.studioSaveFileBtn")}</button>
            <button class="text" type="button" disabled=${!selectedPath || !!busy} onClick=${deleteFile}>${t("agency.studioDeleteFileBtn")}</button>
          </div>
        </div>
        <textarea class="field mono agency-studio-textarea" rows="16" value=${content} onInput=${(e) => setContent(e.currentTarget.value)}></textarea>
      </div>
    </div>
    ${hasIndex && html`<div class="agency-studio-preview">
      <div class="agency-commercial-head">
        <strong>${t("agency.studioPreviewTitle")}</strong>
        <div class="agency-commercial-actions">
          <button class="btn" type="button" onClick=${() => setMobilePreview((v) => !v)}>${mobilePreview ? "Desktop" : "Mobile"}</button>
          <button class="btn" type="button" onClick=${() => setPreviewNonce((n) => n + 1)}>${t("agency.studioPreviewRefresh")}</button>
        </div>
      </div>
      <iframe class=${"agency-studio-frame" + (mobilePreview ? " mobile" : "")} title=${t("agency.studioPreviewTitle")} src=${previewUrl}></iframe>
    </div>`}
  </section>`;
}
