import { useEffect, useState } from "preact/hooks";
import { html, Icon, Spinner } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";

const enc = encodeURIComponent;
const TEMPLATES = [
  ["vitrine-html", "Site vitrine (HTML/CSS/JS)"],
  ["webapp-node-preact", "Application Web (Node + Tests)"],
  ["api-node-ts", "API Service (Node + TypeScript)"],
];
const COMMANDS = [
  ["npm_test", "npm test"],
  ["npm_typecheck", "typecheck"],
  ["npm_build", "build"],
  ["git_status", "git status"],
  ["npm_install", "npm install"],
];

export function ProjectStudio({ orgId, project, onChanged }) {
  const [files, setFiles] = useState([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [template, setTemplate] = useState("vitrine-html");
  const [command, setCommand] = useState("npm_test");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [previewNonce, setPreviewNonce] = useState(1);
  const [mobilePreview, setMobilePreview] = useState(false);

  const loadFiles = async (preferPath = "") => {
    if (!orgId || !project?.id) return;
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/files`);
      const list = res.items || [];
      setFiles(list);
      const next = preferPath || (list.some((f) => f.path === selectedPath) ? selectedPath : (list[0]?.path || ""));
      if (next) await openFile(next);
      else { setSelectedPath(""); setContent(""); }
    } catch (err) {
      setError(err.message);
    }
  };

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

  useEffect(() => {
    setNotice("");
    setError("");
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
    setBusy("ai"); setError(""); setNotice("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/ai-agent`, {
        method: "POST",
        body: { instruction },
      });
      setNotice(res.summary || "");
      setInstruction("");
      await loadFiles(res.modifiedFiles?.[0] || "");
      setPreviewNonce((n) => n + 1);
      onChanged?.();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const hasIndex = files.some((f) => f.path === "index.html" || f.path === "public/index.html");
  const previewPath = files.some((f) => f.path === "public/index.html") ? "public/index.html" : "index.html";
  const previewUrl = `/amb/api/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/preview/${previewPath}?v=${previewNonce}`;

  return html`<section class="agency-project-section agency-studio">
    <div class="agency-commercial-actions">
      <label class="agency-stage-select"><span>${t("agency.studioScaffoldLabel")}</span>
        <select class="field" value=${template} onChange=${(e) => setTemplate(e.currentTarget.value)}>
          ${TEMPLATES.map(([id, label]) => html`<option value=${id}>${label}</option>`)}
        </select>
      </label>
      <button class="btn" type="button" disabled=${!!busy} onClick=${scaffold}>${t("agency.studioScaffoldBtn")}</button>
      <select class="field" aria-label=${t("agency.cliActionLabel")} value=${command} onChange=${(e) => setCommand(e.currentTarget.value)}>
        ${COMMANDS.map(([id, label]) => html`<option value=${id}>${label}</option>`)}
      </select>
      <button class="btn" type="button" disabled=${!!busy} onClick=${runCheck}>${t("agency.studioRunCheckBtn")}</button>
    </div>
    <form class="agency-copilot-form" onSubmit=${runAiBuilder}>
      <input class="field" value=${instruction} placeholder=${t("agency.studioAgentPlaceholder")} onInput=${(e) => setInstruction(e.currentTarget.value)} />
      <button class="btn primary" type="submit" disabled=${!!busy || !instruction.trim()}>
        ${busy === "ai" ? html`<${Spinner} />` : html`<${Icon} name="spark" />`}${t("agency.studioAgentRunBtn")}
      </button>
    </form>
    ${error && html`<div class="agency-alert" role="alert">${error}</div>`}
    ${notice && html`<p class="agency-research-feedback" role="status">${notice}</p>`}
    <div class="agency-studio-grid">
      <div class="agency-studio-tree">
        <strong>${t("agency.studioFilesTitle")} (${files.length})</strong>
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
