import { useEffect, useRef, useState } from "preact/hooks";
import { CopyButton, html, Icon, Spinner } from "../../components/ui.js";
import { Markdown } from "../../components/markdown.js";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";

const enc = encodeURIComponent;

export function AgencyCopilot({ orgId, activeTab = "copilot", companyId = "", leadId = "", projectId = "" }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const threadRef = useRef(null);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  const ask = async (promptText) => {
    const clean = (promptText ?? question).trim();
    if (!clean || !orgId || busy) return;
    setBusy(true);
    setError("");
    setMessages((prev) => [...prev, { role: "user", text: clean }]);
    if (!promptText) setQuestion("");
    try {
      const res = await api(`/agency/${enc(orgId)}/copilot`, {
        method: "POST",
        body: { tab: activeTab, question: clean, companyId, leadId, projectId },
      });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: res.answer || "", mode: res.mode, model: res.model },
      ]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const quickPrompts = [
    t("agency.copilotPromptPipeline"),
    t("agency.copilotPromptProjects"),
    t("agency.copilotPromptNext"),
  ];

  return html`<section class="agency-copilot">
    ${error && html`<div class="agency-alert" role="alert">${error}</div>`}
    <div class="agency-copilot-thread" ref=${threadRef}>
      ${!messages.length && html`<div class="agency-copilot-welcome">
        <span class="agency-quick-icon tone-purple"><${Icon} name="spark" size="lg" /></span>
        <div>
          <h2>${t("agency.copilotTitle")}</h2>
          <p>${t("agency.copilotEmpty")}</p>
        </div>
        <div class="agency-copilot-prompts">
          ${quickPrompts.map((prompt) => html`<button class="agency-copilot-prompt" type="button" disabled=${busy} onClick=${() => ask(prompt)}>
            <span>${prompt}</span>
          </button>`)}
        </div>
      </div>`}
      ${messages.map((m) => m.role === "user"
        ? html`<article class="agency-copilot-msg user">
            <p class="agency-copilot-user-text">${m.text}</p>
          </article>`
        : html`<article class="agency-copilot-msg assistant">
            <div class="agency-copilot-msg-head">
              <div class="agency-copilot-msg-meta">
                <strong>${t("agency.copilotTitle")}</strong>
                ${m.model && html`<span class="agency-whatsapp-state">${m.model}</span>`}
              </div>
              <${CopyButton} text=${m.text} />
            </div>
            <${Markdown} text=${m.text} />
          </article>`)}
      ${busy && html`<div class="agency-loading"><${Spinner} />${t("agency.loading")}</div>`}
    </div>
    <form class="agency-copilot-form" onSubmit=${(e) => { e.preventDefault(); ask(); }}>
      <input class="field" value=${question} placeholder=${t("agency.copilotPlaceholder")} onInput=${(e) => setQuestion(e.currentTarget.value)} />
      <button class="btn primary" type="submit" disabled=${busy || !question.trim()}>
        ${busy ? html`<${Spinner} />` : html`<${Icon} name="spark" size="sm" />`}${t("agency.copilotSend")}
      </button>
    </form>
  </section>`;
}
