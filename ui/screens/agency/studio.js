import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { BotAvatar } from "../../components/avatar.js";
import { Markdown } from "../../components/markdown.js";
import { CopyButton, html, Icon, Spinner } from "../../components/ui.js";
import { api, sseParser } from "../../lib/api.js";
import { getLang, t } from "../../lib/i18n.js";
import { agentAvatarOf } from "./agent-avatars.js";
import { readFilePayload } from "./copilot.js";

const enc = encodeURIComponent;

const SUBAGENT_DEFAULT_ROLES = {
  architect: "architect",
  ui_ux: "ui_ux",
  frontend: "developer",
  backend: "developer",
  qa: "qa_technical",
};

const MAX_ATTACH = 8;

function deriveProjectTitle(text, files) {
  const cleaned = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*|^\s*[-*]\s*/, "").trim())
    .find(Boolean) || "";
  if (cleaned) {
    if (cleaned.length <= 60) return cleaned;
    const cut = cleaned.slice(0, 60);
    const space = cut.lastIndexOf(" ");
    return (space > 24 ? cut.slice(0, space) : cut).trim();
  }
  const firstFile = files?.[0]?.name || "";
  if (firstFile) {
    return firstFile.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 60) || t("agency.studioNewProjectTitle");
  }
  return t("agency.studioNewProjectTitle");
}

function buildFileTree(files, query) {
  const q = String(query || "").trim().toLowerCase();
  const filtered = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const item of filtered) {
    const parts = String(item.path || "").split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const fullPath = parts.slice(0, i + 1).join("/");
      if (!node.dirs.has(seg)) {
        node.dirs.set(seg, { name: seg, path: fullPath, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(seg);
    }
    node.files.push({ name: parts[parts.length - 1] || item.path, path: item.path });
  }
  const sortNode = (node) => {
    const dirs = Array.from(node.dirs.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(sortNode);
    const fls = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    return { ...node, dirs, files: fls };
  };
  return sortNode(root);
}

function extractSummaryTitle(text, fallback) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*|^\s*[-*]\s*|\*\*/g, "").trim())
    .find(Boolean) || "";
  if (!line) return fallback;
  return line.length > 56 ? `${line.slice(0, 55).trim()}…` : line;
}

function formatElapsed(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const min = Math.floor(s / 60);
  const rem = s % 60;
  return `${min}:${String(rem).padStart(2, "0")}`;
}

function describeLiveStep(st) {
  const tool = String(st?.tool || "");
  const target = String(st?.target || "").trim();
  const map = {
    read_file: ["file", "Lecture"],
    write_file: ["compose", "Écriture"],
    patch_file: ["code", "Modification"],
    delete_file: ["trash", "Suppression"],
    add_dependency: ["download", "Dépendances"],
    run_check: ["sliders", target || "Vérification"],
    list_files: ["search", "Exploration"],
    search_files: ["search", "Recherche"],
    finish: ["check", "Terminé"],
    no_action: ["spark", "Analyse"],
    auto_fix: ["shield", "Correction"],
  };
  const [icon, label] = map[tool] || ["spark", tool || "Action"];
  return { icon, label, target: tool === "run_check" ? "" : target };
}

export function ProjectStudio({
  orgId,
  project,
  projects = [],
  selectedProjectId = "__new__",
  onSelectProject,
  onProjectCreated,
  onChanged,
}) {
  const [files, setFiles] = useState([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [openTabs, setOpenTabs] = useState([]);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [collapsedDirs, setCollapsedDirs] = useState({});
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [snapshots, setSnapshots] = useState([]);
  const [changedFiles, setChangedFiles] = useState([]);

  // Conversational workbench state
  const [mode, setMode] = useState("build");
  const [targetSubagent, setTargetSubagent] = useState("");
  const [messages, setMessages] = useState([]);
  const [plan, setPlan] = useState(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [dragging, setDragging] = useState(false);

  // Live SSE streaming feedback
  const [activeSubagent, setActiveSubagent] = useState(null);
  const [liveSteps, setLiveSteps] = useState([]);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Right pane tabs & preview viewport
  const [workspaceTab, setWorkspaceTab] = useState("preview");
  const [viewport, setViewport] = useState("desktop"); // desktop | tablet | mobile
  const [previewNonce, setPreviewNonce] = useState(1);
  const [devServer, setDevServer] = useState(null);
  const [devServerBusy, setDevServerBusy] = useState(false);
  const [executionMode, setExecutionMode] = useState("container");

  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const threadRef = useRef(null);
  const composerRef = useRef(null);
  const gutterRef = useRef(null);
  const chatUploadRef = useRef(null);
  const treeUploadRef = useRef(null);
  const justCreatedIdRef = useRef("");

  const isDirty = !!selectedPath && content !== savedContent;
  const lineCount = useMemo(() => Math.max(1, String(content || "").split("\n").length), [content]);
  const fileTree = useMemo(() => buildFileTree(files, fileQuery), [files, fileQuery]);

  const resizeComposer = () => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  useEffect(() => {
    resizeComposer();
  }, [input]);

  const openFile = async (relPath, pid = project?.id, force = false) => {
    if (!relPath || !pid) return;
    if (!force && relPath !== selectedPath && isDirty && !window.confirm(t("agency.studioUnsavedSwitchConfirm"))) return;
    setSelectedPath(relPath);
    setOpenTabs((prev) => (prev.includes(relPath) ? prev : [...prev.slice(-7), relPath]));
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/file?path=${enc(relPath)}`);
      const text = res.content || "";
      setContent(text);
      setSavedContent(text);
    } catch (err) {
      setError(err.message);
    }
  };

  const closeTab = (relPath, e) => {
    e?.stopPropagation();
    if (selectedPath === relPath && isDirty && !window.confirm(t("agency.studioUnsavedSwitchConfirm"))) return;
    const nextTabs = openTabs.filter((p) => p !== relPath);
    setOpenTabs(nextTabs);
    if (selectedPath === relPath) {
      const fallback = nextTabs[nextTabs.length - 1] || "";
      if (fallback) void openFile(fallback, project?.id, true);
      else {
        setSelectedPath("");
        setContent("");
        setSavedContent("");
      }
    }
  };

  const loadSnapshots = async (pid = project?.id) => {
    if (!orgId || !pid) { setSnapshots([]); return; }
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/snapshots`);
      setSnapshots(res.items || []);
    } catch {
      setSnapshots([]);
    }
  };

  const loadFiles = async (preferPath = "", pid = project?.id) => {
    if (!orgId || !pid) {
      setFiles([]);
      setSelectedPath("");
      setOpenTabs([]);
      setContent("");
      setSavedContent("");
      setSnapshots([]);
      return;
    }
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/files`);
      const list = res.items || [];
      setFiles(list);
      const validPaths = new Set(list.map((f) => f.path));
      setOpenTabs((prev) => prev.filter((p) => validPaths.has(p)));
      const next = (preferPath && validPaths.has(preferPath)) ? preferPath : (validPaths.has(selectedPath) ? selectedPath : (list[0]?.path || ""));
      if (next) await openFile(next, pid, true);
      else { setSelectedPath(""); setContent(""); setSavedContent(""); }
      void loadSnapshots(pid);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadStudioState = async (pid = project?.id) => {
    if (!orgId || !pid) {
      setMessages([]);
      setPlan(null);
      return;
    }
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/state`);
      const history = Array.isArray(res.messages) ? res.messages : [];
      setMessages(history);
      setPlan(res.plan || null);
      const latestBuild = [...history].reverse().find((message) => message?.role === "assistant" && Array.isArray(message.modifiedFiles));
      setChangedFiles(latestBuild?.modifiedFiles || []);
    } catch {
      setMessages([]);
      setPlan(null);
    }
  };

  const loadDevServer = async (pid = project?.id) => {
    if (!orgId || !pid) {
      setDevServer(null);
      return null;
    }
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/devserver`);
      setDevServer(res || null);
      setExecutionMode(res?.executionMode || "container");
      return res || null;
    } catch {
      setDevServer(null);
      return null;
    }
  };

  const startDevServer = async (pid = project?.id, { restart = false, mode = executionMode } = {}) => {
    if (!orgId || !pid || devServerBusy) return null;
    if (!window.confirm(t("agency.studioPreviewLaunchConfirm"))) return null;
    if (mode === "host" && !window.confirm(t("agency.studioTrustedHostConfirm"))) return null;
    setDevServerBusy(true); setError(""); setNotice("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/devserver/start`, {
        method: "POST",
        body: { restart, executionMode: mode },
      });
      setDevServer(res || null);
      if (res?.error) setError(res.error);
      setPreviewNonce((n) => n + 1);
      setWorkspaceTab("preview");
      return res || null;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setDevServerBusy(false);
    }
  };

  const stopDevServer = async (pid = project?.id) => {
    if (!orgId || !pid || devServerBusy) return;
    setDevServerBusy(true); setError("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/devserver/stop`, { method: "POST" });
      setDevServer(res || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setDevServerBusy(false);
    }
  };

  useEffect(() => {
    const pid = project?.id || "";
    if (justCreatedIdRef.current && justCreatedIdRef.current === pid) {
      justCreatedIdRef.current = "";
      return;
    }
    setNotice("");
    setError("");
    setLiveSteps([]);
    setActiveSubagent(null);
    setFileQuery("");
    setCollapsedDirs({});
    setOpenTabs([]);
    if (!pid) {
      setFiles([]);
      setSelectedPath("");
      setContent("");
      setSavedContent("");
      setSnapshots([]);
      setMessages([]);
      setPlan(null);
      setChangedFiles([]);
      setDevServer(null);
      setExecutionMode("container");
      setWorkspaceTab("preview");
      return;
    }
    void loadFiles("", pid);
    void loadStudioState(pid);
    void loadDevServer(pid);
  }, [orgId, project?.id]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, liveSteps.length, busy]);

  useEffect(() => {
    if (busy !== "chat") {
      setElapsedSec(0);
      return;
    }
    setElapsedSec(0);
    const id = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [busy]);

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
    if (!orgId || busy) return;
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
      let activeProjectId = project?.id || "";
      let streamFiles = attached;

      if (!activeProjectId) {
        const created = await api(`/agency/${enc(orgId)}/projects/direct`, {
          method: "POST",
          body: {
            title: deriveProjectTitle(text, attached),
            template: "",
            technicalSpecs: text,
            cahierDesCharges: text,
            files: attached,
          },
        });
        activeProjectId = created.project.id;
        justCreatedIdRef.current = activeProjectId;
        streamFiles = [];
        onProjectCreated?.(created.project);
      }

      const response = await fetch(`/amb/api/agency/${enc(orgId)}/projects/${enc(activeProjectId)}/studio/chat-stream`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-amb-lang": getLang() },
        body: JSON.stringify({
          message: text,
          mode: runMode,
          executePlan,
          targetSubagent: focusSubagent,
          files: streamFiles,
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
      setChangedFiles(modified);
      await loadFiles(modified[0] || "", activeProjectId);
      const ds = await loadDevServer(activeProjectId);
      if (modified.length > 0 || runMode === "build") {
        setWorkspaceTab("preview");
        setPreviewNonce((n) => n + 1);
        if (modified.includes("package.json") && ds?.running) {
          setNotice(t("agency.studioPreviewRestartHint"));
        } else if (ds?.hasDevScript && !ds.running) {
          setNotice(t("agency.studioPreviewReadyHint"));
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
      setChangedFiles([]);
      setLiveSteps([]);
    } catch (err) {
      setError(err.message);
    }
  };

  const createFile = async (e) => {
    e.preventDefault();
    const rel = newFilePath.trim();
    if (!rel || !project?.id) return;
    setBusy("create"); setError(""); setNotice("");
    try {
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/file`, {
        method: "PUT",
        body: { path: rel, content: "" },
      });
      setNewFilePath("");
      setNewFileOpen(false);
      await loadFiles(rel);
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const saveFile = async () => {
    if (!selectedPath || !project?.id) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/file`, {
        method: "PUT",
        body: { path: selectedPath, content },
      });
      setSavedContent(content);
      setChangedFiles((prev) => [...new Set([...prev, selectedPath])]);
      setPreviewNonce((n) => n + 1);
      setNotice(`${selectedPath} ✓`);
      await loadFiles(selectedPath);
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const downloadCurrentFile = () => {
    if (!selectedPath) return;
    const blob = new Blob([content || ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = selectedPath.split("/").pop() || "file.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const deleteFile = async () => {
    if (!selectedPath || !project?.id) return;
    setBusy("del"); setError("");
    try {
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/file?path=${enc(selectedPath)}`, { method: "DELETE" });
      setChangedFiles((prev) => [...new Set([...prev, selectedPath])]);
      setPreviewNonce((n) => n + 1);
      await loadFiles();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const rollbackSnapshot = async (commitHash) => {
    if (!project?.id) return;
    setBusy("rollback"); setError(""); setNotice("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/rollback`, {
        method: "POST",
        body: commitHash ? { commitHash } : {},
      });
      setNotice(t("agency.studioRollbackDone", { commit: (res.restoredCommit || "").slice(0, 7) }));
      await loadFiles();
      setPreviewNonce((n) => n + 1);
      const ds = await loadDevServer(project.id);
      if (ds?.hasDevScript && ds.running) {
        await startDevServer(project.id, { restart: true });
      }
      onChanged?.();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const uploadStudioDocs = async (fileList) => {
    if (!fileList?.length) return;
    if (!project?.id) {
      await handleChatFiles(fileList);
      return;
    }
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
    if (relPath) void openFile(relPath);
  };

  const openPreview = () => {
    setPreviewNonce((n) => n + 1);
    setWorkspaceTab("preview");
  };

  const hasIndex = !!project?.id && (files.some((f) => f.path === "index.html" || f.path === "public/index.html") || !!devServer?.running);
  const previewPath = files.some((f) => f.path === "public/index.html") ? "public/index.html" : "index.html";
  const staticPreviewUrl = project?.id
    ? `/amb/api/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/preview/${previewPath}?v=${previewNonce}`
    : "";
  const previewUrl = devServer?.running && devServer.url ? devServer.url : staticPreviewUrl;
  const displayPreviewHost = devServer?.running && devServer.port ? `127.0.0.1:${devServer.port}` : `/${previewPath}`;

  const toggleDir = (dirPath) => {
    setCollapsedDirs((prev) => ({ ...prev, [dirPath]: !prev[dirPath] }));
  };

  const renderTreeNode = (node, depth = 0) => html`
    ${node.dirs.map((dir) => {
      const closed = !!collapsedDirs[dir.path];
      return html`<div key=${dir.path} class="agency-studio-tree-group">
        <button
          type="button"
          class="agency-studio-tree-dir"
          style=${{ paddingInlineStart: `calc(var(--space-2) + ${depth} * var(--space-3))` }}
          onClick=${() => toggleDir(dir.path)}
          title=${dir.path}
        >
          <${Icon} name=${closed ? "chevRight" : "chevDown"} size="xs" />
          <${Icon} name="folder" size="sm" />
          <span class="agency-truncate">${dir.name}</span>
        </button>
        ${!closed && renderTreeNode(dir, depth + 1)}
      </div>`;
    })}
    ${node.files.map((f) => html`<button
      key=${f.path}
      type="button"
      class=${"agency-studio-file" + (f.path === selectedPath ? " active" : "")}
      style=${{ paddingInlineStart: `calc(var(--space-5) + ${depth} * var(--space-3))` }}
      title=${f.path}
      onClick=${() => openFile(f.path)}
    >
      <${Icon} name="file" size="sm" />
      <span class="agency-truncate">${f.name}</span>
    </button>`)}
  `;

  const renderPlanCard = (pl, compact = false) => {
    if (!pl) return null;
    const canApprove = pl.status === "draft" && pl.tasks?.length > 0;
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
            <strong class="agency-truncate" title=${tk.title}>${tk.title}</strong>
            <small class="agency-truncate" title=${tk.targetFiles?.join(", ") || ""}>
              ${t(`agency.studioSubagentNames.${tk.subagent}`)}${tk.targetFiles?.length ? (compact ? ` · ${tk.targetFiles.length} ${t("agency.studioFilesTitle").toLowerCase()}` : ` · ${tk.targetFiles.join(", ")}`) : ""}
            </small>
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

  const selectProjectSafely = (nextId) => {
    if (isDirty && !window.confirm(t("agency.studioUnsavedSwitchConfirm"))) return;
    onSelectProject?.(nextId);
  };

  const canSend = !busy && (input.trim().length > 0 || attachments.length > 0);

  return html`<section class="agency-studio-workbench">
    <aside
      class=${"agency-studio-chat" + (dragging ? " dragging" : "")}
      onDragOver=${(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave=${() => setDragging(false)}
      onDrop=${(e) => { e.preventDefault(); setDragging(false); void handleChatFiles(e.dataTransfer?.files); }}
    >
      <div class="agency-studio-chat-top">
        <div class="agency-studio-project-pick">
          <select
            class="field agency-studio-project-select"
            aria-label=${t("agency.projectsTitle")}
            value=${selectedProjectId}
            onChange=${(e) => selectProjectSafely(e.currentTarget.value)}
          >
            <option value="__new__">${t("agency.studioNewChatOption")}</option>
            ${projects.map((p) => html`<option value=${p.id}>${p.title}</option>`)}
          </select>
        </div>
        <div class="agency-studio-chat-tools">
          <select
            class="field agency-studio-agent-select"
            aria-label=${t("agency.studioSubagentFilterLabel")}
            value=${targetSubagent}
            onChange=${(e) => setTargetSubagent(e.currentTarget.value)}
          >
            <option value="">${t("agency.studioSubagentAuto")}</option>
            <option value="architect">${t("agency.studioSubagentNames.architect")}</option>
            <option value="ui_ux">${t("agency.studioSubagentNames.ui_ux")}</option>
            <option value="frontend">${t("agency.studioSubagentNames.frontend")}</option>
            <option value="backend">${t("agency.studioSubagentNames.backend")}</option>
            <option value="qa">${t("agency.studioSubagentNames.qa")}</option>
          </select>
          <button
            class="icon-btn sm"
            type="button"
            title=${t("agency.newStudioProjectBtn")}
            aria-label=${t("agency.newStudioProjectBtn")}
            onClick=${() => selectProjectSafely("__new__")}
          >
            <${Icon} name="plus" size="sm" />
          </button>
          ${messages.length > 0 && project?.id && html`<button
            class="icon-btn sm"
            type="button"
            disabled=${!!busy}
            title=${t("agency.copilotClearBtn")}
            aria-label=${t("agency.copilotClearBtn")}
            onClick=${clearHistory}
          >
            <${Icon} name="trash" size="sm" />
          </button>`}
        </div>
      </div>

      ${error && html`<div class="agency-alert" role="alert">${error}</div>`}
      ${notice && html`<p class="agency-research-feedback" role="status">${notice}</p>`}

      <div class="agency-studio-thread" ref=${threadRef}>
        ${!messages.length && html`<div class="agency-studio-welcome">
          <span class="agency-quick-icon tone-purple"><${Icon} name="code" size="lg" /></span>
          <div>
            <h2>${project?.title || t("agency.studioNewProjectTitle")}</h2>
            <p>${t("agency.studioWelcomeDesc")}</p>
          </div>
          <div class="agency-studio-starters">
            <button type="button" class="agency-copilot-prompt" disabled=${!!busy} onClick=${() => sendStudioTurn({ mode: "plan", message: t("agency.studioStarterPlan") })}>
              <span class="agency-copilot-prompt-icon tone-blue"><${Icon} name="outline" size="sm" /></span>
              <strong>${t("agency.studioStarterPlan")}</strong>
            </button>
            <button type="button" class="agency-copilot-prompt" disabled=${!!busy} onClick=${() => sendStudioTurn({ mode: "build", message: t("agency.studioStarterBuild") })}>
              <span class="agency-copilot-prompt-icon tone-purple"><${Icon} name="spark" size="sm" /></span>
              <strong>${t("agency.studioStarterBuild")}</strong>
            </button>
            <button type="button" class="agency-copilot-prompt" disabled=${!!busy} onClick=${() => sendStudioTurn({ mode: "build", targetSubagent: "ui_ux", message: t("agency.studioStarterDesign") })}>
              <span class="agency-copilot-prompt-icon tone-teal"><${Icon} name="palette" size="sm" /></span>
              <strong>${t("agency.studioStarterDesign")}</strong>
            </button>
            <button type="button" class="agency-copilot-prompt" disabled=${!!busy} onClick=${() => sendStudioTurn({ mode: "build", targetSubagent: "qa", message: t("agency.studioStarterQa") })}>
              <span class="agency-copilot-prompt-icon tone-amber"><${Icon} name="shield" size="sm" /></span>
              <strong>${t("agency.studioStarterQa")}</strong>
            </button>
          </div>
          <small class="agency-muted">${t("agency.studioDropDocsHint")}</small>
        </div>`}

        ${messages.map((m) => {
          if (m.role === "user") {
            return html`<article key=${m.id} class="agency-studio-msg user">
              <p class="agency-copilot-user-text">${m.text}</p>
              ${m.files?.length > 0 && html`<div class="agency-copilot-attachments">
                ${m.files.map((fname) => html`<span class="agency-copilot-chip"><${Icon} name="doc" size="sm" /><span class="agency-truncate">${fname}</span></span>`)}
              </div>`}
            </article>`;
          }
          const modFiles = Array.isArray(m.modifiedFiles) ? m.modifiedFiles : [];
          const restoreRef = m.snapshotCommit || "";
          const canRestore = !!project?.id && (!!restoreRef || (modFiles.length > 0 && snapshots.length > 0));
          return html`<article key=${m.id} class="agency-studio-msg assistant">
            ${(modFiles.length > 0 || restoreRef) && html`<div class="agency-studio-checkpoint">
              <div class="agency-studio-checkpoint-head">
                <strong class="agency-truncate">${extractSummaryTitle(m.text, `${modFiles.length} ${t("agency.studioFilesTitle").toLowerCase()}`)}</strong>
                <div class="agency-studio-checkpoint-right">
                  ${modFiles.length > 0 && html`<span class="agency-studio-checkpoint-count">${modFiles.length}</span>`}
                  ${canRestore && html`<button
                    type="button"
                    class="agency-studio-checkpoint-restore"
                    disabled=${!!busy}
                    title=${restoreRef ? restoreRef.slice(0, 7) : t("agency.studioRollbackBtn")}
                    onClick=${() => rollbackSnapshot(restoreRef || undefined)}
                  >
                    <${Icon} name="reset" size="xs" /><span>${t("agency.studioRollbackBtn")}</span>
                  </button>`}
                </div>
              </div>
              <div class="agency-studio-checkpoint-actions">
                <button type="button" class="agency-studio-checkpoint-btn" onClick=${() => openFileInCode(modFiles[0] || "")}>
                  <${Icon} name="code" size="xs" /><span>${t("agency.studioTabCode")}</span>
                </button>
                <button
                  type="button"
                  class=${"agency-studio-checkpoint-btn" + (workspaceTab === "preview" ? " active" : "")}
                  onClick=${openPreview}
                >
                  <${Icon} name="globe" size="xs" /><span>${t("agency.studioTabPreview")}</span>
                </button>
              </div>
              ${modFiles.length > 0 && html`<div class="agency-copilot-attachments">
                ${modFiles.slice(0, 4).map((f) => html`<button type="button" class="agency-studio-file-pill" onClick=${() => openFileInCode(f)}>
                  <${Icon} name="file" size="xs" /><span class="agency-truncate">${f}</span>
                </button>`)}
                ${modFiles.length > 4 && html`<span class="agency-studio-checkpoint-count">+${modFiles.length - 4}</span>`}
              </div>`}
            </div>`}
            <div class="agency-studio-msg-body">
              <${Markdown} text=${m.text} />
            </div>
            ${m.plan && renderPlanCard(m.plan, true)}
            ${m.subagentRuns?.length > 0 && html`<details class="agency-studio-details">
              <summary>
                <span>${t("agency.studioSubagentRunsTitle")} (${m.subagentRuns.length})</span>
              </summary>
              <div class="agency-studio-details-list">
                ${m.subagentRuns.map((run) => html`<div class="agency-studio-run-row">
                  <${BotAvatar} char=${agentAvatarOf(SUBAGENT_DEFAULT_ROLES[run.subagent] || "developer")} size=${18} state="idle" />
                  <span class="agency-truncate" title=${run.title}>${t(`agency.studioSubagentNames.${run.subagent}`)} · ${run.title}</span>
                  <span class=${"agency-studio-step-status " + (run.ok ? "ok" : "err")}>
                    <${Icon} name=${run.ok ? "check" : "alert"} size="xs" />
                  </span>
                </div>`)}
              </div>
            </details>`}
            <div class="agency-studio-msg-foot">
              <${CopyButton} text=${m.text} />
              ${canRestore && !modFiles.length && html`<button
                type="button"
                class="agency-studio-checkpoint-restore"
                disabled=${!!busy}
                onClick=${() => rollbackSnapshot(restoreRef || undefined)}
              >
                <${Icon} name="reset" size="xs" /><span>${t("agency.studioRollbackBtn")}</span>
              </button>`}
            </div>
          </article>`;
        })}

        ${busy === "chat" && html`<div class="agency-studio-live-card" role="status" aria-live="polite">
          <div class="agency-studio-live-head">
            <${BotAvatar} char=${agentAvatarOf(SUBAGENT_DEFAULT_ROLES[activeSubagent?.subagent] || "developer")} size=${28} state="working" />
            <div class="agency-studio-live-title">
              <div class="agency-studio-live-sub">
                <span class="agency-studio-live-dot" aria-hidden="true"></span>
                <strong class="agency-truncate">
                  ${activeSubagent
                    ? (activeSubagent.displayName || t(`agency.studioSubagentNames.${activeSubagent.subagent}`))
                    : (mode === "plan" ? t("agency.studioPlanningStatus") : t("agency.studioBuildingStatus"))}
                </strong>
              </div>
              ${activeSubagent?.title && html`<small class="agency-truncate" title=${activeSubagent.title}>${activeSubagent.title}</small>`}
            </div>
            <span class="agency-studio-live-timer mono">${formatElapsed(elapsedSec)}</span>
          </div>
          ${liveSteps.length > 0 && html`<div class="agency-studio-live-timeline">
            ${liveSteps.slice(-6).map((st) => {
              const desc = describeLiveStep(st);
              return html`<div class="agency-studio-live-step">
                <span class="agency-studio-step-ic"><${Icon} name=${desc.icon} size="xs" /></span>
                <span class="agency-studio-step-label">${desc.label}</span>
                ${desc.target && html`<code class="agency-studio-step-target agency-truncate mono" title=${desc.target}>${desc.target}</code>`}
                <span class=${"agency-studio-step-status " + (st.ok ? "ok" : "err")}>
                  <${Icon} name=${st.ok ? "check" : "alert"} size="xs" />
                </span>
              </div>`;
            })}
          </div>`}
        </div>`}
      </div>

      <div class="agency-studio-dock">
        <form
          class=${"agency-studio-composer" + (dragging ? " drag" : "")}
          onSubmit=${(e) => { e.preventDefault(); void sendStudioTurn(); }}
        >
          <input
            ref=${chatUploadRef}
            class="agency-copilot-file-input"
            type="file"
            multiple
            accept=".txt,.md,.markdown,.csv,.json,.js,.mjs,.ts,.tsx,.jsx,.html,.css,.xml,.yaml,.yml,.sql,.pdf,.png,.jpg,.jpeg,.webp,.svg"
            onChange=${(e) => { void handleChatFiles(e.currentTarget.files); e.currentTarget.value = ""; }}
          />
          ${attachments.length > 0 && html`<div class="agency-copilot-attachments">
            ${attachments.map((att, idx) => html`<span class="agency-copilot-chip">
              <${Icon} name="doc" size="sm" />
              <span class="agency-truncate">${att.name}</span>
              <button class="agency-copilot-chip-rm" type="button" aria-label=${t("agency.close")} onClick=${() => setAttachments((p) => p.filter((_, i) => i !== idx))}><${Icon} name="close" size="xs" /></button>
            </span>`)}
          </div>`}
          <textarea
            ref=${composerRef}
            rows="1"
            value=${input}
            placeholder=${mode === "plan" ? t("agency.studioPlanPlaceholder") : t("agency.studioBuildPlaceholder")}
            onInput=${(e) => setInput(e.currentTarget.value)}
            onKeyDown=${(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                if (canSend) void sendStudioTurn();
              }
            }}
          ></textarea>
          <div class="agency-copilot-bar">
            <button
              class="agency-copilot-plus"
              type="button"
              disabled=${!!busy || attachments.length >= MAX_ATTACH}
              title=${t("agency.studioUploadDocsBtn")}
              aria-label=${t("agency.studioUploadDocsBtn")}
              onClick=${() => chatUploadRef.current?.click()}
            >
              <${Icon} name="plus" size="md" />
            </button>
            <span class="grow"></span>
            <div class="agency-studio-mode-switch" role="tablist" aria-label=${t("agency.studioModeLabel")}>
              <button type="button" role="tab" aria-selected=${mode === "plan"} class=${mode === "plan" ? "active" : ""} onClick=${() => setMode("plan")}>${t("agency.studioModePlan")}</button>
              <button type="button" role="tab" aria-selected=${mode === "build"} class=${mode === "build" ? "active" : ""} onClick=${() => setMode("build")}>${t("agency.studioModeBuild")}</button>
            </div>
            <button
              class="agency-copilot-send"
              type="submit"
              disabled=${!canSend}
              aria-busy=${busy === "chat" ? "true" : undefined}
              title=${mode === "plan" ? t("agency.studioDiscussBtn") : t("agency.studioBuildBtn")}
              aria-label=${mode === "plan" ? t("agency.studioDiscussBtn") : t("agency.studioBuildBtn")}
            >
              ${busy === "chat" ? html`<${Spinner} />` : html`<${Icon} name="up" size="sm" strong=${true} />`}
            </button>
          </div>
        </form>
      </div>
    </aside>

    <div class="agency-studio-workspace">
      <div class="agency-studio-ws-head">
        <div class="agency-studio-ws-tabs" role="tablist">
          <button type="button" role="tab" aria-selected=${workspaceTab === "preview"} class=${workspaceTab === "preview" ? "active" : ""} onClick=${() => setWorkspaceTab("preview")}>
            <${Icon} name="globe" size="sm" /><span>${t("agency.studioTabPreview")}</span>
          </button>
          <button type="button" role="tab" aria-selected=${workspaceTab === "code"} class=${workspaceTab === "code" ? "active" : ""} onClick=${() => setWorkspaceTab("code")}>
            <${Icon} name="code" size="sm" /><span>${t("agency.studioTabCode")}</span>
          </button>
          <button type="button" role="tab" aria-selected=${workspaceTab === "changes"} class=${workspaceTab === "changes" ? "active" : ""} onClick=${() => setWorkspaceTab("changes")}>
            <${Icon} name="file" size="sm" /><span>${t("agency.studioTabChanges")}</span>
            ${changedFiles.length > 0 && html`<span class="agency-count-pill">${changedFiles.length}</span>`}
          </button>
        </div>

        ${workspaceTab === "preview" && (hasIndex || devServer?.hasDevScript) && html`<div class="agency-studio-preview-bar">
          ${devServer?.hasDevScript && html`<select class="field agency-studio-execution-mode" aria-label=${t("agency.studioExecutionModeLabel")} value=${executionMode} disabled=${devServerBusy || !!devServer?.running} onChange=${(e) => setExecutionMode(e.currentTarget.value)}>
            <option value="container">${t("agency.studioExecutionModeContainer")}</option>
            <option value="host">${t("agency.studioExecutionModeHost")}</option>
          </select>`}
          ${devServer?.hasDevScript && html`<button
            type="button"
            class=${"btn sm" + (devServer.running ? "" : " primary")}
            disabled=${devServerBusy}
            onClick=${() => (devServer.running ? stopDevServer() : startDevServer())}
          >
            ${devServerBusy
              ? html`<${Spinner} />`
              : html`<${Icon} name=${devServer.running ? "stop" : "spark"} size="xs" />`}
            <span>${devServer.running ? t("common.off") : t("agency.startMissionBtn")}</span>
          </button>`}
          ${devServer?.hasDevScript && devServer.running && html`<button type="button" class="icon-btn sm" disabled=${devServerBusy} title=${t("agency.studioPreviewRestartBtn")} aria-label=${t("agency.studioPreviewRestartBtn")} onClick=${() => startDevServer(project?.id, { restart: true })}>
            <${Icon} name="refresh" size="sm" />
          </button>`}
          ${hasIndex && html`<div class="agency-studio-vp-group">
            <button type="button" class=${viewport === "desktop" ? "active" : ""} title="Desktop" onClick=${() => setViewport("desktop")}>
              <${Icon} name="monitor" size="sm" />
            </button>
            <button type="button" class=${viewport === "tablet" ? "active" : ""} title="Tablette" onClick=${() => setViewport("tablet")}>
              <${Icon} name="panel" size="sm" />
            </button>
            <button type="button" class=${viewport === "mobile" ? "active" : ""} title="Mobile" onClick=${() => setViewport("mobile")}>
              <${Icon} name="card" size="sm" />
            </button>
          </div>`}
          ${hasIndex && html`<div class="agency-studio-url-pill">
            <button type="button" class="icon-btn xs" title=${t("agency.studioPreviewRefresh")} aria-label=${t("agency.studioPreviewRefresh")} onClick=${() => setPreviewNonce((n) => n + 1)}>
              <${Icon} name="refresh" size="xs" />
            </button>
            <span class="agency-truncate">${displayPreviewHost}</span>
            <a class="icon-btn xs" href=${previewUrl} target="_blank" rel="noopener" title=${t("agency.studioOpenNewTab")} aria-label=${t("agency.studioOpenNewTab")}>
              <${Icon} name="ext" size="xs" />
            </a>
          </div>`}
        </div>`}

        ${workspaceTab === "code" && html`<div class="agency-studio-ws-right">
          ${selectedPath && html`<span class="agency-studio-active-path agency-truncate" title=${selectedPath}>${selectedPath}</span>`}
          ${isDirty && html`<button class="btn primary sm" type="button" disabled=${!!busy} onClick=${saveFile}>${t("agency.studioSaveFileBtn")}</button>`}
        </div>`}
      </div>

      ${workspaceTab === "preview" && html`<div class="agency-studio-preview-pane">
        ${devServerBusy && !devServer?.running
          ? html`<div class="agency-empty">
              <${Spinner} />
              <strong>${t("agency.loading")}</strong>
              <p>${t("agency.studioBuildingStatus")}</p>
            </div>`
          : hasIndex
            ? html`<iframe key=${`${previewUrl}#${previewNonce}`} class=${"agency-studio-frame " + viewport} title=${t("agency.studioPreviewTitle")} src=${previewUrl} sandbox=${devServer?.running ? "allow-scripts allow-same-origin allow-forms allow-modals allow-popups" : "allow-scripts allow-forms allow-modals allow-popups"} referrerpolicy="no-referrer"></iframe>`
            : html`<div class="agency-empty">
                <${Icon} name="code" size="lg" />
                <strong>${t("agency.studioNoPreviewTitle")}</strong>
                <p>${devServer?.error || t("agency.studioNoPreviewDesc")}</p>
                ${devServer?.logs?.length > 0 && html`<pre class="agency-studio-empty-logs mono">${devServer.logs.slice(-6).join("\n")}</pre>`}
                <div class="agency-commercial-actions">
                  ${devServer?.status === "error" && html`<button
                    class="btn primary"
                    type="button"
                    disabled=${!!busy}
                    onClick=${() => sendStudioTurn({
                      mode: "build",
                      targetSubagent: "qa",
                      message: `Corrige l'erreur au démarrage de l'aperçu :\n${devServer.error || ""}\n\nLogs :\n${(devServer.logs || []).slice(-15).join("\n")}`,
                      skipAttachments: true,
                    })}
                  >
                    <${Icon} name="shield" size="sm" /><span>${t("agency.qaAutofixBtn")}</span>
                  </button>`}
                  ${devServer?.hasDevScript && html`<button class=${"btn" + (devServer?.status === "error" ? "" : " primary")} type="button" disabled=${devServerBusy} onClick=${() => startDevServer(project?.id, { restart: true })}>
                    <${Icon} name="spark" size="sm" /><span>${t("agency.startMissionBtn")}</span>
                  </button>`}
                </div>
              </div>`}
        ${devServer?.status === "error" && hasIndex && html`<div class="agency-studio-preview-error">
          <span class="agency-truncate" title=${devServer.error || ""}>${devServer.error || t("common.error")}</span>
          <button
            class="btn primary sm"
            type="button"
            disabled=${!!busy}
            onClick=${() => sendStudioTurn({
              mode: "build",
              targetSubagent: "qa",
              message: `Corrige l'erreur au démarrage de l'aperçu :\n${devServer.error || ""}\n\nLogs :\n${(devServer.logs || []).slice(-15).join("\n")}`,
              skipAttachments: true,
            })}
          >
            <${Icon} name="shield" size="xs" /><span>${t("agency.qaAutofixBtn")}</span>
          </button>
        </div>`}
        ${busy === "chat" && html`<div class="agency-studio-preview-building">
          <${Spinner} />
          <span class="agency-truncate">${activeSubagent?.title || t("agency.studioBuildingStatus")}</span>
        </div>`}
      </div>`}

      ${workspaceTab === "changes" && html`<div class="agency-studio-changes-pane">
        <div class="agency-studio-changes-head">
          <div>
            <strong>${t("agency.studioChangesTitle")}</strong>
            <p>${t("agency.studioNoChanges")}</p>
          </div>
          <span class="agency-count-pill">${changedFiles.length}</span>
        </div>
        ${changedFiles.length > 0
          ? html`<div class="agency-studio-changes-list">
              ${changedFiles.map((filePath) => {
                const exists = files.some((f) => f.path === filePath);
                return html`<button type="button" class="agency-studio-change-row" disabled=${!exists} onClick=${() => openFileInCode(filePath)} title=${filePath}>
                  <${Icon} name=${exists ? "file" : "trash"} size="sm" />
                  <span class="agency-truncate">${filePath}</span>
                  <small>${exists ? t("agency.studioTabCode") : t("agency.studioFileRemoved")}</small>
                </button>`;
              })}
            </div>`
          : html`<div class="agency-empty"><${Icon} name="file" size="lg" /><strong>${t("agency.studioNoChanges")}</strong></div>`}
      </div>`}

      ${workspaceTab === "code" && html`<div class="agency-studio-code-shell">
        <div class="agency-studio-tree">
          <div class="agency-studio-tree-top">
            <label class="agency-studio-tree-search">
              <${Icon} name="search" size="xs" />
              <input
                type="search"
                value=${fileQuery}
                placeholder=${t("agency.studioFilesTitle")}
                onInput=${(e) => setFileQuery(e.currentTarget.value)}
              />
            </label>
            <button
              class="icon-btn sm"
              type="button"
              disabled=${!!busy || !project?.id}
              title=${t("agency.studioNewFileBtn")}
              aria-label=${t("agency.studioNewFileBtn")}
              onClick=${() => setNewFileOpen((v) => !v)}
            >
              <${Icon} name=${newFileOpen ? "close" : "plus"} size="sm" />
            </button>
            <input ref=${treeUploadRef} class="agency-copilot-file-input" type="file" multiple onChange=${(e) => { void uploadStudioDocs(e.currentTarget.files); e.currentTarget.value = ""; }} />
            <button
              class="icon-btn sm"
              type="button"
              disabled=${!!busy}
              title=${t("agency.studioUploadDocsBtn")}
              aria-label=${t("agency.studioUploadDocsBtn")}
              onClick=${() => treeUploadRef.current?.click()}
            >
              <${Icon} name="doc" size="sm" />
            </button>
          </div>
          ${newFileOpen && html`<form class="agency-studio-new-file" onSubmit=${createFile}>
            <input class="field" value=${newFilePath} placeholder=${t("agency.studioNewFilePlaceholder")} onInput=${(e) => setNewFilePath(e.currentTarget.value)} />
            <button class="btn primary sm" type="submit" disabled=${!!busy || !project?.id || !newFilePath.trim()}>${t("agency.studioNewFileBtn")}</button>
          </form>`}
          <div class="agency-studio-file-list">
            ${files.length === 0
              ? html`<p class="agency-muted agency-studio-tree-empty">${t("agency.studioNoFileSelected")}</p>`
              : renderTreeNode(fileTree, 0)}
          </div>
        </div>

        <div class="agency-studio-editor">
          <div class="agency-studio-editor-tabs">
            <div class="agency-studio-tab-strip">
              ${openTabs.length === 0 && html`<span class="agency-studio-tab-empty">${t("agency.studioNoFileSelected")}</span>`}
              ${openTabs.map((tabPath) => html`<button
                key=${tabPath}
                type="button"
                class=${"agency-studio-editor-tab" + (tabPath === selectedPath ? " active" : "")}
                title=${tabPath}
                onClick=${() => openFile(tabPath)}
              >
                <span class="agency-truncate">${tabPath}</span>
                ${tabPath === selectedPath && isDirty && html`<span class="agency-studio-dirty-dot" aria-hidden="true"></span>`}
                <span class="agency-studio-tab-close" role="button" tabindex="-1" aria-label=${t("agency.close")} onClick=${(e) => closeTab(tabPath, e)}>
                  <${Icon} name="close" size="xs" />
                </span>
              </button>`)}
            </div>
            <div class="agency-studio-editor-actions">
              ${selectedPath && html`<${CopyButton} text=${content} />`}
              ${selectedPath && html`<button class="icon-btn sm" type="button" title=${t("agency.downloadDocument")} aria-label=${t("agency.downloadDocument")} onClick=${downloadCurrentFile}>
                <${Icon} name="download" size="sm" />
              </button>`}
              ${selectedPath && html`<button class="btn primary sm" type="button" disabled=${!!busy || !isDirty} onClick=${saveFile}>${t("agency.studioSaveFileBtn")}</button>`}
              ${selectedPath && html`<button class="icon-btn sm" type="button" disabled=${!!busy} title=${t("agency.studioDeleteFileBtn")} aria-label=${t("agency.studioDeleteFileBtn")} onClick=${deleteFile}>
                <${Icon} name="trash" size="sm" />
              </button>`}
            </div>
          </div>

          <div class="agency-studio-code-body">
            <div class="agency-studio-gutter mono" ref=${gutterRef} aria-hidden="true">
              ${Array.from({ length: lineCount }, (_, i) => html`<span key=${i}>${i + 1}</span>`)}
            </div>
            <textarea
              class="mono agency-studio-code-input"
              spellcheck="false"
              wrap="off"
              value=${content}
              disabled=${!selectedPath}
              onScroll=${(e) => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop; }}
              onInput=${(e) => setContent(e.currentTarget.value)}
              onKeyDown=${(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void saveFile();
                } else if (e.key === "Tab") {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const s = el.selectionStart;
                  const end = el.selectionEnd;
                  const next = `${content.slice(0, s)}  ${content.slice(end)}`;
                  setContent(next);
                  requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
                }
              }}
            ></textarea>
          </div>
        </div>
      </div>`}
    </div>
  </section>`;
}
