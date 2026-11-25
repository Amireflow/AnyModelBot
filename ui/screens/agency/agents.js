import { useEffect, useState } from "preact/hooks";
import { html, Icon, Spinner } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";

const enc = encodeURIComponent;
const AUTONOMY_MODES = ["draft_only", "supervised", "autonomous_internal"];

export function AgencyAgents({ orgId, agents = [], onSaved }) {
  const [selectedRole, setSelectedRole] = useState(agents[0]?.role || "developer");
  const [models, setModels] = useState([]);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api("/models")
      .then((res) => live && setModels(Array.isArray(res?.models) ? res.models : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!agents.length) return;
    if (!agents.some((a) => a.role === selectedRole)) {
      setSelectedRole(agents[0].role);
    }
  }, [agents]);

  const active = agents.find((a) => a.role === selectedRole) || agents[0] || null;

  useEffect(() => {
    if (!active) {
      setDraft(null);
      return;
    }
    const cfg = active.config || {};
    setDraft({
      enabled: cfg.enabled !== false,
      displayName: cfg.displayName || active.name || "",
      model: cfg.model || "",
      autonomyMode: cfg.autonomyMode || "supervised",
      maxSteps: String(cfg.maxSteps ?? 8),
      systemPrompt: cfg.systemPrompt || active.mission || "",
      rulesText: Array.isArray(cfg.rules) ? cfg.rules.join("\n") : "",
      toolsText: Array.isArray(cfg.allowedTools) ? cfg.allowedTools.join(", ") : (active.defaultTools || []).join(", "),
    });
    setNotice("");
    setError("");
  }, [active?.role, active?.config?.updatedAt]);

  const saveConfig = async (e) => {
    e.preventDefault();
    if (!orgId || !active || !draft) return;
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const rules = draft.rulesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const allowedTools = draft.toolsText.split(",").map((s) => s.trim()).filter(Boolean);
      await api(`/agency/${enc(orgId)}/agents/${enc(active.role)}`, {
        method: "PUT",
        body: {
          enabled: !!draft.enabled,
          displayName: draft.displayName.trim() || active.name,
          model: draft.model.trim(),
          autonomyMode: draft.autonomyMode,
          maxSteps: Number(draft.maxSteps || 8),
          systemPrompt: draft.systemPrompt,
          rules,
          allowedTools,
        },
      });
      setNotice(t("agency.agentSavedNotice"));
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const resetConfig = async () => {
    if (!orgId || !active) return;
    setBusy("reset");
    setError("");
    setNotice("");
    try {
      await api(`/agency/${enc(orgId)}/agents/${enc(active.role)}`, { method: "DELETE" });
      setNotice(t("agency.agentSavedNotice"));
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  return html`<div class="agency-content-grid agency-agents-grid">
    <section class="agency-project-section">
      <div class="agency-commercial-head">
        <h2>${t("agency.agentsTitle")}</h2>
        <span class="agency-count-pill">${agents.length}</span>
      </div>
      <div class="agency-commercial-list">
        ${agents.map((ag) => {
          const enabled = ag.config?.enabled !== false;
          const isSelected = active?.role === ag.role;
          return html`<button type="button" class=${"agency-agent-row" + (isSelected ? " selected" : "")} onClick=${() => setSelectedRole(ag.role)}>
            <div class="agency-agent-row-main">
              <span class=${"agency-dot " + (enabled ? "ok" : "off")}></span>
              <span class="agency-company-meta">
                <strong>${t(`agency.agentRoleNames.${ag.role}`)}</strong>
                <small>${ag.config?.model || t("agency.agentModelDefault")}</small>
              </span>
            </div>
            <div class="agency-commercial-actions">
              ${ag.customized && html`<span class="agency-whatsapp-state accepted">${t("agency.agentCustomized")}</span>`}
              <span class="agency-whatsapp-state">${ag.independentFromBuild ? t("agency.agentIndependentQa") : t("agency.agentBuildRole")}</span>
            </div>
          </button>`;
        })}
      </div>
    </section>

    ${active && draft && html`<section class="agency-detail agency-agent-editor">
      <div class="agency-detail-head">
        <div>
          <span class="agency-eyebrow">${active.role}</span>
          <h2>${t(`agency.agentRoleNames.${active.role}`)}</h2>
        </div>
        <span class=${"agency-whatsapp-state " + (draft.enabled ? "accepted" : "blocked")}>
          ${draft.enabled ? t("agency.agentEnabled") : t("agency.agentDisabled")}
        </span>
      </div>
      ${error && html`<div class="agency-alert" role="alert">${error}</div>`}
      ${notice && html`<p class="agency-research-feedback" role="status">${notice}</p>`}
      <form class="agency-form agency-form-grid" onSubmit=${saveConfig}>
        <label class="agency-qualification-checkbox agency-form-wide">
          <input type="checkbox" checked=${draft.enabled} onChange=${(e) => setDraft((d) => ({ ...d, enabled: e.currentTarget.checked }))} />
          <span>${draft.enabled ? t("agency.agentEnabled") : t("agency.agentDisabled")}</span>
        </label>
        <label class="agency-field">
          <span>${t("agency.agentModelLabel")}</span>
          <select class="field" value=${draft.model} onChange=${(e) => setDraft((d) => ({ ...d, model: e.currentTarget.value }))}>
            <option value="">${t("agency.agentModelDefault")}</option>
            ${models.map((m) => html`<option value=${m}>${m}</option>`)}
          </select>
        </label>
        <label class="agency-field">
          <span>${t("agency.agentAutonomyLabel")}</span>
          <select class="field" value=${draft.autonomyMode} onChange=${(e) => setDraft((d) => ({ ...d, autonomyMode: e.currentTarget.value }))}>
            ${AUTONOMY_MODES.map((mode) => html`<option value=${mode}>${t(`agency.agentAutonomy.${mode}`)}</option>`)}
          </select>
        </label>
        <label class="agency-field">
          <span>${t("agency.agentMaxStepsLabel")}</span>
          <input class="field" type="number" min="1" max="20" value=${draft.maxSteps} onInput=${(e) => setDraft((d) => ({ ...d, maxSteps: e.currentTarget.value }))} />
        </label>
        <label class="agency-field">
          <span>${t("agency.agentToolsLabel")}</span>
          <input class="field" value=${draft.toolsText} onInput=${(e) => setDraft((d) => ({ ...d, toolsText: e.currentTarget.value }))} />
        </label>
        <label class="agency-field agency-form-wide">
          <span>${t("agency.agentPromptLabel")}</span>
          <textarea class="field" rows="3" value=${draft.systemPrompt} onInput=${(e) => setDraft((d) => ({ ...d, systemPrompt: e.currentTarget.value }))}></textarea>
        </label>
        <label class="agency-field agency-form-wide">
          <span>${t("agency.agentRulesLabel")}</span>
          <textarea class="field" rows="4" value=${draft.rulesText} onInput=${(e) => setDraft((d) => ({ ...d, rulesText: e.currentTarget.value }))}></textarea>
        </label>
        <p class="agency-muted agency-form-wide"><${Icon} name="shield" size="sm" /> ${t("agency.agentGuardrailsNote")}</p>
        <div class="agency-form-actions">
          ${active.customized && html`<button class="btn" type="button" disabled=${!!busy} onClick=${resetConfig}>${t("agency.agentResetBtn")}</button>`}
          <button class="btn primary" type="submit" disabled=${!!busy}>
            ${busy === "save" ? html`<${Spinner} />` : null}${t("agency.agentSaveBtn")}
          </button>
        </div>
      </form>
    </section>`}
  </div>`;
}
