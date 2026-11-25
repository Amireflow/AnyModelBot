import { useState } from "preact/hooks";
import { html, Icon } from "../../components/ui.js";
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

  return html`<section class="agency-project-section agency-copilot">
    <div class="agency-commercial-head">
      <h2>${t("agency.copilotTitle")}</h2>
      <div class="agency-commercial-actions">
        <button class="btn" type="button" disabled=${busy} onClick=${() => ask(t("agency.copilotPromptPipeline"))}>${t("agency.copilotPromptPipeline")}</button>
        <button class="btn" type="button" disabled=${busy} onClick=${() => ask(t("agency.copilotPromptProjects"))}>${t("agency.copilotPromptProjects")}</button>
        <button class="btn" type="button" disabled=${busy} onClick=${() => ask(t("agency.copilotPromptNext"))}>${t("agency.copilotPromptNext")}</button>
      </div>
    </div>
    ${error && html`<div class="agency-alert" role="alert">${error}</div>`}
    <div class="agency-copilot-thread">
      ${!messages.length && html`<p class="agency-muted">${t("agency.copilotEmpty")}</p>`}
      ${messages.map((m) => html`<article class=${"agency-copilot-msg " + m.role}>
        <strong>${m.role === "user" ? "Vous" : m.model ? `Copilote (${m.model})` : "Copilote"}</strong>
        <pre>${m.text}</pre>
      </article>`)}
    </div>
    <form class="agency-copilot-form" onSubmit=${(e) => { e.preventDefault(); ask(); }}>
      <input class="field" value=${question} placeholder=${t("agency.copilotPlaceholder")} onInput=${(e) => setQuestion(e.currentTarget.value)} />
      <button class="btn primary" type="submit" disabled=${busy || !question.trim()}>
        <${Icon} name="send" />${t("agency.copilotSend")}
      </button>
    </form>
  </section>`;
}
