import { BotAvatar } from "../../components/avatar.js";
import { html, Icon, Select } from "../../components/ui.js";
import { Markdown } from "../../components/markdown.js";
import { fmtNum, t } from "../../lib/i18n.js";
import { agentAvatarOf } from "./agent-avatars.js";

const enc = encodeURIComponent;
const joinMeta = (...parts) => parts.map((v) => String(v || "").trim()).filter(Boolean).join(" · ");
const AGENT_ROLES = ["prospecting", "qualification", "commercial", "estimator", "project_manager", "architect", "developer", "ui_ux", "qa_functional", "qa_technical", "qa_ui_ux", "qa_security", "retention"];
const CLI_ACTIONS = [["npm_test", "npm test"], ["npm_typecheck", "typecheck"], ["npm_build", "build"], ["git_status", "git status"], ["claude_brief", "Claude CLI"], ["codex_brief", "Codex CLI"]];

function OpsMetric({ label, value, icon, tone = "" }) {
  return html`<article class="agency-metric">
    <div class="agency-metric-top"><span class="agency-metric-label">${label}</span><span class=${"agency-metric-icon" + (tone ? " tone-" + tone : "")}><${Icon} name=${icon} size="sm"/></span></div>
    <strong class="agency-metric-value num">${typeof value === "string" ? value : fmtNum(value || 0)}</strong>
  </article>`;
}

export function AgencyOperations({
  orgId,
  cur,
  metrics,
  approvals,
  auditEvents,
  auditVerify,
  missions,
  projects,
  opsBackups,
  opsBackupNotice,
  llmUsage,
  bootstrapNotice,
  busy,
  missionFormOpen,
  setMissionFormOpen,
  missionDraft,
  setMissionDraft,
  cliActionByMission,
  setCliActionByMission,
  onOpenProspecting,
  onSwitchTab,
  onBootstrap,
  onBackup,
  onDecideApproval,
  onVerifyAudit,
  onCreateMission,
  onExecuteMission,
  onUpdateMission,
  onDeleteMission,
}) {
  return html`<div class="agency-ops-stack">
    <div class="agency-quick-strip">
      <button type="button" class="agency-quick-tile" onClick=${onOpenProspecting}>
        <span class="agency-quick-icon tone-blue"><${Icon} name="globe" size="sm"/></span>
        <strong>${t("agency.prospectSearchTitle")}</strong>
      </button>
      <button type="button" class="agency-quick-tile" onClick=${() => onSwitchTab("leads")}>
        <span class="agency-quick-icon tone-teal"><${Icon} name="user" size="sm"/></span>
        <strong>${t("agency.leads")}</strong>
      </button>
      <button type="button" class="agency-quick-tile" onClick=${() => onSwitchTab("commercial")}>
        <span class="agency-quick-icon tone-amber"><${Icon} name="banknotes" size="sm"/></span>
        <strong>${t("agency.commercial")}</strong>
      </button>
      <button type="button" class="agency-quick-tile" onClick=${() => onSwitchTab("copilot")}>
        <span class="agency-quick-icon tone-purple"><${Icon} name="spark" size="sm"/></span>
        <strong>${t("agency.copilot")}</strong>
      </button>
    </div>
    <div class="agency-commercial-actions">
      <button class="btn" type="button" disabled=${!!busy} onClick=${onBootstrap}>${busy === "bootstrap" ? t("agency.loading") : t("agency.bootstrapBtn")}</button>
      <button class="btn" type="button" disabled=${!!busy} onClick=${onBackup}>${t("agency.opsBackupBtn")}${opsBackups.length ? ` (${opsBackups.length})` : ""}</button>
      <a class="btn" target="_blank" rel="noopener noreferrer" href=${`/amb/api/agency/${enc(orgId)}/ops/export/companies.csv`}>${t("agency.opsExportCompaniesBtn")}</a>
      <a class="btn" target="_blank" rel="noopener noreferrer" href=${`/amb/api/agency/${enc(orgId)}/ops/export/leads.csv`}>${t("agency.opsExportLeadsBtn")}</a>
      ${bootstrapNotice && html`<span class="agency-research-feedback" role="status">${bootstrapNotice}</span>`}
      ${opsBackupNotice && html`<span class="agency-research-feedback" role="status">${opsBackupNotice}</span>`}
    </div>
    ${llmUsage && html`<div class="agency-prospect-synthesis">
      <div class="agency-prospect-head">
        <div><strong>${t("agency.opsLlmUsageTitle")}</strong><p>${t("agency.opsLlmCallsLabel", { calls: llmUsage.totalCalls || 0, tokens: fmtNum(llmUsage.totalTokens || 0), cost: (llmUsage.estimatedCostUsd || 0).toFixed(4) })}</p></div>
      </div>
    </div>`}
    ${metrics && html`<div class="agency-kpi-grid">
      <${OpsMetric} label=${t("agency.kpiSignedRevenue")} value=${`${fmtNum(metrics.signedRevenue)} ${cur}`.trim()} icon="banknotes" tone="green"/>
      <${OpsMetric} label=${t("agency.depositPaidLabel")} value=${`${fmtNum(metrics.collectedDeposits)} ${cur}`.trim()} icon="wallet" tone="teal"/>
      <${OpsMetric} label=${t("agency.kpiQuoteAcceptance")} value=${`${metrics.quoteAcceptanceRate}%`} icon="trend" tone="blue"/>
      <${OpsMetric} label=${t("agency.kpiQaFirstPass")} value=${`${metrics.qaFirstPassRate}%`} icon="shield" tone="purple"/>
      <${OpsMetric} label=${t("agency.kpiProjectsDelivered")} value=${metrics.projectsDelivered} icon="folder" tone="green"/>
      <${OpsMetric} label=${t("agency.approvalsTitle")} value=${metrics.pendingApprovalsCount} icon="clipboardCheck" tone="amber"/>
      <${OpsMetric} label=${t("agency.kpiOpenMissions")} value=${metrics.openMissions} icon="code" tone="blue"/>
      <${OpsMetric} label=${t("agency.kpiPendingFollowUps")} value=${metrics.pendingFollowUps} icon="user" tone="purple"/>
    </div>`}
    <div class="agency-ops-bento">
      <div class="agency-commercial-col">
        <section class="agency-project-section">
          <div class="agency-commercial-head">
            <h3>${t("agency.approvalsTitle")}</h3>
            <span class="agency-count-pill">${approvals.filter((a) => a.status === "pending").length}</span>
          </div>
          <div class="agency-commercial-list">
            ${!approvals.filter((a) => a.status === "pending").length && html`<p class="agency-muted">${t("agency.noPendingApprovals")}</p>`}
            ${approvals.filter((a) => a.status === "pending").map((ap) => html`<article class="agency-commercial-card">
              <div class="agency-commercial-head"><strong>${ap.actionType}</strong><span class="agency-whatsapp-state pending">${ap.subjectType} · ${ap.subjectId}</span></div>
              ${ap.reason && html`<small>${ap.reason}</small>`}
              <div class="agency-commercial-actions">
                <button class="btn primary" type="button" disabled=${!!busy} onClick=${() => onDecideApproval(ap.id, "approved")}>${t("agency.approveAndSend")}</button>
                <button class="text" type="button" disabled=${!!busy} onClick=${() => onDecideApproval(ap.id, "rejected")}>${t("agency.rejectBtn")}</button>
              </div>
            </article>`)}
          </div>
        </section>
        <section class="agency-project-section">
          <div class="agency-commercial-head">
            <h3>${t("agency.auditTitle")}</h3>
            <button class="btn" type="button" disabled=${!!busy} onClick=${onVerifyAudit}>${t("agency.verifyAuditBtn")}</button>
          </div>
          ${auditVerify && html`<p class="agency-research-feedback" role="status">${auditVerify.valid ? t("agency.auditValid") : t("agency.qaGateBlocked")} (${auditVerify.checkedEvents ?? auditVerify.eventsChecked ?? 0})</p>`}
          <div class="agency-commercial-list">
            ${auditEvents.slice(0, 6).map((ev) => html`<div class="agency-audit-row"><strong title=${ev.action}>${ev.action}</strong><span>${new Date(ev.createdAt).toLocaleTimeString()}</span></div>`)}
          </div>
        </section>
      </div>
      <section class="agency-project-section">
        <div class="agency-commercial-head">
          <h3>${t("agency.missionsTitle")}</h3>
          <button class="btn primary" type="button" onClick=${() => setMissionFormOpen((v) => !v)}><${Icon} name=${missionFormOpen ? "close" : "plus"} size="sm"/>${missionFormOpen ? t("agency.cancel") : t("agency.createMissionBtn")}</button>
        </div>
        ${missionFormOpen && html`<form class="agency-form agency-form-grid" onSubmit=${onCreateMission}>
          <div class="agency-field"><span>${t("agency.missionProjectLabel")}</span><${Select} label=${t("agency.missionProjectLabel")} value=${missionDraft.projectId} placeholder=${t("agency.chooseOption")} options=${[["", t("agency.chooseOption")], ...projects.map((p) => [p.id, p.title])]} onChange=${(v) => setMissionDraft((d) => ({ ...d, projectId: v }))}/></div>
          <div class="agency-field"><span>${t("agency.missionRoleLabel")}</span><${Select} label=${t("agency.missionRoleLabel")} value=${missionDraft.agentRole} options=${AGENT_ROLES.map((r) => [r, t(`agency.agentRoleNames.${r}`) || r])} onChange=${(v) => setMissionDraft((d) => ({ ...d, agentRole: v }))}/></div>
          <label class="agency-field"><span>${t("agency.missionTitle")}</span><input class="field" required value=${missionDraft.title} onInput=${(e) => setMissionDraft((d) => ({ ...d, title: e.currentTarget.value }))}/></label>
          <label class="agency-field"><span>${t("agency.missionObjective")}</span><input class="field" value=${missionDraft.objective} onInput=${(e) => setMissionDraft((d) => ({ ...d, objective: e.currentTarget.value }))}/></label>
          <label class="agency-field"><span>${t("agency.missionToolLabel")}</span><input class="field" value=${missionDraft.preferredTool} onInput=${(e) => setMissionDraft((d) => ({ ...d, preferredTool: e.currentTarget.value }))}/></label>
          <div class="agency-form-actions"><button class="btn primary" type="submit" disabled=${!!busy}>${t("agency.createMissionBtn")}</button></div>
        </form>`}
        <div class="agency-commercial-list">
          ${!missions.length && html`<p class="agency-muted">${t("agency.noMissions")}</p>`}
          ${missions.map((m) => {
            const mMeta = joinMeta(m.preferredTool, m.projectId ? (projects.find((p) => p.id === m.projectId)?.title || m.projectId) : "");
            return html`<article class="agency-commercial-card">
              <div class="agency-commercial-head"><span class="agency-agent-inline"><${BotAvatar} char=${agentAvatarOf(m.agentRole)} size=${28} state=${m.status === "running" ? "working" : "idle"}/><strong title=${`${m.title} · ${m.agentRole}`}>${m.title} · ${m.agentRole}</strong></span><span class=${"agency-whatsapp-state " + m.status}>${t(`agency.missionStatus.${m.status}`)}</span></div>
              ${mMeta && html`<small class="agency-truncate" title=${mMeta}>${mMeta}</small>`}
              ${m.outputSummary && html`<small class="agency-clamp-3" title=${m.outputSummary}><strong>${t("agency.missionOutputLabel")}:</strong> ${m.outputSummary}</small>`}
              ${m.evidencePaths?.length > 0 && html`<small><strong>${t("agency.missionEvidenceLabel")}:</strong> ${m.evidencePaths.join(", ")}</small>`}
              ${m.brief && html`<details class="agency-brief-details"><summary>${t("agency.missionBriefLabel")}</summary><div class="agency-brief-md"><${Markdown} text=${m.brief}/></div></details>`}
              <div class="agency-commercial-actions">
                <button class="btn" type="button" disabled=${!!busy} onClick=${() => onExecuteMission(m.id, "brief_export")}>${t("agency.exportBriefBtn")}</button>
                <button class="btn" type="button" disabled=${!!busy} onClick=${() => onExecuteMission(m.id, "llm_draft")}>${t("agency.executeLlmBtn")}</button>
                <${Select} block=${false} width=${180} label=${t("agency.cliActionLabel")} value=${cliActionByMission[m.id] || "npm_test"} options=${CLI_ACTIONS} onChange=${(v) => setCliActionByMission((p) => ({ ...p, [m.id]: v }))}/>
                <button class="btn" type="button" disabled=${!!busy} onClick=${() => onExecuteMission(m.id, "cli_tool", cliActionByMission[m.id] || "npm_test")}>${t("agency.runCliBtn")}</button>
                ${m.status === "planned" && html`<button class="btn" type="button" onClick=${() => onUpdateMission(m.id, "running")}>${t("agency.startMissionBtn")}</button>`}
                ${(m.status === "planned" || m.status === "running") && html`<button class="btn primary" type="button" onClick=${() => onUpdateMission(m.id, "completed")}>${t("agency.completeMissionBtn")}</button>`}
                ${m.status !== "running" && html`<button class="text agency-danger-btn" type="button" disabled=${!!busy} onClick=${() => onDeleteMission(m)}>${t("agency.deleteBtn")}</button>`}
              </div>
            </article>`;
          })}
        </div>
      </section>
    </div>
  </div>`;
}
