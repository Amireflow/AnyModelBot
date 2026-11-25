import { useEffect, useState } from "preact/hooks";
import { BotAvatar } from "../../components/avatar.js";
import { Checkbox, html, Icon, Select, Spinner, Switch } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";
import { agentAvatarOf } from "./agent-avatars.js";

const enc = encodeURIComponent;
const AUTONOMY_MODES = ["draft_only", "supervised", "autonomous_internal"];

export function AgencyAgents({ orgId, agents = [], onSaved }) {
  const [selectedRole, setSelectedRole] = useState(agents[0]?.role || "developer");
  const [models, setModels] = useState([]);
  const [skillsCatalog, setSkillsCatalog] = useState([]);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [avatarCue, setAvatarCue] = useState(null);

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
    if (!orgId) return;
    let live = true;
    api(`/agency/${enc(orgId)}/skills`)
      .then((res) => live && setSkillsCatalog(Array.isArray(res?.items) ? res.items : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [orgId]);

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
      skills: Array.isArray(cfg.skills) ? cfg.skills : [],
      toolsText: Array.isArray(cfg.allowedTools) ? cfg.allowedTools.join(", ") : (active.defaultTools || []).join(", "),
    });
    setNotice("");
    setError("");
  }, [active?.role, active?.config?.updatedAt]);

  const toggleSkill = (slug) => {
    setDraft((d) => {
      if (!d) return d;
      const exists = d.skills.includes(slug);
      return { ...d, skills: exists ? d.skills.filter((s) => s !== slug) : [...d.skills, slug] };
    });
  };

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
          skills: draft.skills,
          allowedTools,
        },
      });
      setNotice(t("agency.agentSavedNotice"));
      setAvatarCue({ kind: "done", at: Date.now() });
      onSaved?.();
    } catch (err) {
      setError(err.message);
      setAvatarCue({ kind: "error", at: Date.now() });
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
      setAvatarCue({ kind: "done", at: Date.now() });
      onSaved?.();
    } catch (err) {
      setError(err.message);
      setAvatarCue({ kind: "error", at: Date.now() });
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
          return html`<button type="button" class=${"agency-agent-row bot-hover" + (isSelected ? " selected" : "")} onClick=${() => setSelectedRole(ag.role)}>
            <div class="agency-agent-row-main">
              <span class="agency-agent-avatar-wrap">
                <${BotAvatar} char=${agentAvatarOf(ag.role)} size=${36} state=${enabled ? (isSelected ? "listening" : "idle") : "sleep"} />
                <span class=${"agency-agent-status-dot " + (enabled ? "ok" : "off")} aria-hidden="true"></span>
              </span>
              <span class="agency-company-meta">
                <strong class="agency-truncate" title=${t(`agency.agentRoleNames.${ag.role}`)}>${t(`agency.agentRoleNames.${ag.role}`)}</strong>
                <small class="agency-truncate" title=${ag.config?.model || t("agency.agentModelDefault")}>${ag.config?.model || t("agency.agentModelDefault")}</small>
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
        <div class="agency-agent-hero">
          <${BotAvatar} key=${active.role} char=${agentAvatarOf(active.role)} size=${60} state=${draft.enabled ? (busy ? "working" : "listening") : "sleep"} cue=${avatarCue} lively pokeable greet />
          <div>
            <span class="agency-eyebrow">${active.role}</span>
            <h2>${t(`agency.agentRoleNames.${active.role}`)}</h2>
          </div>
        </div>
        <span class=${"agency-whatsapp-state " + (draft.enabled ? "accepted" : "blocked")}>
          ${draft.enabled ? t("agency.agentEnabled") : t("agency.agentDisabled")}
        </span>
      </div>
      ${error && html`<div class="agency-alert" role="alert">${error}</div>`}
      ${notice && html`<p class="agency-research-feedback" role="status">${notice}</p>`}
      <form class="agency-form agency-form-grid" onSubmit=${saveConfig}>
        <div class="agency-qualification-checkbox agency-form-wide">
          <${Switch} value=${draft.enabled} label=${draft.enabled ? t("agency.agentEnabled") : t("agency.agentDisabled")} onChange=${(v) => setDraft((d) => ({ ...d, enabled: v }))} />
          <span>${draft.enabled ? t("agency.agentEnabled") : t("agency.agentDisabled")}</span>
        </div>
        <div class="agency-field">
          <span>${t("agency.agentModelLabel")}</span>
          <${Select}
            label=${t("agency.agentModelLabel")}
            value=${draft.model}
            searchable
            options=${[["", t("agency.agentModelDefault")], ...models.map((m) => [m, m])]}
            onChange=${(v) => setDraft((d) => ({ ...d, model: v }))}
          />
        </div>
        <div class="agency-field">
          <span>${t("agency.agentAutonomyLabel")}</span>
          <${Select}
            label=${t("agency.agentAutonomyLabel")}
            value=${draft.autonomyMode}
            options=${AUTONOMY_MODES.map((mode) => [mode, t(`agency.agentAutonomy.${mode}`)])}
            onChange=${(v) => setDraft((d) => ({ ...d, autonomyMode: v }))}
          />
        </div>
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
        ${skillsCatalog.length > 0 && html`<div class="agency-field agency-form-wide">
          <span>${t("agency.agentSkillsLabel")} (${draft.skills.length})</span>
          <div class="agency-skills-grid">
            ${skillsCatalog.map((sk) => html`<div key=${sk.slug} class=${"agency-skill-check" + (draft.skills.includes(sk.slug) ? " selected" : "")}>
              <${Checkbox}
                checked=${draft.skills.includes(sk.slug)}
                label=${html`<strong>${sk.name}</strong>`}
                sub=${html`<span class="agency-clamp-2" title=${sk.description}>${sk.description}</span>`}
                onChange=${() => toggleSkill(sk.slug)}
              />
            </div>`)}
          </div>
        </div>`}
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
