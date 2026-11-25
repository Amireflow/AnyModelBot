import { useEffect, useRef, useState } from "preact/hooks";
import { CopyButton, html, Icon, Select, Spinner } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { fmtNum, t } from "../../lib/i18n.js";
import { confirmSheet } from "../../lib/store.js";
import { readFilePayload } from "./copilot.js";

const enc = encodeURIComponent;

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function renderDiffLines(patch) {
  const lines = String(patch || "").split(/\r?\n/).slice(0, 350);
  return lines.map((line, idx) => {
    const cls = line.startsWith("+") && !line.startsWith("+++")
      ? "add"
      : line.startsWith("-") && !line.startsWith("---")
        ? "remove"
        : line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("--- ") || line.startsWith("+++ ")
          ? "meta"
          : "";
    return html`<span key=${idx} class=${"agency-ide-diff-line " + cls}><code>${line || " "}</code></span>`;
  });
}

export function ProjectWorkspaceIde({ orgId, project, lots = [], onChanged }) {
  const [evolution, setEvolution] = useState(null);
  const [ides, setIdes] = useState([]);
  const [selectedIdeId, setSelectedIdeId] = useState("");
  const [runs, setRuns] = useState([]);

  const [subTab, setSubTab] = useState("evolution"); // evolution | files | checks
  const [files, setFiles] = useState([]);
  const [fileQuery, setFileQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);

  const [selectedDiffPath, setSelectedDiffPath] = useState("");
  const [diffPatch, setDiffPatch] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);

  const [linkerOpen, setLinkerOpen] = useState(false);
  const [browseData, setBrowseData] = useState(null);
  const [manualPath, setManualPath] = useState("");

  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState({
    name: "",
    category: "ide",
    executable: "",
    openDirArgs: "{dir}",
    openFileArgs: "-g {file}:{line}",
    promptArgs: "-p {prompt}",
  });

  const [missionLotId, setMissionLotId] = useState("");
  const [missionPrompt, setMissionPrompt] = useState("");
  const [lastPromptText, setLastPromptText] = useState("");
  const [cmdResult, setCmdResult] = useState(null);
  const [expandedRunId, setExpandedRunId] = useState("");

  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const uploadRef = useRef(null);

  const loadIdes = async (refresh = false) => {
    if (!orgId) return;
    try {
      const res = await api(`/agency/${enc(orgId)}/ide/tools${refresh ? "?refresh=1" : ""}`);
      const list = Array.isArray(res.items) ? res.items : [];
      setIdes(list);
      setSelectedIdeId((prev) => {
        if (prev && list.some((x) => x.id === prev && x.available)) return prev;
        const preferred = list.find((x) => x.available && x.category === "ide")
          ?? list.find((x) => x.available);
        return preferred?.id || list[0]?.id || "";
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const loadEvolution = async (pid = project?.id) => {
    if (!orgId || !pid) return;
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/workspace/evolution`);
      setEvolution(res.evolution || null);
      const firstChange = res.evolution?.git?.changes?.[0]?.path || "";
      if (firstChange) void loadDiff(firstChange, pid);
      else {
        setSelectedDiffPath("");
        setDiffPatch("");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const loadFiles = async (q = fileQuery, pid = project?.id) => {
    if (!orgId || !pid) return;
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/workspace/files${q ? `?q=${enc(q)}` : ""}`);
      setFiles(Array.isArray(res.items) ? res.items : []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadRuns = async (pid = project?.id) => {
    if (!orgId || !pid) return;
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/ide/runs`);
      setRuns(Array.isArray(res.items) ? res.items : []);
    } catch {
      /* ignore */
    }
  };

  const loadDiff = async (relPath = "", pid = project?.id) => {
    if (!orgId || !pid) return;
    setSelectedDiffPath(relPath);
    setDiffLoading(true);
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/workspace/diff${relPath ? `?path=${enc(relPath)}` : ""}`);
      setDiffPatch(res.patch || "");
    } catch {
      setDiffPatch("");
    } finally {
      setDiffLoading(false);
    }
  };

  const openFile = async (relPath) => {
    if (!orgId || !project?.id || !relPath) return;
    setBusy("file");
    setError("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/workspace/file?path=${enc(relPath)}`);
      setSelectedFile(res || null);
      setSubTab("files");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    void loadIdes(false);
  }, [orgId]);

  useEffect(() => {
    setSelectedFile(null);
    setSelectedDiffPath("");
    setDiffPatch("");
    setCmdResult(null);
    setNotice("");
    setError("");
    setManualPath(project?.localPath || "");
    if (orgId && project?.id) {
      void Promise.all([loadEvolution(project.id), loadFiles("", project.id), loadRuns(project.id)]);
    }
  }, [orgId, project?.id, project?.localPath]);

  const hasRunningCli = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!hasRunningCli || !orgId || !project?.id) return;
    const timer = setInterval(() => {
      void loadRuns(project.id);
      void loadEvolution(project.id);
    }, 2200);
    return () => clearInterval(timer);
  }, [hasRunningCli, orgId, project?.id]);

  const browseDir = async (dirPath = "") => {
    setBusy("browse");
    setError("");
    try {
      const res = await api(`/agency/${enc(orgId)}/machine/browse${dirPath ? `?path=${enc(dirPath)}` : ""}`);
      setBrowseData(res);
      if (res.currentPath) setManualPath(res.currentPath);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const applyLocalPath = async (nextPath) => {
    if (!orgId || !project?.id) return;
    setBusy("link");
    setError("");
    setNotice("");
    try {
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/workspace`, {
        method: "PATCH",
        body: { localPath: nextPath },
      });
      setLinkerOpen(false);
      setNotice(nextPath ? t("agency.wsLinkedSuccess", { path: nextPath }) : t("agency.wsUnlinkedSuccess"));
      onChanged?.();
      await Promise.all([loadEvolution(project.id), loadFiles("", project.id)]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const syncBrief = async () => {
    if (!orgId || !project?.id) return;
    setBusy("brief");
    setError("");
    setNotice("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/workspace/sync-brief`, { method: "POST" });
      setNotice(t("agency.wsBriefSynced", { path: res.brief?.path || ".anymodelbot/BRIEF.md" }));
      await loadEvolution(project.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const handleUploadDocs = async (fileList) => {
    const picked = Array.from(fileList || []).slice(0, 8);
    if (!picked.length || !orgId || !project?.id) return;
    setBusy("upload");
    setError("");
    setNotice("");
    try {
      const payloads = await Promise.all(picked.map((f) => readFilePayload(f)));
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/workspace/upload-docs`, {
        method: "POST",
        body: { files: payloads },
      });
      setNotice(t("agency.wsDocsUploaded", { count: (res.writtenFiles || []).length }));
      await Promise.all([loadFiles(fileQuery, project.id), loadEvolution(project.id)]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const openInIde = async (relPath = "") => {
    if (!orgId || !project?.id || !selectedIdeId) return;
    setBusy("ide-open");
    setError("");
    setNotice("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/ide/open`, {
        method: "POST",
        body: { ideId: selectedIdeId, ...(relPath ? { path: relPath, line: 1 } : {}) },
      });
      setNotice(t("agency.ideOpenedNotice", { ide: res.ideName || selectedIdeId, target: res.openedTarget || "" }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const dispatchToIde = async (e) => {
    e?.preventDefault?.();
    if (!orgId || !project?.id || !missionPrompt.trim()) return;
    setBusy("ide-dispatch");
    setError("");
    setNotice("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/ide/dispatch`, {
        method: "POST",
        body: {
          ideId: selectedIdeId || undefined,
          lotId: missionLotId || undefined,
          instruction: missionPrompt.trim(),
        },
      });
      setLastPromptText(res.promptText || "");
      setExpandedRunId(res.run?.id || "");
      setNotice(t("agency.ideDispatchedNotice", { ide: res.run?.ideName || selectedIdeId, file: res.run?.missionFile || "" }));
      setMissionPrompt("");
      await Promise.all([loadRuns(project.id), loadEvolution(project.id)]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const stopRun = async (runId) => {
    if (!orgId || !project?.id || !runId) return;
    try {
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/ide/runs/${enc(runId)}/stop`, { method: "POST" });
      await loadRuns(project.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const saveCustomIde = async (e) => {
    e.preventDefault();
    if (!orgId) return;
    setBusy("custom-ide");
    setError("");
    try {
      const splitArgs = (raw) => String(raw || "").trim().split(/\s+/).filter(Boolean);
      const res = await api(`/agency/${enc(orgId)}/ide/profiles`, {
        method: "POST",
        body: {
          name: customDraft.name,
          category: customDraft.category,
          executable: customDraft.executable,
          openDirArgs: splitArgs(customDraft.openDirArgs),
          openFileArgs: splitArgs(customDraft.openFileArgs),
          promptArgs: customDraft.category === "cli_agent" ? splitArgs(customDraft.promptArgs) : undefined,
        },
      });
      setIdes(Array.isArray(res.items) ? res.items : []);
      if (res.profile?.id) setSelectedIdeId(res.profile.id);
      setCustomFormOpen(false);
      setCustomDraft({ name: "", category: "ide", executable: "", openDirArgs: "{dir}", openFileArgs: "-g {file}:{line}", promptArgs: "-p {prompt}" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const removeCustomIde = async (id) => {
    if (!orgId || !id) return;
    if (!(await confirmSheet({ title: t("agency.ideDeleteProfileConfirm"), danger: true }))) return;
    try {
      const res = await api(`/agency/${enc(orgId)}/ide/profiles/${enc(id)}`, { method: "DELETE" });
      setIdes(Array.isArray(res.items) ? res.items : []);
    } catch (err) {
      setError(err.message);
    }
  };

  const runCheck = async (action) => {
    if (!orgId || !project?.id) return;
    setBusy(`cmd-${action}`);
    setError("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/workspace/run`, {
        method: "POST",
        body: { action },
      });
      setCmdResult(res);
      setSubTab("checks");
      await loadEvolution(project.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  if (!project) return null;

  const selectedIde = ides.find((x) => x.id === selectedIdeId) || null;
  const ideOptions = ides.map((x) => [
    x.id,
    `${x.name} (${x.available ? t("agency.ideReadyBadge") : t("agency.ideMissingBadge")})`,
  ]);

  return html`<div class="agency-ide-workspace">
    ${error && html`<p class="agency-alert" role="alert">${error}</p>`}
    ${notice && html`<p class="agency-research-feedback" role="status">${notice}</p>`}

    <section class="agency-project-section agency-ide-dir-bar">
      <div class="agency-ide-dir-meta">
        <span class=${"agency-whatsapp-state " + (evolution?.mode === "linked" ? "accepted" : "pending")}>
          ${evolution?.mode === "linked" ? t("agency.wsLinkedBadge") : t("agency.wsManagedBadge")}
        </span>
        <code class="agency-ide-dir-path mono agency-truncate" title=${evolution?.directory || project.localPath || project.workspacePath}>
          ${evolution?.directory || project.localPath || project.workspacePath}
        </code>
      </div>
      <div class="agency-commercial-actions">
        <button type="button" class="btn primary sm" onClick=${() => {
          const next = !linkerOpen;
          setLinkerOpen(next);
          if (next) void browseDir(project.localPath || "");
        }}>
          <${Icon} name="folder" size="xs" /><span>${t("agency.wsLinkDirBtn")}</span>
        </button>
        ${project.localPath && html`<button type="button" class="btn sm" disabled=${!!busy} onClick=${() => applyLocalPath("")}>
          <span>${t("agency.wsUnlinkDirBtn")}</span>
        </button>`}
        <button type="button" class="btn sm" disabled=${!!busy} onClick=${syncBrief}>
          <${Icon} name="clipboardCheck" size="xs" /><span>${t("agency.wsSyncBriefBtn")}</span>
        </button>
        <input
          ref=${uploadRef}
          class="agency-copilot-file-input"
          type="file"
          multiple
          onChange=${(e) => { void handleUploadDocs(e.currentTarget.files); e.currentTarget.value = ""; }}
        />
        <button type="button" class="btn sm" disabled=${!!busy} onClick=${() => uploadRef.current?.click()}>
          <${Icon} name="file" size="xs" /><span>${t("agency.wsUploadDocsBtn")}</span>
        </button>
        <button type="button" class="icon-btn sm" title=${t("agency.wsRefreshBtn")} aria-label=${t("agency.wsRefreshBtn")} onClick=${() => {
          void loadEvolution(project.id);
          void loadFiles(fileQuery, project.id);
          void loadRuns(project.id);
        }}>
          <${Icon} name="refresh" size="sm" />
        </button>
      </div>
    </section>

    ${linkerOpen && html`<section class="agency-project-section agency-ide-browser">
      <div class="agency-commercial-head">
        <strong>${t("agency.wsBrowseMachineTitle")}</strong>
        <div class="agency-commercial-actions">
          ${browseData?.parentPath !== undefined && browseData?.parentPath !== null && html`<button type="button" class="btn sm" onClick=${() => browseDir(browseData.parentPath)}>..</button>`}
          ${browseData?.homePath && html`<button type="button" class="btn sm" onClick=${() => browseDir(browseData.homePath)}>Home</button>`}
          <button type="button" class="text" onClick=${() => setLinkerOpen(false)}>${t("agency.close")}</button>
        </div>
      </div>
      <form class="agency-ide-path-form" onSubmit=${(e) => { e.preventDefault(); void applyLocalPath(manualPath); }}>
        <input
          class="field mono"
          value=${manualPath}
          placeholder=${t("agency.wsLocalPathPlaceholder")}
          onInput=${(e) => setManualPath(e.currentTarget.value)}
        />
        <button type="button" class="btn sm" disabled=${!!busy || !manualPath.trim()} onClick=${() => browseDir(manualPath)}>${t("agency.open")}</button>
        <button type="submit" class="btn primary sm" disabled=${!!busy || !manualPath.trim()}>${t("agency.wsConfirmLinkBtn")}</button>
      </form>
      <div class="agency-ide-dir-list">
        ${(browseData?.entries || []).map((entry) => html`<button
          key=${entry.path}
          type="button"
          class="agency-ide-dir-row"
          onClick=${() => browseDir(entry.path)}
        >
          <${Icon} name="folder" size="sm" />
          <span class="agency-truncate">${entry.name}</span>
          <span class="grow"></span>
          ${entry.isGitRepo && html`<span class="agency-ide-mini-pill">Git</span>`}
          ${entry.hasPackageJson && html`<span class="agency-ide-mini-pill">npm</span>`}
        </button>`)}
      </div>
    </section>`}

    <section class="agency-project-section agency-ide-control">
      <div class="agency-commercial-head">
        <h3>${t("agency.ideControlTitle")}</h3>
        <div class="agency-commercial-actions">
          <${Select}
            block=${false}
            width=${260}
            label=${t("agency.ideSelectLabel")}
            value=${selectedIdeId}
            options=${ideOptions}
            onChange=${setSelectedIdeId}
          />
          <button type="button" class="icon-btn sm" title=${t("agency.wsRefreshBtn")} aria-label=${t("agency.wsRefreshBtn")} onClick=${() => loadIdes(true)}>
            <${Icon} name="refresh" size="sm" />
          </button>
          <button type="button" class="btn sm" onClick=${() => setCustomFormOpen((v) => !v)}>
            <${Icon} name=${customFormOpen ? "close" : "plus"} size="xs" /><span>${t("agency.ideAddCustomBtn")}</span>
          </button>
          ${selectedIde?.custom && html`<button type="button" class="icon-btn sm" title=${t("agency.deleteBtn")} aria-label=${t("agency.deleteBtn")} onClick=${() => removeCustomIde(selectedIde.id)}>
            <${Icon} name="trash" size="xs" />
          </button>`}
          <button type="button" class="btn primary sm" disabled=${!!busy || !selectedIde?.available} onClick=${() => openInIde("")}>
            <${Icon} name="code" size="xs" /><span>${t("agency.ideOpenProjectBtn")}</span>
          </button>
        </div>
      </div>

      ${selectedIde && !selectedIde.available && html`<p class="agency-muted">${t("agency.ideUnavailableHint", { ide: selectedIde.name, exe: selectedIde.executable })}</p>`}

      ${customFormOpen && html`<form class="agency-form agency-form-grid" onSubmit=${saveCustomIde}>
        <label class="agency-field"><span>${t("agency.ideCustomName")}</span><input class="field" required value=${customDraft.name} placeholder="Cursor / Windsurf / Zed..." onInput=${(e) => setCustomDraft((p) => ({ ...p, name: e.currentTarget.value }))} /></label>
        <div class="agency-field"><span>${t("agency.ideCustomCategory")}</span>
          <${Select} label=${t("agency.ideCustomCategory")} value=${customDraft.category} options=${[["ide", t("agency.ideTypeGui")], ["cli_agent", t("agency.ideTypeCli")]]} onChange=${(v) => setCustomDraft((p) => ({ ...p, category: v }))} />
        </div>
        <label class="agency-field agency-form-wide"><span>${t("agency.ideCustomExecutable")}</span><input class="field mono" required value=${customDraft.executable} placeholder="C:\\Users\\...\\Code.exe ou claude" onInput=${(e) => setCustomDraft((p) => ({ ...p, executable: e.currentTarget.value }))} /></label>
        <label class="agency-field"><span>${t("agency.ideCustomDirArgs")}</span><input class="field mono" value=${customDraft.openDirArgs} onInput=${(e) => setCustomDraft((p) => ({ ...p, openDirArgs: e.currentTarget.value }))} /></label>
        <label class="agency-field"><span>${t("agency.ideCustomFileArgs")}</span><input class="field mono" value=${customDraft.openFileArgs} onInput=${(e) => setCustomDraft((p) => ({ ...p, openFileArgs: e.currentTarget.value }))} /></label>
        ${customDraft.category === "cli_agent" && html`<label class="agency-field agency-form-wide"><span>${t("agency.ideCustomPromptArgs")}</span><input class="field mono" value=${customDraft.promptArgs} onInput=${(e) => setCustomDraft((p) => ({ ...p, promptArgs: e.currentTarget.value }))} /></label>`}
        <div class="agency-form-actions"><button class="btn primary sm" type="submit" disabled=${busy === "custom-ide"}>${t("agency.saveCatalogItem")}</button></div>
      </form>`}

      <form class="agency-ide-dispatch" onSubmit=${dispatchToIde}>
        <div class="agency-ide-dispatch-row">
          ${lots.length > 0 && html`<${Select}
            block=${false}
            width=${240}
            label=${t("agency.projTabLots")}
            value=${missionLotId}
            placeholder=${t("agency.ideNoLotOption")}
            options=${[["", t("agency.ideNoLotOption")], ...lots.map((l) => [l.id, `#${l.lotOrder} ${l.title}`])]}
            onChange=${setMissionLotId}
          />`}
          <textarea
            class="field agency-ide-prompt-box"
            rows="2"
            value=${missionPrompt}
            placeholder=${t("agency.idePromptPlaceholder")}
            onInput=${(e) => setMissionPrompt(e.currentTarget.value)}
          ></textarea>
          <div class="agency-commercial-actions">
            <button type="submit" class="btn primary" disabled=${!!busy || !missionPrompt.trim() || !selectedIde?.available}>
              ${busy === "ide-dispatch" ? html`<${Spinner} />` : html`<${Icon} name="spark" size="xs" />`}
              <span>${t("agency.ideDispatchBtn")}</span>
            </button>
            ${lastPromptText && html`<${CopyButton} text=${lastPromptText} />`}
          </div>
        </div>
      </form>

      ${runs.length > 0 && html`<div class="agency-ide-runs">
        ${runs.slice(0, 6).map((run) => {
          const open = expandedRunId === run.id;
          return html`<article key=${run.id} class="agency-ide-run-row">
            <div class="agency-ide-run-head">
              <button type="button" class="agency-ide-run-toggle" aria-expanded=${open} onClick=${() => setExpandedRunId(open ? "" : run.id)}>
                <${Icon} name="chevRight" size="xs" class="chev" />
                <strong class="agency-truncate">${run.ideName} — ${run.title}</strong>
              </button>
              <span class=${"agency-whatsapp-state " + (run.status === "completed" || run.status === "dispatched_to_ide" ? "completed" : run.status === "running" ? "pending" : "failed")}>
                ${t(`agency.ideRunStatus.${run.status}`)}
              </span>
              ${run.status === "running" && html`<button type="button" class="btn sm" onClick=${() => stopRun(run.id)}>
                <${Icon} name="stop" size="xs" /><span>${t("common.off")}</span>
              </button>`}
            </div>
            ${run.summary && html`<small class="agency-muted">${run.summary}</small>`}
            ${open && html`<div class="agency-ide-run-logs">
              <code class="mono">${run.missionFile}</code>
              ${run.logs?.length > 0 && html`<pre class="agency-ide-log-pre mono">${run.logs.join("\n")}</pre>`}
            </div>`}
          </article>`;
        })}
      </div>`}
    </section>

    <div class="agency-subtabs" role="tablist">
      <button type="button" role="tab" aria-selected=${subTab === "evolution"} class=${subTab === "evolution" ? "active" : ""} onClick=${() => setSubTab("evolution")}>${t("agency.wsTabEvolution")}</button>
      <button type="button" role="tab" aria-selected=${subTab === "files"} class=${subTab === "files" ? "active" : ""} onClick=${() => setSubTab("files")}>${t("agency.wsTabFiles")} (${files.length})</button>
      <button type="button" role="tab" aria-selected=${subTab === "checks"} class=${subTab === "checks" ? "active" : ""} onClick=${() => setSubTab("checks")}>${t("agency.wsTabChecks")}</button>
    </div>

    ${subTab === "evolution" && evolution && html`<div class="agency-ops-stack">
      <div class="agency-kpi-grid">
        <article class="agency-metric">
          <div class="agency-metric-top"><span class="agency-metric-label">${t("agency.wsKpiFiles")}</span><span class="agency-metric-icon tone-blue"><${Icon} name="file" size="sm" /></span></div>
          <strong class="agency-metric-value num">${fmtNum(evolution.stats.fileCount)}</strong>
        </article>
        <article class="agency-metric">
          <div class="agency-metric-top"><span class="agency-metric-label">${t("agency.wsKpiSize")}</span><span class="agency-metric-icon tone-teal"><${Icon} name="folder" size="sm" /></span></div>
          <strong class="agency-metric-value num">${formatBytes(evolution.stats.totalBytes)}</strong>
        </article>
        <article class="agency-metric">
          <div class="agency-metric-top"><span class="agency-metric-label">${t("agency.wsKpiBranch")}</span><span class="agency-metric-icon tone-purple"><${Icon} name="code" size="sm" /></span></div>
          <strong class="agency-metric-value agency-truncate">${evolution.git.isRepo ? (evolution.git.branch || "HEAD") : t("agency.wsNoGit")}</strong>
        </article>
        <article class="agency-metric">
          <div class="agency-metric-top"><span class="agency-metric-label">${t("agency.wsKpiChanges")}</span><span class="agency-metric-icon tone-amber"><${Icon} name="clipboardCheck" size="sm" /></span></div>
          <strong class="agency-metric-value num">${fmtNum(evolution.git.changes.length)}</strong>
        </article>
      </div>

      ${evolution.stack?.length > 0 && html`<div class="agency-copilot-attachments">
        ${evolution.stack.map((st) => html`<span key=${st} class="agency-ide-mini-pill">${st}</span>`)}
      </div>`}

      <div class="agency-commercial-grid">
        <section class="agency-project-section">
          <div class="agency-commercial-head">
            <h3>${t("agency.wsGitChangesTitle")}</h3>
            ${evolution.git.diffStat && html`<small class="agency-muted mono">${evolution.git.diffStat}</small>`}
          </div>
          ${!evolution.git.changes.length
            ? html`<p class="agency-muted">${t("agency.wsNoGitChanges")}</p>`
            : html`<div class="agency-ide-list">
                ${evolution.git.changes.map((chg) => html`<div key=${chg.path} class=${"agency-ide-list-row" + (selectedDiffPath === chg.path ? " active" : "")}>
                  <button type="button" class="agency-ide-list-btn mono" onClick=${() => loadDiff(chg.path)}>
                    <span class="agency-ide-mini-pill">${chg.code}</span>
                    <span class="agency-truncate">${chg.path}</span>
                  </button>
                  <button type="button" class="icon-btn xs" title=${t("agency.ideOpenFileBtn")} onClick=${() => openInIde(chg.path)}>
                    <${Icon} name="code" size="xs" />
                  </button>
                </div>`)}
              </div>`}
          ${(diffPatch || diffLoading) && html`<div class="agency-ide-diff-box mono">
            ${diffLoading ? html`<${Spinner} />` : renderDiffLines(diffPatch)}
          </div>`}
        </section>

        <section class="agency-project-section">
          <h3>${t("agency.wsRecentFilesTitle")}</h3>
          <div class="agency-ide-list">
            ${evolution.recentFiles.map((f) => html`<div key=${f.path} class="agency-ide-list-row">
              <button type="button" class="agency-ide-list-btn mono" onClick=${() => openFile(f.path)}>
                <${Icon} name="file" size="xs" />
                <span class="agency-truncate">${f.path}</span>
                <span class="grow"></span>
                <small>${formatBytes(f.size)}</small>
              </button>
              <button type="button" class="icon-btn xs" title=${t("agency.ideOpenFileBtn")} onClick=${() => openInIde(f.path)}>
                <${Icon} name="code" size="xs" />
              </button>
            </div>`)}
          </div>

          <h3>${t("agency.wsGitCommitsTitle")}</h3>
          ${!evolution.git.recentCommits.length
            ? html`<p class="agency-muted">${t("agency.wsNoCommits")}</p>`
            : html`<div class="agency-ide-list">
                ${evolution.git.recentCommits.map((cm) => html`<div key=${cm.hash} class="agency-ide-commit-row">
                  <code class="mono">${cm.shortHash}</code>
                  <span class="agency-truncate">${cm.subject}</span>
                  <span class="grow"></span>
                  <small class="agency-muted">${cm.author}</small>
                </div>`)}
              </div>`}
        </section>
      </div>
    </div>`}

    ${subTab === "files" && html`<div class="agency-ide-files-shell">
      <section class="agency-project-section agency-ide-file-nav">
        <label class="agency-search">
          <${Icon} name="search" size="sm" />
          <input
            type="search"
            value=${fileQuery}
            placeholder=${t("agency.wsFilterFilesPlaceholder")}
            onInput=${(e) => {
              const next = e.currentTarget.value;
              setFileQuery(next);
              void loadFiles(next, project.id);
            }}
          />
        </label>
        <div class="agency-ide-list">
          ${files.map((f) => html`<button
            key=${f.path}
            type="button"
            class=${"agency-ide-list-btn mono" + (selectedFile?.path === f.path ? " active" : "")}
            onClick=${() => openFile(f.path)}
          >
            <${Icon} name="file" size="xs" />
            <span class="agency-truncate">${f.path}</span>
            <span class="grow"></span>
            <small>${formatBytes(f.size)}</small>
          </button>`)}
        </div>
      </section>

      <section class="agency-project-section agency-ide-file-view">
        ${!selectedFile
          ? html`<p class="agency-muted">${t("agency.wsSelectFileHint")}</p>`
          : html`
            <div class="agency-commercial-head">
              <strong class="mono agency-truncate">${selectedFile.path}</strong>
              <div class="agency-commercial-actions">
                <small class="agency-muted">${selectedFile.lines} L · ${formatBytes(selectedFile.size)}</small>
                <button type="button" class="btn primary sm" disabled=${!selectedIde?.available} onClick=${() => openInIde(selectedFile.path)}>
                  <${Icon} name="code" size="xs" /><span>${t("agency.ideOpenFileBtn")}</span>
                </button>
              </div>
            </div>
            <pre class="agency-ide-code-pre mono">${selectedFile.content}</pre>
          `}
      </section>
    </div>`}

    ${subTab === "checks" && html`<section class="agency-project-section">
      <div class="agency-commercial-head">
        <h3>${t("agency.wsTabChecks")}</h3>
        <div class="agency-commercial-actions">
          ${["git_status", "npm_install", "npm_typecheck", "npm_test", "npm_build"].map((act) => html`<button
            key=${act}
            type="button"
            class=${"btn sm" + (act === "npm_test" || act === "npm_build" ? " primary" : "")}
            disabled=${!!busy}
            onClick=${() => runCheck(act)}
          >
            ${busy === `cmd-${act}` ? html`<${Spinner} />` : null}
            <span>${act.replace("_", " ")}</span>
          </button>`)}
        </div>
      </div>
      ${cmdResult && html`<div class="agency-ide-run-logs">
        <div class="agency-commercial-head">
          <strong class="mono">${cmdResult.action}</strong>
          <span class=${"agency-whatsapp-state " + (cmdResult.exitCode === 0 ? "passed" : "failed")}>exit ${cmdResult.exitCode}</span>
        </div>
        <pre class="agency-ide-log-pre mono">${cmdResult.output}</pre>
      </div>`}
    </section>`}
  </div>`;
}
