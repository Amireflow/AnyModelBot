import { useEffect, useRef, useState } from "preact/hooks";
import { autoGrow, CopyButton, html, Icon, Spinner } from "../../components/ui.js";
import { Markdown } from "../../components/markdown.js";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { confirmSheet } from "../../lib/store.js";

const enc = encodeURIComponent;
const TEXT_EXT = /\.(txt|md|markdown|csv|json|js|mjs|ts|tsx|jsx|html|htm|css|xml|yaml|yml|sql|log|svg)$/i;
const MAX_FILES = 5;
const MAX_TEXT_BYTES = 200 * 1024;
const MAX_BIN_BYTES = 750 * 1024;

export function readFilePayload(file) {
  return new Promise((resolve, reject) => {
    const isText = TEXT_EXT.test(file.name) || (file.type && file.type.startsWith("text/"));
    if (isText && file.size > MAX_TEXT_BYTES) {
      reject(new Error(t("agency.copilotFileTooLarge", { name: file.name })));
      return;
    }
    if (!isText && file.size > MAX_BIN_BYTES) {
      reject(new Error(t("agency.copilotFileTooLarge", { name: file.name })));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("agency.copilotFileTooLarge", { name: file.name })));
    if (isText) {
      reader.onload = () => resolve({
        name: file.name,
        mimeType: file.type || "text/plain",
        size: file.size,
        textContent: String(reader.result || "").slice(0, 24_000),
      });
      reader.readAsText(file);
    } else {
      reader.onload = () => {
        const res = String(reader.result || "");
        const comma = res.indexOf(",");
        resolve({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          base64Content: comma >= 0 ? res.slice(comma + 1) : res,
        });
      };
      reader.readAsDataURL(file);
    }
  });
}

export function AgencyCopilot({ orgId, activeTab = "copilot", companyId = "", leadId = "", projectId = "", onDataChanged }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const threadRef = useRef(null);
  const fileInputRef = useRef(null);
  const taRef = useRef(null);

  // Historique persistant côté serveur (par organisation) : survit au rechargement,
  // au changement d'onglet et au redémarrage du daemon.
  useEffect(() => {
    if (!orgId) { setMessages([]); return; }
    let cancelled = false;
    api(`/agency/${enc(orgId)}/copilot/history`)
      .then((res) => { if (!cancelled) setMessages(Array.isArray(res?.items) ? res.items : []); })
      .catch(() => { if (!cancelled) setMessages([]); });
    return () => { cancelled = true; };
  }, [orgId]);

  const clearHistory = async () => {
    if (!orgId || busy) return;
    const ok = await confirmSheet({
      title: t("agency.copilotClearBtn"),
      body: t("agency.copilotClearConfirm"),
      confirmLabel: t("agency.copilotClearBtn"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/agency/${enc(orgId)}/copilot/history`, { method: "DELETE" });
      setMessages([]);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  useEffect(() => {
    if (!question && taRef.current) taRef.current.style.height = "auto";
  }, [question]);

  const handleFiles = async (fileList) => {
    if (!fileList?.length) return;
    setError("");
    const incoming = Array.from(fileList).slice(0, Math.max(0, MAX_FILES - attachments.length));
    try {
      const parsed = await Promise.all(incoming.map(readFilePayload));
      setAttachments((prev) => [...prev, ...parsed].slice(0, MAX_FILES));
    } catch (err) {
      setError(err.message);
    }
  };

  const removeAttachment = (idx) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const ask = async (promptText) => {
    const clean = (promptText ?? question).trim();
    if ((!clean && attachments.length === 0) || !orgId || busy) return;
    setBusy(true);
    setError("");
    const sentAttachments = [...attachments];
    const displayText = clean || sentAttachments.map((f) => f.name).join(", ");
    const history = messages.slice(-10).map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [
      ...prev,
      { role: "user", text: displayText, files: sentAttachments.map((f) => f.name) },
    ]);
    if (!promptText) setQuestion("");
    setAttachments([]);
    try {
      const res = await api(`/agency/${enc(orgId)}/copilot`, {
        method: "POST",
        body: {
          tab: activeTab,
          question: clean,
          companyId,
          leadId,
          projectId,
          attachments: sentAttachments,
          history,
        },
      });
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: res.answer || "",
          mode: res.mode,
          model: res.model,
          actions: Array.isArray(res.actions) ? res.actions : [],
        },
      ]);
      if (Array.isArray(res.actions) && res.actions.some((a) => a.ok)) {
        onDataChanged?.();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ask();
    }
  };

  const onPaste = (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      void handleFiles(files);
    }
  };

  const quickPrompts = [
    { icon: "trend", tone: "blue", text: t("agency.copilotPromptPipeline") },
    { icon: "globe", tone: "teal", text: t("agency.copilotPromptProspect") },
    { icon: "code", tone: "purple", text: t("agency.copilotPromptProject") },
    { icon: "clipboardCheck", tone: "amber", text: t("agency.copilotPromptProjects") },
  ];

  const canSend = !busy && (!!question.trim() || attachments.length > 0);

  return html`<section
    class=${"agency-copilot" + (dragging ? " dragging" : "")}
    onDragOver=${(e) => { e.preventDefault(); setDragging(true); }}
    onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
    onDrop=${(e) => { e.preventDefault(); setDragging(false); void handleFiles(e.dataTransfer?.files); }}
  >
    <div class="agency-copilot-thread" ref=${threadRef}>
      <div class="agency-copilot-col">
        ${error && html`<div class="agency-alert" role="alert">${error}</div>`}
        ${!messages.length && html`<div class="agency-copilot-welcome">
          <span class="agency-copilot-emblem tone-purple"><${Icon} name="spark" size="xl" /></span>
          <div class="agency-copilot-intro">
            <h2>${t("agency.copilotTitle")}</h2>
            <p>${t("agency.copilotEmpty")}</p>
          </div>
          <div class="agency-copilot-prompts">
            ${quickPrompts.map((item) => html`<button class="agency-copilot-prompt" type="button" disabled=${busy} onClick=${() => ask(item.text)}>
              <span class=${"agency-quick-icon tone-" + item.tone}><${Icon} name=${item.icon} size="sm" /></span>
              <span class="agency-copilot-prompt-text">${item.text}</span>
              <${Icon} name="chevRight" size="xs" class="agency-copilot-prompt-arrow" />
            </button>`)}
          </div>
          <p class="agency-copilot-hint"><${Icon} name="doc" size="xs" /><span>${t("agency.copilotDropHint")}</span></p>
        </div>`}
        ${messages.map((m) => m.role === "user"
          ? html`<article class="agency-copilot-msg user">
              <p class="agency-copilot-user-text">${m.text}</p>
              ${m.files?.length > 0 && html`<div class="agency-copilot-attachments">
                ${m.files.map((fname) => html`<span class="agency-copilot-chip"><${Icon} name="doc" size="sm" /><span class="agency-truncate">${fname}</span></span>`)}
              </div>`}
            </article>`
          : html`<article class="agency-copilot-msg assistant">
              <div class="agency-copilot-msg-head">
                <div class="agency-copilot-msg-meta">
                  <span class="agency-copilot-badge tone-purple"><${Icon} name="spark" size="xs" /></span>
                  <strong>${t("agency.copilotTitle")}</strong>
                  ${m.model && html`<span class="agency-whatsapp-state">${m.model}</span>`}
                </div>
                <${CopyButton} text=${m.text} />
              </div>
              ${m.actions?.length > 0 && html`<details class="agency-copilot-actions-list" open>
                <summary>${t("agency.copilotActionsTitle")} (${m.actions.length})</summary>
                ${m.actions.map((act) => html`<div class="agency-copilot-action-row">
                  <span class="agency-truncate" title=${`${act.tool} · ${act.summary}`}><strong>${act.tool}</strong> · ${act.summary}</span>
                  <span class=${"agency-whatsapp-state " + (act.ok ? "accepted" : "blocked")}>${act.ok ? "OK" : "ERR"}</span>
                </div>`)}
              </details>`}
              <${Markdown} text=${m.text} />
            </article>`)}
        ${busy && html`<div class="agency-loading"><${Spinner} /><span>${t("agency.loading")}</span></div>`}
      </div>
    </div>
    <div class="agency-copilot-dock">
      <form class=${"agency-copilot-composer" + (dragging ? " drag" : "")} onSubmit=${(e) => { e.preventDefault(); void ask(); }}>
        <input
          ref=${fileInputRef}
          class="agency-copilot-file-input"
          type="file"
          multiple
          accept=".txt,.md,.markdown,.csv,.json,.js,.mjs,.ts,.tsx,.jsx,.html,.css,.xml,.yaml,.yml,.sql,.pdf,.png,.jpg,.jpeg,.webp,.svg"
          onChange=${(e) => { void handleFiles(e.currentTarget.files); e.currentTarget.value = ""; }}
        />
        ${attachments.length > 0 && html`<div class="agency-copilot-attachments">
          ${attachments.map((att, idx) => html`<span class="agency-copilot-chip">
            <${Icon} name="doc" size="sm" />
            <span class="agency-truncate">${att.name} (${Math.max(1, Math.round(att.size / 1024))} Ko)</span>
            <button class="agency-copilot-chip-rm" type="button" aria-label=${t("agency.close")} onClick=${() => removeAttachment(idx)}><${Icon} name="close" size="xs" /></button>
          </span>`)}
        </div>`}
        <textarea
          ref=${taRef}
          rows="1"
          value=${question}
          aria-label=${t("agency.copilotPlaceholder")}
          placeholder=${t("agency.copilotPlaceholder")}
          onInput=${(e) => { setQuestion(e.currentTarget.value); autoGrow(e.currentTarget); }}
          onKeyDown=${onKeyDown}
          onPaste=${onPaste}
        ></textarea>
        <div class="agency-copilot-bar">
          <button
            class="agency-copilot-plus"
            type="button"
            disabled=${busy || attachments.length >= MAX_FILES}
            title=${t("agency.copilotAttachBtn")}
            aria-label=${t("agency.copilotAttachBtn")}
            onClick=${() => fileInputRef.current?.click()}
          ><${Icon} name="plus" size="md" /></button>
          ${attachments.length > 0 && html`<span class="agency-count-pill num">${attachments.length}/${MAX_FILES}</span>`}
          <span class="grow"></span>
          ${messages.length > 0 && html`<button class="agency-copilot-clear" type="button" disabled=${busy} title=${t("agency.copilotClearBtn")} onClick=${clearHistory}>
            <${Icon} name="trash" size="sm" /><span>${t("agency.copilotClearBtn")}</span>
          </button>`}
          <button
            class="agency-copilot-send"
            type="submit"
            disabled=${!canSend}
            aria-busy=${busy || undefined}
            aria-label=${t("agency.copilotSend")}
            title=${t("agency.copilotSend")}
          >${busy ? html`<${Spinner} />` : html`<${Icon} name="up" size="md" strong />`}</button>
        </div>
      </form>
    </div>
  </section>`;
}
