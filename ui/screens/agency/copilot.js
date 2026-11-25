import { useState } from "preact/hooks";
import { html, Icon, Spinner } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";

const enc = encodeURIComponent;

export function AgencyCopilot({ orgId, activeTab = "copilot", companyId = "", leadId = "", projectId = "" }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    <div class="agency-copilot-thread">
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
      ${messages.map((m) => html`<article class=${"agency-copilot-msg " + m.role}>
        <strong>${m.role === "user" ? "Vous" : m.model ? `${t("agency.copilotTitle")} · ${m.model}` : t("agency.copilotTitle")}</strong>
        <pre>${m.text}</pre>
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
