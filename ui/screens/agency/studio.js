import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { BotAvatar } from "../../components/avatar.js";
import { Markdown } from "../../components/markdown.js";
import { CopyButton, html, Icon, Select, Spinner } from "../../components/ui.js";
import { api, sseParser } from "../../lib/api.js";
import { getLang, t } from "../../lib/i18n.js";
import { confirmSheet } from "../../lib/store.js";
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

function formatDurationMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  return formatElapsed(ms / 1000);
}

function describeLiveStep(st) {
  const tool = String(st?.tool || "");
  const target = String(st?.target || "").trim();
  const map = {
    read_file: ["file", t("agency.studioStepTools.read_file")],
    write_file: ["compose", t("agency.studioStepTools.write_file")],
    patch_file: ["code", t("agency.studioStepTools.patch_file")],
    delete_file: ["trash", t("agency.studioStepTools.delete_file")],
    add_dependency: ["download", t("agency.studioStepTools.add_dependency")],
    run_check: ["sliders", target || t("agency.studioStepTools.run_check")],
    list_files: ["search", t("agency.studioStepTools.list_files")],
    search_files: ["search", t("agency.studioStepTools.search_files")],
    glob_files: ["search", t("agency.studioStepTools.glob_files")],
    grep_files: ["search", t("agency.studioStepTools.grep_files")],
    diagnostics: ["shield", t("agency.studioStepTools.diagnostics")],
    run_command: ["sliders", t("agency.studioStepTools.run_command")],
    finish: ["check", t("agency.studioStepTools.finish")],
    no_action: ["spark", t("agency.studioStepTools.no_action")],
    auto_fix: ["shield", t("agency.studioStepTools.auto_fix")],
  };
  const [icon, label] = map[tool] || ["spark", tool || "Action"];
  return { icon, label, target: tool === "run_check" || tool === "diagnostics" ? "" : target };
}

function isNavigableFileStep(tool, target) {
  return !!target && ["read_file", "write_file", "patch_file"].includes(String(tool || ""));
}

function StudioTurnActivity({ message, onOpenFile }) {
  const [open, setOpen] = useState(false);
  const [expandedStep, setExpandedStep] = useState(-1);
  const steps = Array.isArray(message?.steps) ? message.steps : [];
  const runs = Array.isArray(message?.subagentRuns) ? message.subagentRuns : [];
  const count = steps.length || runs.length;
  if (!count) return null;

  const hasError = steps.some((s) => s.ok === false) || runs.some((r) => r.ok === false && !r.cancelled);
  const dotTone = message?.cancelled ? "warn" : hasError ? "err" : "ok";
  const totalMs = typeof message?.durationMs === "number"
    ? message.durationMs
    : steps.reduce((acc, s) => acc + (typeof s.durationMs === "number" ? s.durationMs : 0), 0);
  const durationStr = totalMs > 0 ? formatDurationMs(totalMs) : "—";

  return html`<div class=${"agency-studio-activity" + (open ? " open" : "")}>
    <button
      type="button"
      class="agency-studio-activity-head"
      aria-expanded=${open}
      onClick=${() => setOpen((v) => !v)}
    >
      <span class=${"agency-studio-act-dot " + dotTone} aria-hidden="true"></span>
      <span class="agency-studio-activity-label agency-truncate">
        ${t("agency.studioActivitySummary", { steps: count, duration: durationStr })}
      </span>
      <span class="grow"></span>
      <${Icon} name="chevRight" size="xs" class="chev" />
    </button>
    ${open && html`<div class="agency-studio-activity-body">
      ${runs.length > 0 && html`<div class="agency-studio-activity-runs">
        ${runs.map((run, idx) => html`<div key=${run.taskId || idx} class="agency-studio-run-row">
          <${BotAvatar} char=${agentAvatarOf(SUBAGENT_DEFAULT_ROLES[run.subagent] || "developer")} size=${18} state="idle" />
          <span class="agency-truncate" title=${run.title}>${t(`agency.studioSubagentNames.${run.subagent}`)} · ${run.title}</span>
          <span class=${"agency-studio-step-status " + (run.ok ? "ok" : "err")}>
            <${Icon} name=${run.ok ? "check" : "alert"} size="xs" />
          </span>
        </div>`)}
      </div>`}
      ${steps.length > 0 && html`<div class="agency-studio-activity-steps">
        ${steps.map((st, idx) => {
          const desc = describeLiveStep(st);
          const navigable = isNavigableFileStep(st.tool, st.target);
          const hasDetail = !!st.summary;
          const isOpen = expandedStep === idx;
          return html`<div key=${`${st.taskId || "t"}-${st.step}-${idx}`} class="agency-studio-step-wrap">
            <div class="agency-studio-live-step">
              <span class="agency-studio-step-ic"><${Icon} name=${desc.icon} size="xs" /></span>
              <span class="agency-studio-step-label">${desc.label}</span>
              ${desc.target && (navigable
                ? html`<button type="button" class="agency-studio-step-link mono agency-truncate" title=${desc.target} onClick=${() => onOpenFile?.(desc.target)}>${desc.target}</button>`
                : html`<code class="agency-studio-step-target agency-truncate mono" title=${desc.target}>${desc.target}</code>`)}
              <span class="grow"></span>
              ${typeof st.durationMs === "number" && html`<span class="agency-studio-step-dur mono">${formatDurationMs(st.durationMs)}</span>`}
              <span class=${"agency-studio-step-status " + (st.ok ? "ok" : "err")}>
                <${Icon} name=${st.ok ? "check" : "alert"} size="xs" />
              </span>
              ${hasDetail && html`<button
                type="button"
                class="icon-btn xs"
                aria-expanded=${isOpen}
                title=${st.summary}
                onClick=${() => setExpandedStep(isOpen ? -1 : idx)}
              >
                <${Icon} name="chevRight" size="xs" class="chev" />
              </button>`}
            </div>
            ${isOpen && hasDetail && html`<pre class="agency-studio-step-detail mono">${st.summary}</pre>`}
          </div>`;
        })}
      </div>`}
    </div>`}
  </div>`;
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
  const [diffFiles, setDiffFiles] = useState([]);
  const [selectedChangePath, setSelectedChangePath] = useState("");
  const [selectedChangeDiff, setSelectedChangeDiff] = useState(null);
  const [changeSnapshot, setChangeSnapshot] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [diffListTruncated, setDiffListTruncated] = useState(false);

  // Conversational workbench state
  const [mode, setMode] = useState("build");
  const [targetSubagent, setTargetSubagent] = useState("");
  const [messages, setMessages] = useState([]);
  const [plan, setPlan] = useState(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [mentionedFiles, setMentionedFiles] = useState([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [popoverIndex, setPopoverIndex] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Live SSE streaming feedback & explicit run states
  const [activeRunMode, setActiveRunMode] = useState("build");
  const [activeSubagent, setActiveSubagent] = useState(null);
  const [liveFocus, setLiveFocus] = useState(null);
  const [liveSteps, setLiveSteps] = useState([]);
  const [liveActivityOpen, setLiveActivityOpen] = useState(true);
  const [expandedLiveStep, setExpandedLiveStep] = useState(-1);
  const [stepsDockOpen, setStepsDockOpen] = useState(true);
  const [studioSubagents, setStudioSubagents] = useState([]);
  const [subagentStates, setSubagentStates] = useState({});
  const [elapsedSec, setElapsedSec] = useState(0);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [hasUnreadLive, setHasUnreadLive] = useState(false);

  // Right pane tabs & preview viewport
  const [workspaceTab, setWorkspaceTab] = useState("preview");
  const [viewport, setViewport] = useState("desktop"); // desktop | tablet | mobile
  const [previewNonce, setPreviewNonce] = useState(1);
  const [previewRoute, setPreviewRoute] = useState("/");
  const [previewRouteInput, setPreviewRouteInput] = useState("/");
  const [previewEvents, setPreviewEvents] = useState([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [liveDelta, setLiveDelta] = useState("");
  const [devServer, setDevServer] = useState(null);
  const [devServerBusy, setDevServerBusy] = useState(false);
  const [executionMode, setExecutionMode] = useState("host");

  const [busy, setBusy] = useState("");
  const [cancelRequested, setCancelRequested] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const threadRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const lastAttemptRef = useRef(null);
  const composerRef = useRef(null);
  const gutterRef = useRef(null);
  const chatUploadRef = useRef(null);
  const treeUploadRef = useRef(null);
  const justCreatedIdRef = useRef("");
  const activeStudioProjectIdRef = useRef("");

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

  useEffect(() => {
    const onBridgeMessage = (ev) => {
      const data = ev?.data;
      if (!data || data.source !== "amb-studio-preview") return;
      if (data.type === "route_change" && data.payload?.path) {
        setPreviewRouteInput(String(data.payload.path));
        return;
      }
      if (["runtime_error", "unhandled_rejection", "console_error", "resource_error", "fetch_error", "blank_screen"].includes(data.type)) {
        const msg = data.payload?.message || data.payload?.url || (data.payload?.status ? `HTTP ${data.payload.status}` : data.type);
        setPreviewEvents((prev) => [
          ...prev.slice(-39),
          {
            type: data.type,
            message: String(msg).slice(0, 600),
            url: String(data.url || ""),
            ts: Number(data.ts || Date.now()),
          },
        ]);
      }
    };
    window.addEventListener("message", onBridgeMessage);
    return () => window.removeEventListener("message", onBridgeMessage);
  }, []);

  const openFile = async (relPath, pid = project?.id, force = false) => {
    if (!relPath || !pid) return;
    if (!force && relPath !== selectedPath && isDirty && !(await confirmSheet({ title: t("agency.studioUnsavedSwitchConfirm"), danger: true }))) return;
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

  const closeTab = async (relPath, e) => {
    e?.stopPropagation();
    if (selectedPath === relPath && isDirty && !(await confirmSheet({ title: t("agency.studioUnsavedSwitchConfirm"), danger: true }))) return;
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

  const createStudioCheckpoint = async (pid, label, details = {}) => {
    return api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/snapshots`, {
      method: "POST",
      body: { label, ...details },
    });
  };

  const recordManualStudioChange = async (pid, before, label, filePath) => {
    const after = await createStudioCheckpoint(pid, label, { baseCommit: before.commitHash, path: filePath });
    if (after.message) setMessages((prev) => [...prev, after.message]);
    await loadStudioChanges({
      snapshotBeforeCommit: before.commitHash,
      snapshotCommit: after.commitHash,
      modifiedFiles: [filePath],
    }, pid);
    void loadSnapshots(pid);
    return after;
  };

  const loadStudioFileDiff = async (filePath, snapshot = changeSnapshot, pid = project?.id, { quiet = false } = {}) => {
    if (!filePath || !snapshot?.base || !snapshot?.head || !pid || !orgId) {
      setSelectedChangeDiff(null);
      return null;
    }
    setSelectedChangePath(filePath);
    if (!quiet) setDiffLoading(true);
    setDiffError("");
    try {
      const query = `base=${enc(snapshot.base)}&head=${enc(snapshot.head)}&path=${enc(filePath)}`;
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/diff?${query}`);
      setSelectedChangeDiff(res.diff || null);
      return res.diff || null;
    } catch (err) {
      setSelectedChangeDiff(null);
      setDiffError(err.message || t("agency.studioDiffUnavailable"));
      return null;
    } finally {
      if (!quiet) setDiffLoading(false);
    }
  };

  const loadStudioChanges = async (message, pid = project?.id) => {
    const fallback = Array.isArray(message?.modifiedFiles) ? [...new Set(message.modifiedFiles)] : [];
    const base = message?.snapshotBeforeCommit || "";
    const head = message?.snapshotCommit || "";
    setDiffFiles([]);
    setDiffListTruncated(false);
    setSelectedChangeDiff(null);
    setDiffError("");
    if (!base || !head || !orgId || !pid) {
      setChangeSnapshot(null);
      setChangedFiles(fallback);
      setSelectedChangePath(fallback[0] || "");
      if (fallback.length) setDiffError(t("agency.studioDiffUnavailable"));
      return;
    }

    const snapshot = { base, head };
    setChangeSnapshot(snapshot);
    setDiffLoading(true);
    try {
      const query = `base=${enc(base)}&head=${enc(head)}`;
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/diff?${query}`);
      const entries = Array.isArray(res.files) ? res.files : [];
      setDiffFiles(entries);
      setDiffListTruncated(res.truncated === true);
      const paths = entries.map((entry) => entry.path);
      setChangedFiles(paths.length ? paths : fallback);
      const firstPath = paths[0] || fallback[0] || "";
      setSelectedChangePath(firstPath);
      if (firstPath && entries.some((entry) => entry.path === firstPath)) {
        await loadStudioFileDiff(firstPath, snapshot, pid, { quiet: true });
      } else if (firstPath) {
        setDiffError(t("agency.studioDiffUnavailable"));
      }
    } catch (err) {
      setDiffError(err.message || t("agency.studioDiffUnavailable"));
      setChangedFiles(fallback);
      setSelectedChangePath(fallback[0] || "");
    } finally {
      setDiffLoading(false);
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
      setStudioSubagents([]);
      setSubagentStates({});
      return;
    }
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/state`);
      const history = Array.isArray(res.messages) ? res.messages : [];
      setMessages(history);
      setPlan(res.plan || null);
      setStudioSubagents(Array.isArray(res.subagents) ? res.subagents : []);
      const nextStates = {};
      for (const tk of res.plan?.tasks || []) {
        if (tk.status === "running") nextStates[tk.subagent] = "working";
        else if (tk.status === "failed") nextStates[tk.subagent] = "failed";
        else if (tk.status === "done" && nextStates[tk.subagent] !== "working" && nextStates[tk.subagent] !== "failed") {
          nextStates[tk.subagent] = "done";
        }
      }
      setSubagentStates(nextStates);
      if (res.plan?.status === "running" || res.plan?.status === "draft") {
        setStepsDockOpen(true);
      }
      const latestBuild = [...history].reverse().find((message) =>
        message?.role === "assistant" && message?.mode === "build" && Array.isArray(message.modifiedFiles),
      );
      await loadStudioChanges(latestBuild, pid);
    } catch {
      setMessages([]);
      setPlan(null);
      setStudioSubagents([]);
      setSubagentStates({});
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
      setExecutionMode(res?.executionMode || res?.recommendedMode || "host");
      return res || null;
    } catch {
      setDevServer(null);
      return null;
    }
  };

  const startDevServer = async (pid = project?.id, { restart = false, mode = executionMode } = {}) => {
    if (!orgId || !pid || devServerBusy) return null;
    const trustKey = `amb.studio.trustedHost.${pid}`;
    let alreadyTrusted = false;
    try {
      alreadyTrusted = window.localStorage.getItem(trustKey) === "1";
    } catch {}
    if (!alreadyTrusted) {
      if (!(await confirmSheet({ title: t("agency.studioPreviewLaunchConfirm") }))) return null;
      if (mode === "host" && !(await confirmSheet({ title: t("agency.studioTrustedHostConfirm"), danger: true }))) return null;
      try {
        window.localStorage.setItem(trustKey, "1");
      } catch {}
    }
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
    setLiveFocus(null);
    setLiveDelta("");
    setPreviewEvents([]);
    setPreviewRoute("/");
    setPreviewRouteInput("/");
    setActiveSubagent(null);
    setExpandedLiveStep(-1);
    setMentionedFiles([]);
    setMentionOpen(false);
    setPopoverIndex(0);
    setSubagentStates({});
    setShowScrollDown(false);
    setHasUnreadLive(false);
    stickToBottomRef.current = true;
    lastAttemptRef.current = null;
    setFileQuery("");
    setCollapsedDirs({});
    setOpenTabs([]);
    setChangedFiles([]);
    setDiffFiles([]);
    setSelectedChangePath("");
    setSelectedChangeDiff(null);
    setChangeSnapshot(null);
    setDiffLoading(false);
    setDiffError("");
    setDiffListTruncated(false);
    if (!pid) {
      setFiles([]);
      setSelectedPath("");
      setContent("");
      setSavedContent("");
      setSnapshots([]);
      setMessages([]);
      setPlan(null);
      setStudioSubagents([]);
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

  const scrollToBottom = (smooth = true) => {
    const el = threadRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setShowScrollDown(false);
    setHasUnreadLive(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  const handleThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = dist < 48;
    stickToBottomRef.current = atBottom;
    setShowScrollDown(!atBottom);
    if (atBottom) setHasUnreadLive(false);
  };

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowScrollDown(false);
      setHasUnreadLive(false);
    } else if (busy === "chat") {
      setHasUnreadLive(true);
    }
  }, [messages.length, liveSteps.length, busy, liveFocus?.text]);

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

  const cancelStudioTurn = async () => {
    const pid = activeStudioProjectIdRef.current || project?.id || "";
    if (!orgId || !pid || busy !== "chat" || !canCancel || cancelRequested) return;
    setCancelRequested(true);
    setError("");
    try {
      const res = await api(`/agency/${enc(orgId)}/projects/${enc(pid)}/studio/cancel`, { method: "POST" });
      if (!res?.cancelled) {
        setCancelRequested(false);
        setNotice(t("agency.studioCancelUnavailable"));
      }
    } catch (err) {
      setCancelRequested(false);
      setError(err.message || t("agency.studioCancelUnavailable"));
    }
  };

  const sendStudioTurn = async (opts = {}) => {
    if (!orgId || busy) return;
    const rawText = (opts.message ?? input).trim();
    const runMode = opts.mode ?? mode;
    const executePlan = opts.executePlan === true;
    const focusSubagent = opts.targetSubagent ?? (targetSubagent || undefined);
    const attached = opts.skipAttachments ? [] : [...attachments];
    const contextFiles = opts.mentionedFiles ?? (opts.message == null ? [...mentionedFiles] : []);

    if (!rawText && !executePlan && attached.length === 0 && contextFiles.length === 0) return;

    const contextPrefix = contextFiles.length > 0 ? contextFiles.map((f) => `@${f}`).join(" ") : "";
    const text = rawText
      ? (contextPrefix ? `${contextPrefix}\n${rawText}` : rawText)
      : contextPrefix;

    lastAttemptRef.current = {
      message: rawText,
      mode: runMode,
      executePlan,
      targetSubagent: focusSubagent,
      mentionedFiles: contextFiles,
      skipAttachments: true,
    };

    setBusy("chat");
    setActiveRunMode(runMode);
    setCancelRequested(false);
    setCanCancel(false);
    setMentionOpen(false);
    setPopoverIndex(0);
    stickToBottomRef.current = true;
    setHasUnreadLive(false);
    activeStudioProjectIdRef.current = project?.id || "";
    setError("");
    setNotice("");
    setLiveSteps([]);
    setExpandedLiveStep(-1);
    setLiveActivityOpen(true);
    setLiveFocus(null);
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
    if (opts.message == null) {
      setInput("");
      setMentionedFiles([]);
    }
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

      activeStudioProjectIdRef.current = activeProjectId;
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
        if (eventName === "ready") {
          setCanCancel(true);
        } else if (eventName === "focus" && data) {
          setLiveFocus(data);
        } else if (eventName === "plan" && data?.plan) {
          setPlan(data.plan);
          if (data.plan.status === "running" || data.plan.status === "draft") {
            setStepsDockOpen(true);
          }
        } else if (eventName === "subagent_start" && data) {
          setActiveSubagent(data);
          if (data.subagent) {
            setSubagentStates((prev) => ({ ...prev, [data.subagent]: "working" }));
          }
        } else if (eventName === "delta" && data?.delta) {
          setLiveDelta((prev) => (prev + String(data.delta)).slice(-420));
        } else if (eventName === "step_start" && data) {
          const stepKey = `${data.taskId || "t"}-${data.step}-${data.tool}`;
          setLiveSteps((prev) => [...prev.slice(-40), { ...data, id: stepKey, status: "running" }]);
        } else if (eventName === "step" && data) {
          const nextStatus = data.ok ? "done" : "error";
          setLiveSteps((prev) => {
            const idx = prev.findLastIndex(
              (s) => s.status === "running" && s.tool === data.tool && (!data.taskId || s.taskId === data.taskId) && s.step === data.step,
            );
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = { ...copy[idx], ...data, status: nextStatus };
              return copy;
            }
            return [...prev.slice(-40), { ...data, status: nextStatus }];
          });
        } else if (eventName === "subagent_done" && data) {
          setActiveSubagent(null);
          setLiveDelta("");
          if (data.subagent) {
            setSubagentStates((prev) => ({
              ...prev,
              [data.subagent]: data.ok ? "done" : (data.cancelled ? "idle" : "failed"),
            }));
          }
        } else if (eventName === "message" && data?.message) {
          setMessages((prev) => [...prev, data.message]);
        } else if (eventName === "done") {
          finalPayload = data;
          setCanCancel(false);
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
      if (runMode === "build") {
        const history = Array.isArray(finalPayload?.state?.messages) ? finalPayload.state.messages : [];
        const latestBuild = [...history].reverse().find((message) =>
          message?.role === "assistant" && message?.mode === "build" && Array.isArray(message.modifiedFiles),
        );
        await loadStudioChanges(latestBuild, activeProjectId);
      }
      await loadFiles(modified[0] || "", activeProjectId);
      const ds = await loadDevServer(activeProjectId);
      if (modified.length > 0 || runMode === "build") {
        setWorkspaceTab("preview");
        setPreviewNonce((n) => n + 1);
      }
      if (finalPayload?.cancelled) {
        setNotice(t("agency.studioCancelledStatus"));
      } else if (modified.includes("package.json") && ds?.running) {
        setNotice(t("agency.studioPreviewRestartHint"));
      } else if (ds?.hasDevScript && !ds.running) {
        setNotice(t("agency.studioPreviewReadyHint"));
      }
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
      setCancelRequested(false);
      setCanCancel(false);
      activeStudioProjectIdRef.current = "";
      setActiveSubagent(null);
      setLiveFocus(null);
      setLiveDelta("");
    }
  };

  const clearHistory = async () => {
    if (!orgId || !project?.id || busy) return;
    if (!(await confirmSheet({ title: t("agency.studioClearConfirm"), danger: true }))) return;
    try {
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/history`, { method: "DELETE" });
      setMessages([]);
      setPlan(null);
      setChangedFiles([]);
      setDiffFiles([]);
      setSelectedChangePath("");
      setSelectedChangeDiff(null);
      setChangeSnapshot(null);
      setDiffError("");
      setDiffListTruncated(false);
      setLiveSteps([]);
      setLiveFocus(null);
      setSubagentStates({});
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
      const before = await createStudioCheckpoint(project.id, `avant création manuelle: ${rel}`);
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/file`, {
        method: "PUT",
        body: { path: rel, content: "" },
      });
      await recordManualStudioChange(project.id, before, `création manuelle: ${rel}`, rel);
      setNewFilePath("");
      setNewFileOpen(false);
      await loadFiles(rel);
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  };

  const saveFile = async () => {
    if (!selectedPath || !project?.id) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      const before = await createStudioCheckpoint(project.id, `avant édition manuelle: ${selectedPath}`);
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/file`, {
        method: "PUT",
        body: { path: selectedPath, content },
      });
      await recordManualStudioChange(project.id, before, `édition manuelle: ${selectedPath}`, selectedPath);
      setSavedContent(content);
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
      const before = await createStudioCheckpoint(project.id, `avant suppression manuelle: ${selectedPath}`);
      await api(`/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/file?path=${enc(selectedPath)}`, { method: "DELETE" });
      await recordManualStudioChange(project.id, before, `suppression manuelle: ${selectedPath}`, selectedPath);
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

  const hasIndex = !!project?.id && (files.some((f) => f.path === "index.html" || f.path === "public/index.html" || f.path === "dist/index.html") || !!devServer?.running);
  const previewPath = files.some((f) => f.path === "dist/index.html")
    ? "index.html"
    : (files.some((f) => f.path === "public/index.html") ? "public/index.html" : "index.html");
  const normalizedPreviewRoute = (previewRoute || "/").startsWith("/") ? (previewRoute || "/") : `/${previewRoute}`;
  const staticPreviewUrl = project?.id
    ? `/amb/api/agency/${enc(orgId)}/projects/${enc(project.id)}/studio/preview/${previewPath}?v=${previewNonce}`
    : "";
  const previewUrl = devServer?.running && devServer.url
    ? `${String(devServer.url).replace(/\/$/, "")}${normalizedPreviewRoute}`
    : staticPreviewUrl;
  const displayPreviewHost = devServer?.running && devServer.port
    ? `127.0.0.1:${devServer.port}`
    : `/${previewPath}`;
  const consoleErrorCount = previewEvents.length + (devServer?.status === "error" ? 1 : 0);

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

  const selectProjectSafely = async (nextId) => {
    if (isDirty && !(await confirmSheet({ title: t("agency.studioUnsavedSwitchConfirm"), danger: true }))) return;
    onSelectProject?.(nextId);
  };

  const runState = busy === "chat"
    ? (cancelRequested ? "cancelling" : activeRunMode === "plan" ? "planning" : "running")
    : error
      ? "error"
      : (plan?.status === "draft" && (plan.tasks?.length || 0) > 0)
        ? "awaiting_approval"
        : "idle";

  const slashMatch = !mentionOpen ? input.match(/^\/([a-z]*)$/i) : null;
  const slashCommands = useMemo(() => {
    const all = [
      { id: "plan", cmd: "/plan", icon: "outline", label: t("agency.studioSlashPlan"), run: () => setMode("plan") },
      { id: "build", cmd: "/build", icon: "spark", label: t("agency.studioSlashBuild"), run: () => setMode("build") },
      { id: "design", cmd: "/design", icon: "palette", label: t("agency.studioSlashDesign"), run: () => { setMode("build"); setTargetSubagent("ui_ux"); } },
      { id: "qa", cmd: "/qa", icon: "shield", label: t("agency.studioSlashQa"), run: () => { setMode("build"); setTargetSubagent("qa"); } },
      { id: "preview", cmd: "/preview", icon: "globe", label: t("agency.studioSlashPreview"), run: () => setWorkspaceTab("preview") },
      { id: "changes", cmd: "/changes", icon: "file", label: t("agency.studioSlashChanges"), run: () => setWorkspaceTab("changes") },
      ...(messages.length > 0 && project?.id ? [{ id: "clear", cmd: "/clear", icon: "trash", label: t("agency.studioSlashClear"), run: () => { void clearHistory(); } }] : []),
    ];
    if (!slashMatch) return [];
    const q = slashMatch[1].toLowerCase();
    return all.filter((c) => c.id.includes(q) || c.label.toLowerCase().includes(q));
  }, [slashMatch?.[1], messages.length, project?.id]);

  const mentionMatch = input.match(/(?:^|\s)@([^\s]*)$/);
  const showMentionMenu = mentionOpen || !!mentionMatch;
  const mentionQuery = (mentionMatch?.[1] || "").toLowerCase();
  const mentionItems = useMemo(() => {
    if (!showMentionMenu) return [];
    const agents = Object.keys(SUBAGENT_DEFAULT_ROLES)
      .map((id) => ({ kind: "agent", id, label: t(`agency.studioSubagentNames.${id}`), subagent: id }))
      .filter((a) => !mentionQuery || a.id.includes(mentionQuery) || a.label.toLowerCase().includes(mentionQuery));
    const fileItems = files
      .filter((f) => !mentionedFiles.includes(f.path))
      .filter((f) => !mentionQuery || f.path.toLowerCase().includes(mentionQuery))
      .slice(0, 8)
      .map((f) => ({ kind: "file", id: f.path, label: f.path }));
    return [...agents, ...fileItems];
  }, [showMentionMenu, mentionQuery, files, mentionedFiles]);

  const activePopoverKind = showMentionMenu ? "mention" : (slashCommands.length > 0 ? "slash" : "");
  const activePopoverItems = activePopoverKind === "mention" ? mentionItems : (activePopoverKind === "slash" ? slashCommands : []);

  const executeSlashCommand = (cmdItem) => {
    setInput("");
    setPopoverIndex(0);
    cmdItem.run();
    composerRef.current?.focus();
  };

  const applyMentionItem = (item) => {
    if (item.kind === "agent") {
      setTargetSubagent(item.id);
    } else if (item.kind === "file") {
      setMentionedFiles((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
    }
    if (mentionMatch) {
      setInput((prev) => prev.replace(/(?:^|\s)@[^\s]*$/, (m) => (m.startsWith(" ") ? " " : "")).trimStart());
    }
    setMentionOpen(false);
    setPopoverIndex(0);
    composerRef.current?.focus();
  };

  const planTasks = plan?.tasks || [];
  const planDoneCount = planTasks.filter((tk) => tk.status === "done").length;
  const planProgressPct = planTasks.length > 0 ? Math.round((planDoneCount / planTasks.length) * 100) : 0;
  const rosterSubagents = studioSubagents.length > 0
    ? studioSubagents
    : Object.keys(SUBAGENT_DEFAULT_ROLES).map((id) => ({
        id,
        agencyRole: SUBAGENT_DEFAULT_ROLES[id],
        displayName: t(`agency.studioSubagentNames.${id}`),
        skills: [],
        enabled: true,
      }));

  const canSend = !busy && (input.trim().length > 0 || attachments.length > 0 || mentionedFiles.length > 0);

  return html`<section class="agency-studio-workbench">
    <aside
      class=${"agency-studio-chat" + (dragging ? " dragging" : "")}
      onDragOver=${(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave=${() => setDragging(false)}
      onDrop=${(e) => { e.preventDefault(); setDragging(false); void handleChatFiles(e.dataTransfer?.files); }}
    >
      <div class="agency-studio-chat-top">
        <div class="agency-studio-project-pick">
          <${Select}
            class="agency-studio-project-select"
            label=${t("agency.projectsTitle")}
            value=${selectedProjectId}
            width=${260}
            options=${[["__new__", t("agency.studioNewChatOption")], ...projects.map((p) => [p.id, p.title])]}
            onChange=${(v) => void selectProjectSafely(v)}
          />
        </div>
        <div class="agency-studio-chat-tools">
          <${Select}
            class="agency-studio-agent-select"
            label=${t("agency.studioSubagentFilterLabel")}
            value=${targetSubagent}
            width=${220}
            align="right"
            options=${[
              ["", t("agency.studioSubagentAuto")],
              ["architect", t("agency.studioSubagentNames.architect")],
              ["ui_ux", t("agency.studioSubagentNames.ui_ux")],
              ["frontend", t("agency.studioSubagentNames.frontend")],
              ["backend", t("agency.studioSubagentNames.backend")],
              ["qa", t("agency.studioSubagentNames.qa")],
            ]}
            onChange=${setTargetSubagent}
          />
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

      <div class="agency-studio-status-strip" role="status" aria-live="polite">
        <span class=${"agency-studio-run-dot " + runState} aria-hidden="true"></span>
        <strong class="agency-studio-run-label">${t(`agency.studioRunState.${runState}`)}</strong>
        ${busy === "chat" && activeSubagent && html`<span class="agency-studio-status-chip agency-truncate">
          ${activeSubagent.displayName || t(`agency.studioSubagentNames.${activeSubagent.subagent}`)}
        </span>`}
        ${busy === "chat" && html`<span class="agency-studio-live-timer mono">${formatElapsed(elapsedSec)}</span>`}
        ${runState === "awaiting_approval" && html`<button
          type="button"
          class="agency-studio-status-pill"
          onClick=${() => setWorkspaceTab("plan")}
        >
          <${Icon} name="outline" size="xs" /><span>${t("agency.studioTabPlan")}</span>
        </button>`}
        <span class="grow"></span>
        ${runState === "error" && lastAttemptRef.current && html`<button
          type="button"
          class="btn sm"
          onClick=${() => void sendStudioTurn(lastAttemptRef.current)}
        >
          <${Icon} name="refresh" size="xs" /><span>${t("agency.studioRetryBtn")}</span>
        </button>`}
      </div>

      ${error && html`<div class="agency-alert" role="alert">${error}</div>`}
      ${notice && html`<p class="agency-research-feedback" role="status">${notice}</p>`}

      <div class="agency-studio-thread-wrap">
        <div class="agency-studio-thread" ref=${threadRef} onScroll=${handleThreadScroll}>
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
              <${StudioTurnActivity} message=${m} onOpenFile=${openFileInCode} />
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
                  <button type="button" class=${"agency-studio-checkpoint-btn" + (workspaceTab === "changes" ? " active" : "")} onClick=${() => { setWorkspaceTab("changes"); void loadStudioChanges(m); }}>
                    <${Icon} name="file" size="xs" /><span>${t("agency.studioTabChanges")}</span>
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

          ${busy === "chat" && html`<div class=${"agency-studio-activity live" + (liveActivityOpen ? " open" : "")} role="status" aria-live="polite">
            <button
              type="button"
              class="agency-studio-activity-head"
              aria-expanded=${liveActivityOpen}
              onClick=${() => setLiveActivityOpen((v) => !v)}
            >
              <${BotAvatar} char=${agentAvatarOf(SUBAGENT_DEFAULT_ROLES[activeSubagent?.subagent || liveFocus?.subagent] || "developer")} size=${22} state="working" />
              <span class="agency-studio-live-focus shimmer">
                ${cancelRequested
                  ? t("agency.studioCancelingStatus")
                  : liveFocus?.text
                    ? liveFocus.text
                    : activeSubagent
                      ? (activeSubagent.title || activeSubagent.displayName || t(`agency.studioSubagentNames.${activeSubagent.subagent}`))
                      : (activeRunMode === "plan" ? t("agency.studioPlanningStatus") : t("agency.studioBuildingStatus"))}
              </span>
              ${liveSteps.length > 0 && html`<span class="agency-studio-step-dur mono">${t("agency.studioActivityLive", { count: liveSteps.length })}</span>`}
              <span class="agency-studio-live-timer mono">${formatElapsed(elapsedSec)}</span>
              <${Icon} name="chevRight" size="xs" class="chev" />
            </button>
            ${liveActivityOpen && (liveSteps.length > 0 || liveDelta) && html`<div class="agency-studio-activity-body">
              ${liveDelta && html`<pre class="agency-studio-live-delta mono">${liveDelta}</pre>`}
              ${liveSteps.length > 0 && html`<div class="agency-studio-activity-steps">
                ${liveSteps.slice(-8).map((st, idx) => {
                  const desc = describeLiveStep(st);
                  const isRunning = st.status === "running";
                  const isOpen = expandedLiveStep === idx;
                  return html`<div key=${st.id || `${st.step}-${idx}`} class="agency-studio-step-wrap">
                    <div class="agency-studio-live-step">
                      <span class="agency-studio-step-ic"><${Icon} name=${desc.icon} size="xs" /></span>
                      <span class=${"agency-studio-step-label" + (isRunning ? " shimmer" : "")}>${desc.label}</span>
                      ${desc.target && html`<code class="agency-studio-step-target agency-truncate mono" title=${desc.target}>${desc.target}</code>`}
                      <span class="grow"></span>
                      ${typeof st.durationMs === "number" && html`<span class="agency-studio-step-dur mono">${formatDurationMs(st.durationMs)}</span>`}
                      ${isRunning
                        ? html`<span class="agency-studio-act-dot warn" aria-hidden="true"></span>`
                        : html`<span class=${"agency-studio-step-status " + (st.ok ? "ok" : "err")}><${Icon} name=${st.ok ? "check" : "alert"} size="xs" /></span>`}
                      ${st.summary && !isRunning && html`<button
                        type="button"
                        class="icon-btn xs"
                        aria-expanded=${isOpen}
                        onClick=${() => setExpandedLiveStep(isOpen ? -1 : idx)}
                      >
                        <${Icon} name="chevRight" size="xs" class="chev" />
                      </button>`}
                    </div>
                    ${isOpen && st.summary && html`<pre class="agency-studio-step-detail mono">${st.summary}</pre>`}
                  </div>`;
                })}
              </div>`}
            </div>`}
          </div>`}
        </div>

        ${showScrollDown && html`<button
          type="button"
          class="agency-studio-to-bottom"
          title=${t("agency.studioScrollBottom")}
          aria-label=${t("agency.studioScrollBottom")}
          onClick=${() => scrollToBottom(true)}
        >
          <${Icon} name="down" size="sm" />
          ${hasUnreadLive && html`<span class="new" aria-hidden="true"></span>`}
        </button>`}
      </div>

      ${planTasks.length > 0 && html`<div class=${"agency-studio-steps-dock" + (stepsDockOpen ? " open" : "")}>
        <div class="agency-studio-steps-head">
          <button
            type="button"
            class="agency-studio-steps-toggle"
            aria-expanded=${stepsDockOpen}
            onClick=${() => setStepsDockOpen((v) => !v)}
          >
            <${Icon} name="clipboardCheck" size="sm" />
            <strong class="agency-truncate">${t("agency.studioStepsProgress", { done: planDoneCount, total: planTasks.length })}</strong>
            <span class=${"agency-whatsapp-state " + plan.status}>${t(`agency.studioPlanStatus.${plan.status}`)}</span>
            <span class="grow"></span>
            <${Icon} name="chevRight" size="xs" class="chev" />
          </button>
          <button
            type="button"
            class="icon-btn xs"
            title=${t("agency.studioTabPlan")}
            aria-label=${t("agency.studioTabPlan")}
            onClick=${() => setWorkspaceTab("plan")}
          >
            <${Icon} name="outline" size="xs" />
          </button>
        </div>
        <div class="agency-studio-steps-bar" aria-hidden="true">
          <i style=${{ width: `${planProgressPct}%` }}></i>
        </div>
        ${stepsDockOpen && html`<div class="agency-studio-steps-list">
          ${planTasks.map((tk) => html`<div key=${tk.id} class=${"agency-studio-steps-row " + tk.status}>
            ${tk.status === "running"
              ? html`<span class="agency-studio-act-dot warn" aria-hidden="true"></span>`
              : tk.status === "done"
                ? html`<span class="agency-studio-step-status ok"><${Icon} name="check" size="xs" /></span>`
                : tk.status === "failed"
                  ? html`<span class="agency-studio-step-status err"><${Icon} name="alert" size="xs" /></span>`
                  : html`<span class="agency-studio-act-dot idle" aria-hidden="true"></span>`}
            <span class=${"agency-studio-steps-title agency-truncate" + (tk.status === "running" ? " shimmer" : "")} title=${tk.title}>${tk.title}</span>
            <small class="agency-studio-steps-agent">${t(`agency.studioSubagentNames.${tk.subagent}`)}</small>
          </div>`)}
          ${plan.status === "draft" && !busy && html`<div class="agency-studio-steps-approve">
            <button
              type="button"
              class="btn primary sm"
              onClick=${() => void sendStudioTurn({ mode: "build", executePlan: true, message: "", skipAttachments: true })}
            >
              <${Icon} name="spark" size="xs" /><span>${t("agency.studioApprovePlanBtn")}</span>
            </button>
            <button
              type="button"
              class="btn sm"
              onClick=${() => { setMode("plan"); composerRef.current?.focus(); }}
            >
              <span>${t("agency.studioAdjustPlanBtn")}</span>
            </button>
          </div>`}
        </div>`}
      </div>`}

      <div class="agency-studio-dock">
        <form
          class=${"agency-studio-composer" + (dragging ? " drag" : "")}
          onSubmit=${(e) => { e.preventDefault(); void sendStudioTurn(); }}
        >
          ${activePopoverKind && html`<div class="agency-studio-popover" role="listbox">
            <div class="agency-studio-popover-head">
              <span>${activePopoverKind === "slash" ? t("agency.studioSlashTitle") : t("agency.studioMentionAgents")}</span>
              ${activePopoverKind === "mention" && files.length > 0 && html`<span class="agency-muted">· ${t("agency.studioMentionFiles")}</span>`}
            </div>
            ${activePopoverItems.length === 0
              ? html`<p class="agency-studio-popover-empty">${t("agency.studioMentionEmpty")}</p>`
              : activePopoverItems.map((item, idx) => html`<button
                  key=${`${item.kind || "cmd"}-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected=${idx === popoverIndex}
                  class=${"agency-studio-popover-item" + (idx === popoverIndex ? " active" : "")}
                  onMouseDown=${(e) => {
                    e.preventDefault();
                    if (activePopoverKind === "slash") executeSlashCommand(item);
                    else applyMentionItem(item);
                  }}
                >
                  ${item.kind === "agent"
                    ? html`<${BotAvatar} char=${agentAvatarOf(SUBAGENT_DEFAULT_ROLES[item.id] || "developer")} size=${18} state="idle" />`
                    : html`<${Icon} name=${item.icon || "file"} size="xs" />`}
                  <strong class="agency-truncate">${item.cmd || item.label}</strong>
                  ${item.cmd && html`<span class="agency-truncate">${item.label}</span>`}
                  ${item.kind === "agent" && html`<span class="agency-studio-popover-tag">${t("agency.studioSubagentFilterLabel")}</span>`}
                </button>`)}
          </div>`}
          <input
            ref=${chatUploadRef}
            class="agency-copilot-file-input"
            type="file"
            multiple
            accept=".txt,.md,.markdown,.csv,.json,.js,.mjs,.ts,.tsx,.jsx,.html,.css,.xml,.yaml,.yml,.sql,.pdf,.png,.jpg,.jpeg,.webp,.svg"
            onChange=${(e) => { void handleChatFiles(e.currentTarget.files); e.currentTarget.value = ""; }}
          />
          ${(attachments.length > 0 || mentionedFiles.length > 0 || targetSubagent) && html`<div class="agency-copilot-attachments">
            ${targetSubagent && html`<span class="agency-copilot-chip">
              <${BotAvatar} char=${agentAvatarOf(SUBAGENT_DEFAULT_ROLES[targetSubagent] || "developer")} size=${16} state="idle" />
              <span class="agency-truncate">@${t(`agency.studioSubagentNames.${targetSubagent}`)}</span>
              <button class="agency-copilot-chip-rm" type="button" aria-label=${t("agency.close")} onClick=${() => setTargetSubagent("")}><${Icon} name="close" size="xs" /></button>
            </span>`}
            ${mentionedFiles.map((fp) => html`<span key=${fp} class="agency-copilot-chip">
              <${Icon} name="file" size="sm" />
              <span class="agency-truncate">@${fp}</span>
              <button class="agency-copilot-chip-rm" type="button" aria-label=${t("agency.close")} onClick=${() => setMentionedFiles((p) => p.filter((x) => x !== fp))}><${Icon} name="close" size="xs" /></button>
            </span>`)}
            ${attachments.map((att, idx) => html`<span key=${`${att.name}-${idx}`} class="agency-copilot-chip">
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
            onInput=${(e) => { setInput(e.currentTarget.value); setPopoverIndex(0); }}
            onKeyDown=${(e) => {
              if (e.isComposing || e.keyCode === 229) return;
              if (activePopoverItems.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setPopoverIndex((i) => (i + 1) % activePopoverItems.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setPopoverIndex((i) => (i - 1 + activePopoverItems.length) % activePopoverItems.length);
                  return;
                }
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault();
                  const chosen = activePopoverItems[popoverIndex] || activePopoverItems[0];
                  if (chosen) {
                    if (activePopoverKind === "slash") executeSlashCommand(chosen);
                    else applyMentionItem(chosen);
                  }
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionOpen(false);
                  if (slashMatch) setInput("");
                  return;
                }
              }
              if (e.key === "Escape" && busy === "chat" && canCancel && !cancelRequested) {
                e.preventDefault();
                void cancelStudioTurn();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
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
            <button
              class="agency-copilot-plus"
              type="button"
              disabled=${!!busy}
              title=${t("agency.studioMentionBtn")}
              aria-label=${t("agency.studioMentionBtn")}
              onClick=${() => { setMentionOpen((v) => !v); setPopoverIndex(0); composerRef.current?.focus(); }}
            >
              <${Icon} name="atSign" size="sm" />
            </button>
            <span class="grow"></span>
            <div class="agency-studio-mode-switch" role="tablist" aria-label=${t("agency.studioModeLabel")}>
              <button type="button" role="tab" aria-selected=${mode === "plan"} class=${mode === "plan" ? "active" : ""} onClick=${() => setMode("plan")}>${t("agency.studioModePlan")}</button>
              <button type="button" role="tab" aria-selected=${mode === "build"} class=${mode === "build" ? "active" : ""} onClick=${() => setMode("build")}>${t("agency.studioModeBuild")}</button>
            </div>
            ${busy === "chat"
              ? html`<button
                  class="agency-copilot-send"
                  type="button"
                  disabled=${!canCancel || cancelRequested}
                  aria-busy=${cancelRequested ? "true" : undefined}
                  title=${cancelRequested ? t("agency.studioCancelingStatus") : t("agency.studioCancelBtn")}
                  aria-label=${cancelRequested ? t("agency.studioCancelingStatus") : t("agency.studioCancelBtn")}
                  onClick=${cancelStudioTurn}
                >
                  ${cancelRequested ? html`<${Spinner} />` : html`<${Icon} name="stop" size="sm" strong=${true} />`}
                </button>`
              : html`<button
                  class="agency-copilot-send"
                  type="submit"
                  disabled=${!canSend}
                  title=${mode === "plan" ? t("agency.studioDiscussBtn") : t("agency.studioBuildBtn")}
                  aria-label=${mode === "plan" ? t("agency.studioDiscussBtn") : t("agency.studioBuildBtn")}
                >
                  <${Icon} name="up" size="sm" strong=${true} />
                </button>`}
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
          <button type="button" role="tab" aria-selected=${workspaceTab === "plan"} class=${workspaceTab === "plan" ? "active" : ""} onClick=${() => setWorkspaceTab("plan")}>
            <${Icon} name="outline" size="sm" /><span>${t("agency.studioTabPlan")}</span>
            ${planTasks.length > 0 && html`<span class="agency-count-pill">${planDoneCount}/${planTasks.length}</span>`}
          </button>
        </div>

        ${workspaceTab === "preview" && (hasIndex || devServer?.hasDevScript) && html`<div class="agency-studio-preview-bar">
          ${devServer?.hasDevScript && html`<${Select}
            class="agency-studio-execution-mode"
            label=${t("agency.studioExecutionModeLabel")}
            value=${executionMode}
            block=${false}
            width=${210}
            disabled=${devServerBusy || !!devServer?.running}
            options=${[
              ["container", t("agency.studioExecutionModeContainer")],
              ["host", t("agency.studioExecutionModeHost")],
            ]}
            onChange=${setExecutionMode}
          />`}
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
          ${hasIndex && html`<form
            class="agency-studio-url-pill"
            onSubmit=${(ev) => {
              ev.preventDefault();
              setPreviewRoute(previewRouteInput || "/");
              setPreviewNonce((n) => n + 1);
            }}
          >
            <button type="button" class="icon-btn xs" title=${t("agency.studioPreviewRefresh")} aria-label=${t("agency.studioPreviewRefresh")} onClick=${() => setPreviewNonce((n) => n + 1)}>
              <${Icon} name="refresh" size="xs" />
            </button>
            <span class="agency-studio-url-host mono">${displayPreviewHost}</span>
            ${devServer?.running && html`<input
              type="text"
              class="agency-studio-route-input mono"
              value=${previewRouteInput}
              placeholder=${t("agency.studioPreviewRoutePlaceholder")}
              aria-label=${t("agency.studioPreviewRoutePlaceholder")}
              onInput=${(ev) => setPreviewRouteInput(ev.currentTarget.value)}
            />`}
            <a class="icon-btn xs" href=${previewUrl} target="_blank" rel="noopener" title=${t("agency.studioOpenNewTab")} aria-label=${t("agency.studioOpenNewTab")}>
              <${Icon} name="ext" size="xs" />
            </a>
          </form>`}
          ${hasIndex && html`<button
            type="button"
            class=${"btn sm agency-studio-console-btn" + (consoleOpen ? " active" : "")}
            aria-expanded=${consoleOpen}
            onClick=${() => setConsoleOpen((v) => !v)}
          >
            <${Icon} name="code" size="xs" />
            <span>${t("agency.studioConsoleToggle")}</span>
            ${consoleErrorCount > 0 && html`<span class="agency-studio-console-badge">${consoleErrorCount}</span>`}
          </button>`}
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
        ${consoleOpen && html`<div class="agency-studio-console-drawer">
          <div class="agency-studio-console-head">
            <strong>${t("agency.studioConsoleToggle")}</strong>
            ${consoleErrorCount > 0 && html`<span class="agency-studio-console-badge">${t("agency.studioConsoleErrors", { count: consoleErrorCount })}</span>`}
            <span class="grow"></span>
            ${(previewEvents.length > 0 || devServer?.error) && html`<button
              type="button"
              class="btn primary sm"
              disabled=${!!busy}
              onClick=${() => {
                const errSummary = previewEvents.map((e) => `[${e.type}] ${e.message}${e.url ? ` (${e.url})` : ""}`).join("\n");
                const srvSummary = devServer?.error ? `DevServer error: ${devServer.error}\n${(devServer.logs || []).slice(-12).join("\n")}` : "";
                void sendStudioTurn({
                  mode: "build",
                  targetSubagent: "qa",
                  message: `Corrige les erreurs détectées dans l'aperçu :\n${[errSummary, srvSummary].filter(Boolean).join("\n\n")}`,
                  skipAttachments: true,
                });
              }}
            >
              <${Icon} name="shield" size="xs" /><span>${t("agency.studioFixPreviewError")}</span>
            </button>`}
            ${previewEvents.length > 0 && html`<button type="button" class="btn sm" onClick=${() => setPreviewEvents([])}>
              <span>${t("agency.studioConsoleClear")}</span>
            </button>`}
          </div>
          <div class="agency-studio-console-body mono">
            ${previewEvents.length === 0 && !(devServer?.logs?.length)
              ? html`<p class="agency-studio-console-empty">${t("agency.studioConsoleEmpty")}</p>`
              : html`
                ${previewEvents.map((ev, idx) => html`<div key=${`pe-${idx}-${ev.ts}`} class="agency-studio-console-row err">
                  <span class="agency-studio-console-tag">[${ev.type}]</span>
                  <span>${ev.message}</span>
                </div>`)}
                ${(devServer?.logs || []).slice(-20).map((line, idx) => html`<div key=${`dl-${idx}`} class="agency-studio-console-row">
                  <span>${line}</span>
                </div>`)}
              `}
          </div>
        </div>`}
      </div>`}

      ${workspaceTab === "changes" && html`<div class="agency-studio-changes-pane">
        <div class="agency-studio-changes-head">
          <div>
            <strong>${t("agency.studioChangesTitle")}</strong>
            <p>${changeSnapshot ? t("agency.studioDiffTitle") : (diffError || t("agency.studioNoChanges"))}</p>
          </div>
          <span class="agency-count-pill">${changedFiles.length}</span>
        </div>
        ${changedFiles.length > 0
          ? html`<div class="agency-studio-changes-layout">
              <div class="agency-studio-changes-list" role="list" aria-label=${t("agency.studioChangesTitle")}>
                ${changedFiles.map((filePath) => {
                  const metadata = diffFiles.find((entry) => entry.path === filePath);
                  const exists = files.some((f) => f.path === filePath);
                  const status = metadata?.status || (exists ? "modified" : "deleted");
                  const statusKey = status === "added" ? "studioDiffAdded" : status === "deleted" ? "studioDiffDeleted" : "studioDiffModified";
                  const selected = selectedChangePath === filePath;
                  return html`<button type="button" class=${"agency-studio-change-row" + (selected ? " active" : "")} aria-pressed=${selected} onClick=${() => void loadStudioFileDiff(filePath)} title=${filePath}>
                    <${Icon} name=${status === "deleted" ? "trash" : status === "added" ? "plus" : "file"} size="sm" />
                    <span class="agency-studio-change-main">
                      <span class="agency-truncate">${filePath}</span>
                      <small>${t(`agency.${statusKey}`)}</small>
                    </span>
                    ${metadata && !metadata.binary && html`<span class="agency-studio-diff-stats"><b>+${metadata.additions}</b><i>−${metadata.deletions}</i></span>`}
                  </button>`;
                })}
                ${diffListTruncated && html`<small class="agency-studio-diff-note">${t("agency.studioDiffListTruncated")}</small>`}
              </div>
              <section class="agency-studio-diff-view" aria-live="polite" aria-label=${t("agency.studioDiffTitle")}>
                ${diffLoading
                  ? html`<div class="agency-empty"><${Spinner} /><strong>${t("agency.studioDiffLoading")}</strong></div>`
                  : diffError
                    ? html`<div class="agency-empty"><${Icon} name="info" size="lg" /><strong>${diffError}</strong></div>`
                    : selectedChangeDiff
                      ? html`<div class="agency-studio-diff-content">
                          <div class="agency-studio-diff-head">
                            <div>
                              <strong class="agency-truncate" title=${selectedChangeDiff.path}>${selectedChangeDiff.path}</strong>
                              <small>${t(`agency.${selectedChangeDiff.status === "added" ? "studioDiffAdded" : selectedChangeDiff.status === "deleted" ? "studioDiffDeleted" : "studioDiffModified"}`)} · <span class="agency-studio-diff-stats"><b>+${selectedChangeDiff.additions}</b><i>−${selectedChangeDiff.deletions}</i></span></small>
                            </div>
                            ${files.some((f) => f.path === selectedChangeDiff.path) && html`<button type="button" class="btn sm" onClick=${() => openFileInCode(selectedChangeDiff.path)}><${Icon} name="code" size="xs" /><span>${t("agency.studioTabCode")}</span></button>`}
                          </div>
                          ${selectedChangeDiff.binary
                            ? html`<div class="agency-empty"><${Icon} name="file" size="lg" /><strong>${t("agency.studioDiffBinary")}</strong></div>`
                            : html`<div class="agency-studio-diff-code">
                                ${String(selectedChangeDiff.patch || "").split(/\r?\n/).map((line, index) => {
                                  const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context";
                                  return html`<div key=${index} class=${"agency-studio-diff-line " + kind}><code>${line || " "}</code></div>`;
                                })}
                              </div>`}
                          ${selectedChangeDiff.patchTruncated && html`<small class="agency-studio-diff-note">${t("agency.studioDiffPatchTruncated")}</small>`}
                        </div>`
                      : html`<div class="agency-empty"><${Icon} name="file" size="lg" /><strong>${t("agency.studioNoDiffSelected")}</strong></div>`}
              </section>
            </div>`
          : html`<div class="agency-empty"><${Icon} name="file" size="lg" /><strong>${t("agency.studioNoChanges")}</strong></div>`}
      </div>`}

      ${workspaceTab === "plan" && html`<div class="agency-studio-plan-pane">
        <div class="agency-studio-plan-main">
          ${plan
            ? renderPlanCard(plan, false)
            : html`<div class="agency-empty">
                <${Icon} name="outline" size="lg" />
                <strong>${t("agency.studioNoPlanTitle")}</strong>
                <p>${t("agency.studioNoPlanDesc")}</p>
                <button type="button" class="btn primary sm" onClick=${() => { setMode("plan"); composerRef.current?.focus(); }}>
                  <${Icon} name="spark" size="xs" /><span>${t("agency.studioDiscussBtn")}</span>
                </button>
              </div>`}
        </div>
        <section class="agency-studio-roster-section">
          <h3>${t("agency.studioSubagentsHeading")}</h3>
          <div class="agency-studio-roster-grid">
            ${rosterSubagents.map((sa) => {
              const saState = activeSubagent?.subagent === sa.id ? "working" : (subagentStates[sa.id] || "idle");
              const focused = targetSubagent === sa.id;
              return html`<article key=${sa.id} class=${"agency-studio-roster-card" + (focused ? " active" : "")}>
                <div class="agency-studio-roster-head">
                  <${BotAvatar} char=${agentAvatarOf(SUBAGENT_DEFAULT_ROLES[sa.id] || sa.agencyRole || "developer")} size=${28} state=${saState === "working" ? "working" : "idle"} />
                  <div class="agency-studio-roster-meta">
                    <strong class="agency-truncate">${sa.displayName || t(`agency.studioSubagentNames.${sa.id}`)}</strong>
                    <small class="agency-truncate">${t(`agency.studioSubagentNames.${sa.id}`)}</small>
                  </div>
                  <span class=${"agency-whatsapp-state " + saState}>${t(`agency.studioSubagentState.${saState}`)}</span>
                </div>
                ${sa.skills?.length > 0 && html`<div class="agency-copilot-attachments">
                  ${sa.skills.slice(0, 3).map((sk) => html`<span class="agency-studio-stack-pill">${sk}</span>`)}
                </div>`}
                <div class="agency-commercial-actions">
                  <button
                    type="button"
                    class=${"btn sm" + (focused ? " primary" : "")}
                    onClick=${() => {
                      setTargetSubagent(focused ? "" : sa.id);
                      composerRef.current?.focus();
                    }}
                  >
                    <span>${t("agency.studioFocusSubagentBtn")}</span>
                  </button>
                </div>
              </article>`;
            })}
          </div>
        </section>
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
