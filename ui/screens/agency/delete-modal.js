import { useEffect, useState } from "preact/hooks";
import { Checkbox, html, Icon, Sheet, Spinner } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";

const enc = encodeURIComponent;

const ENTITY_SEGMENTS = {
  company: "companies",
  contact: "contacts",
  lead: "leads",
  evidence: "evidence",
  quote: "quotes",
  catalog_item: "catalog",
  mission: "missions",
  followup: "followups",
};

export function SecureDeleteModal({ orgId, target, onClose, onDeleted, onArchive }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [cascadeChecked, setCascadeChecked] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!orgId || !target?.entityType || !target?.entityId) return;
    let live = true;
    const segment = ENTITY_SEGMENTS[target.entityType];
    setLoading(true);
    setError("");
    setPreview(null);
    setConfirmName("");
    setCascadeChecked(false);
    setReason("");
    api(`/agency/${enc(orgId)}/${segment}/${enc(target.entityId)}/delete-preview`)
      .then((res) => {
        if (!live) return;
        setPreview(res.preview || null);
      })
      .catch((err) => {
        if (!live) return;
        setError(err.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [orgId, target?.entityType, target?.entityId]);

  if (!target) return null;

  const willDelete = preview?.willDelete || {};
  const impactItems = [
    ["contacts", t("agency.deleteCountContacts")],
    ["leads", t("agency.deleteCountLeads")],
    ["evidence", t("agency.deleteCountEvidence")],
    ["conversations", t("agency.deleteCountConversations")],
    ["messages", t("agency.deleteCountMessages")],
    ["quotes", t("agency.deleteCountQuotes")],
    ["needs", t("agency.deleteCountNeeds")],
  ].filter(([k]) => Number(willDelete[k] || 0) > 0);
  const hasLinkedDeletes = impactItems.length > 0;

  const nameMatch = !preview?.requiresNameConfirmation
    || confirmName.trim().toLowerCase() === String(preview.confirmationTarget || "").trim().toLowerCase();
  const cascadeReady = !hasLinkedDeletes || cascadeChecked;
  const canConfirm = Boolean(preview?.canDelete && nameMatch && cascadeReady && !busy && !loading);

  const confirmDelete = async (e) => {
    e.preventDefault();
    if (!canConfirm) return;
    const segment = ENTITY_SEGMENTS[target.entityType];
    setBusy(true);
    setError("");
    try {
      await api(`/agency/${enc(orgId)}/${segment}/${enc(target.entityId)}`, {
        method: "DELETE",
        body: {
          confirm: true,
          confirmName: preview.requiresNameConfirmation ? confirmName.trim() : undefined,
          cascade: hasLinkedDeletes,
          reason: reason.trim() || undefined,
        },
      });
      onDeleted?.(target);
      onClose?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async () => {
    if (!onArchive || busy) return;
    setBusy(true);
    setError("");
    try {
      await onArchive(target);
      onClose?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return html`<${Sheet} title=${t("agency.deleteModalTitle")} onClose=${onClose} sticky>
    <div class="agency-delete-modal">
      <div class="agency-delete-target">
        <span class="agency-whatsapp-state">${t(`agency.deleteEntityTypes.${target.entityType}`)}</span>
        <strong>${preview?.label || target.label || target.entityId}</strong>
      </div>

      ${loading && html`<div class="agency-loading"><${Spinner} />${t("agency.loading")}</div>`}
      ${error && html`<div class="agency-alert" role="alert">${error}</div>`}

      ${!loading && preview && !preview.canDelete && html`
        <div class="agency-delete-blockers">
          <strong><${Icon} name="shield" size="sm" /> ${t("agency.deleteBlockedTitle")}</strong>
          <p>${t("agency.deleteBlockedHint")}</p>
          <ul>${(preview.blockers || []).map((b) => html`<li>${b}</li>`)}</ul>
        </div>
        <div class="agency-form-actions">
          <button class="btn" type="button" data-autofocus onClick=${onClose}>${t("agency.cancel")}</button>
          ${preview.recommendArchive && onArchive && html`
            <button class="btn primary" type="button" disabled=${busy} onClick=${handleArchive}>
              ${busy ? html`<${Spinner} />` : null}${t("agency.deleteArchiveInsteadBtn")}
            </button>
          `}
        </div>
      `}

      ${!loading && preview && preview.canDelete && html`
        <form class="agency-form" onSubmit=${confirmDelete}>
          <div class="agency-delete-warning">
            <${Icon} name="shield" size="sm" />
            <span>${t("agency.deleteIrreversibleWarning")}</span>
          </div>

          ${hasLinkedDeletes && html`
            <div class="agency-delete-impact">
              <strong>${t("agency.deleteImpactTitle")}</strong>
              <ul>
                ${impactItems.map(([k, label]) => html`<li><span>${label}</span><strong>${willDelete[k]}</strong></li>`)}
              </ul>
            </div>
            <${Checkbox}
              class="agency-qualification-checkbox"
              checked=${cascadeChecked}
              label=${t("agency.deleteCascadeLabel")}
              onChange=${(v) => setCascadeChecked(v)}
            />
          `}

          ${preview.requiresNameConfirmation && html`
            <label class="agency-field">
              <span>${t("agency.deleteTypeNamePrompt", { name: preview.confirmationTarget })}</span>
              <input class="field" type="text" required value=${confirmName} placeholder=${preview.confirmationTarget} onInput=${(e) => setConfirmName(e.currentTarget.value)} />
            </label>
          `}

          <label class="agency-field">
            <span>${t("agency.deleteReasonLabel")}</span>
            <input class="field" type="text" value=${reason} placeholder=${t("agency.deleteReasonPlaceholder")} onInput=${(e) => setReason(e.currentTarget.value)} />
          </label>

          <div class="agency-form-actions">
            <button class="btn" type="button" data-autofocus disabled=${busy} onClick=${onClose}>${t("agency.cancel")}</button>
            <button class="btn danger" type="submit" disabled=${!canConfirm}>
              ${busy ? html`<${Spinner} />` : null}${t("agency.deleteConfirmBtn")}
            </button>
          </div>
        </form>
      `}
    </div>
  </${Sheet}>`;
}
