import type { Company, Contract, Organization, Project, ProjectDelivery, ProjectLot, QaCheck, Quote } from "./types.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMoney(amount: number, currency: string): string {
  const safeCurrency = escapeHtml(currency || "XOF");
  const num = Number.isFinite(amount) ? amount : 0;
  return `${num.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${safeCurrency}`;
}

function formatDate(ts: number, lang = "fr"): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const locale = lang.startsWith("en") ? "en-US" : "fr-FR";
  return new Date(ts).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

function baseDocumentShell(title: string, bannerHtml: string, bodyHtml: string, lang = "fr"): string {
  const docLang = lang.startsWith("en") ? "en" : "fr";
  return `<!DOCTYPE html>
<html lang="${escapeHtml(docLang)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #111827;
      --muted: #4b5563;
      --line: #e5e7eb;
      --panel: #f9fafb;
      --warn-bg: #fef3c7;
      --warn-ink: #92400e;
      --ok-bg: #dcfce7;
      --ok-ink: #166534;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--ink);
      background: #ffffff;
      line-height: 1.5;
    }
    .sheet {
      max-width: 860px;
      margin: 0 auto;
    }
    .banner {
      padding: 10px 14px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.03em;
      margin-bottom: 24px;
      background: var(--warn-bg);
      color: var(--warn-ink);
    }
    .banner.signed {
      background: var(--ok-bg);
      color: var(--ok-ink);
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--line);
      margin-bottom: 24px;
    }
    h1 { margin: 0 0 6px; font-size: 24px; }
    h2 { margin: 24px 0 10px; font-size: 16px; }
    p { margin: 4px 0; color: var(--muted); }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--panel);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .card strong { display: block; margin-bottom: 4px; font-size: 14px; }
    .card small { display: block; color: var(--muted); font-size: 12px; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      font-size: 14px;
    }
    th {
      background: var(--panel);
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
    }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .totals {
      margin-top: 16px;
      margin-left: auto;
      width: min(340px, 100%);
      background: var(--panel);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .totals-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 4px 0;
      font-size: 14px;
    }
    .totals-row.grand {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--line);
      font-weight: 700;
      font-size: 16px;
    }
    ul { margin: 8px 0 0; padding-left: 20px; }
    li { margin: 4px 0; font-size: 14px; }
    .signatures {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 24px;
      margin-top: 36px;
    }
    .sig-box {
      padding: 16px;
      border-radius: 8px;
      background: var(--panel);
      min-height: 96px;
    }
    footer {
      margin-top: 32px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    @media print {
      @page { margin: 14mm; }
      body { padding: 0; }
      .print-hint { display: none; }
    }
  </style>
</head>
<body>
  <main class="sheet">
    ${bannerHtml}
    ${bodyHtml}
    <footer class="print-hint">
      <span>${escapeHtml(docLang === "en" ? "Use browser Print (Ctrl+P / Cmd+P) to save as PDF." : "Utilisez Imprimer (Ctrl+P / Cmd+P) pour enregistrer en PDF.")}</span>
    </footer>
  </main>
</body>
</html>`;
}

export function renderQuoteDocumentHtml(input: {
  organization: Organization;
  company?: Company;
  quote: Quote;
  lang?: string;
}): string {
  const { organization, company, quote, lang = "fr" } = input;
  const en = lang.startsWith("en");
  const isFinal = quote.status === "accepted" || quote.status === "sent";
  const bannerLabel = isFinal
    ? `${en ? "QUOTE STATUS" : "STATUT DU DEVIS"} : ${quote.status.toUpperCase()}`
    : quote.status === "pending_approval"
      ? (en ? "DRAFT QUOTE — PENDING OWNER APPROVAL" : "PROJET DE DEVIS — EN ATTENTE D'APPROBATION")
      : (en ? "DRAFT QUOTE — NOT VALIDATED" : "BROUILLON — NON VALIDÉ");

  const bannerHtml = `<div class="banner${quote.status === "accepted" ? " signed" : ""}">${escapeHtml(bannerLabel)}</div>`;

  const linesHtml = quote.lines
    .map((line) => {
      const lineTotal = Math.round((line.quantity * line.unitPrice + Number.EPSILON) * 100) / 100;
      return `<tr>
        <td>
          <strong>${escapeHtml(line.label)}</strong>
          ${line.description ? `<br /><small>${escapeHtml(line.description)}</small>` : ""}
        </td>
        <td class="num">${escapeHtml(line.quantity)}</td>
        <td class="num">${formatMoney(line.unitPrice, quote.currency)}</td>
        <td class="num">${escapeHtml(line.estimatedDays)} ${en ? "d" : "j"}</td>
        <td class="num">${formatMoney(lineTotal, quote.currency)}</td>
      </tr>`;
    })
    .join("\n");

  const exclusionsHtml = quote.exclusions.length
    ? `<h2>${en ? "Exclusions" : "Exclusions de périmètre"}</h2>
       <ul>${quote.exclusions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";

  const bodyHtml = `
    <header>
      <div>
        <h1>${escapeHtml(quote.title)}</h1>
        <p>${en ? "Quote" : "Devis"} <code>${escapeHtml(quote.id)}</code> · v${escapeHtml(quote.version)} · ${escapeHtml(quote.tier)}</p>
      </div>
      <div style="text-align:right">
        <strong>${escapeHtml(organization.name)}</strong>
        <p>${escapeHtml(organization.countryCode)} · ${escapeHtml(quote.currency)}</p>
        <p>${en ? "Valid until" : "Valable jusqu'au"} : ${escapeHtml(formatDate(quote.validUntil, lang))}</p>
      </div>
    </header>
    <section class="meta-grid">
      <div class="card">
        <strong>${en ? "Prepared by" : "Émetteur"}</strong>
        <small>${escapeHtml(organization.name)}</small>
        <small>${en ? "Created" : "Émis le"} : ${escapeHtml(formatDate(quote.createdAt, lang))}</small>
      </div>
      <div class="card">
        <strong>${en ? "Client" : "Client"}</strong>
        <small>${escapeHtml(company?.name || quote.leadId)}</small>
        ${company ? `<small>${escapeHtml([company.industry, company.city, company.website].filter(Boolean).join(" · ") || "—")}</small>` : ""}
      </div>
    </section>
    <h2>${en ? "Scope & Line Items" : "Prestations détaillées"}</h2>
    <table>
      <thead>
        <tr>
          <th>${en ? "Item" : "Prestation"}</th>
          <th class="num">${en ? "Qty" : "Qté"}</th>
          <th class="num">${en ? "Unit price" : "Prix unit."}</th>
          <th class="num">${en ? "Days" : "Délai"}</th>
          <th class="num">${en ? "Total" : "Total"}</th>
        </tr>
      </thead>
      <tbody>${linesHtml}</tbody>
    </table>
    <section class="totals">
      <div class="totals-row"><span>${en ? "Subtotal" : "Sous-total"}</span><span>${formatMoney(quote.subtotal, quote.currency)}</span></div>
      ${quote.discountPct > 0 ? `<div class="totals-row"><span>${en ? "Discount" : "Remise"} (${escapeHtml(quote.discountPct)}%)</span><span>-${formatMoney(quote.discountAmount, quote.currency)}</span></div>` : ""}
      <div class="totals-row grand"><span>${en ? "Net total" : "Total net"}</span><span>${formatMoney(quote.netTotal, quote.currency)}</span></div>
      <div class="totals-row"><span>${en ? "Estimated delivery" : "Délai estimé"}</span><span>${escapeHtml(quote.deliveryDays)} ${en ? "days" : "jours"}</span></div>
    </section>
    <h2>${en ? "Payment Terms" : "Conditions de paiement"}</h2>
    <p>${escapeHtml(quote.paymentTerms || (en ? "Standard agency terms" : "Conditions standards de l'agence"))}</p>
    ${exclusionsHtml}
    <footer>
      <span>${escapeHtml(organization.name)} · ${escapeHtml(quote.id)}</span>
      <span>${en ? "Status" : "Statut"} : ${escapeHtml(quote.status)}</span>
    </footer>
  `;

  return baseDocumentShell(`${quote.title} — ${quote.id}`, bannerHtml, bodyHtml, lang);
}

export function renderContractDocumentHtml(input: {
  organization: Organization;
  company?: Company;
  contract: Contract;
  quote?: Quote;
  lang?: string;
}): string {
  const { organization, company, contract, quote, lang = "fr" } = input;
  const en = lang.startsWith("en");
  const isSigned = contract.status === "signed";
  const bannerLabel = isSigned
    ? `${en ? "SIGNED CONTRACT" : "CONTRAT SIGNÉ"} — ${formatDate(contract.signedAt, lang)}`
    : `${en ? "DRAFT CONTRACT — NOT SIGNED" : "PROJET DE CONTRAT — NON SIGNÉ"} (${contract.status.toUpperCase()})`;

  const bannerHtml = `<div class="banner${isSigned ? " signed" : ""}">${escapeHtml(bannerLabel)}</div>`;

  const deliverablesHtml = contract.deliverables.length
    ? `<h2>${en ? "Contract Deliverables" : "Livrables contractuels"}</h2>
       <ul>${contract.deliverables.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";

  const bodyHtml = `
    <header>
      <div>
        <h1>${escapeHtml(contract.title)}</h1>
        <p>${en ? "Contract" : "Contrat"} <code>${escapeHtml(contract.id)}</code>${quote ? ` · ${en ? "Quote" : "Devis"} ${escapeHtml(quote.id)} v${escapeHtml(quote.version)}` : ""}</p>
      </div>
      <div style="text-align:right">
        <strong>${escapeHtml(organization.name)}</strong>
        <p>${escapeHtml(organization.countryCode)} · ${escapeHtml(contract.currency)}</p>
        ${isSigned && contract.signedAt > 0 ? `<p>${en ? "Signed on" : "Signé le"} : ${escapeHtml(formatDate(contract.signedAt, lang))}</p>` : ""}
      </div>
    </header>
    <section class="meta-grid">
      <div class="card">
        <strong>${en ? "Service Provider" : "Prestataire"}</strong>
        <small>${escapeHtml(organization.name)}</small>
        <small>${en ? "Created" : "Créé le"} : ${escapeHtml(formatDate(contract.createdAt, lang))}</small>
      </div>
      <div class="card">
        <strong>${en ? "Client" : "Client"}</strong>
        <small>${escapeHtml(company?.name || contract.leadId)}</small>
        ${company ? `<small>${escapeHtml([company.industry, company.city, company.website].filter(Boolean).join(" · ") || "—")}</small>` : ""}
      </div>
    </section>
    <h2>${en ? "Scope Summary" : "Objet et périmètre"}</h2>
    <p>${escapeHtml(contract.scopeSummary || "—")}</p>
    ${deliverablesHtml}
    <h2>${en ? "Financial Terms & Deposit" : "Conditions financières et acompte"}</h2>
    <section class="totals" style="margin-left:0;width:100%">
      <div class="totals-row"><span>${en ? "Contract Total" : "Montant total"}</span><span>${formatMoney(contract.totalAmount, contract.currency)}</span></div>
      <div class="totals-row"><span>${en ? "Deposit Amount" : "Acompte"}</span><span>${formatMoney(contract.depositAmount, contract.currency)}</span></div>
      <div class="totals-row"><span>${en ? "Deposit Status" : "Statut de l'acompte"}</span><span>${escapeHtml(contract.depositStatus === "paid" ? (en ? "Paid" : "Payé") : (en ? "Unpaid" : "Non payé"))}${contract.depositReference ? ` (${escapeHtml(contract.depositReference)})` : ""}</span></div>
      <div class="totals-row"><span>${en ? "Payment Schedule" : "Modalités"}</span><span>${escapeHtml(contract.paymentTerms || "—")}</span></div>
    </section>
    <section class="signatures">
      <div class="sig-box">
        <strong>${escapeHtml(organization.name)}</strong>
        <p>${isSigned ? (en ? "Signed and approved" : "Signé et approuvé") : (en ? "Signature pending" : "En attente de signature")}</p>
      </div>
      <div class="sig-box">
        <strong>${escapeHtml(company?.name || (en ? "Client" : "Client"))}</strong>
        <p>${isSigned ? `${en ? "Signed on" : "Signé le"} ${escapeHtml(formatDate(contract.signedAt, lang))}` : (en ? "Signature pending" : "En attente de signature")}</p>
      </div>
    </section>
    <footer>
      <span>${escapeHtml(organization.name)} · ${escapeHtml(contract.id)}</span>
      <span>${en ? "Status" : "Statut"} : ${escapeHtml(contract.status)}</span>
    </footer>
  `;

  return baseDocumentShell(`${contract.title} — ${contract.id}`, bannerHtml, bodyHtml, lang);
}

export function renderDeliveryReportHtml(input: {
  organization: Organization;
  company?: Company;
  project: Project;
  contract?: Contract;
  lots: readonly ProjectLot[];
  qaChecks: readonly QaCheck[];
  deliveries: readonly ProjectDelivery[];
  lang?: string;
}): string {
  const { organization, company, project, contract, lots, qaChecks, deliveries, lang = "fr" } = input;
  const en = lang.startsWith("en");
  const latest = deliveries[0];
  const isAccepted = project.status === "accepted" || project.status === "maintenance" || latest?.status === "accepted";
  const bannerLabel = isAccepted
    ? (en ? "CLIENT DELIVERY REPORT — ACCEPTED" : "RAPPORT DE LIVRAISON CLIENT — VALIDÉ")
    : `${en ? "CLIENT DELIVERY REPORT" : "RAPPORT DE LIVRAISON CLIENT"} — ${project.status.toUpperCase()}`;
  const bannerHtml = `<div class="banner${isAccepted ? " signed" : ""}">${escapeHtml(bannerLabel)}</div>`;

  const lotsHtml = lots.length
    ? lots.map((lot) => `<tr>
        <td><strong>#${escapeHtml(lot.lotOrder)} · ${escapeHtml(lot.title)}</strong>${lot.description ? `<br /><small>${escapeHtml(lot.description)}</small>` : ""}</td>
        <td>${escapeHtml(lot.ownerRole)}</td>
        <td>${escapeHtml(lot.status)}</td>
        <td>${escapeHtml(lot.evidenceSummary || "—")}</td>
      </tr>`).join("\n")
    : `<tr><td colspan="4">${en ? "No project lots recorded." : "Aucun lot enregistré."}</td></tr>`;

  const qaHtml = qaChecks.length
    ? qaChecks.map((check) => `<tr>
        <td>${escapeHtml(check.category)}</td>
        <td><strong>${escapeHtml(check.title)}</strong>${check.findings ? `<br /><small>${escapeHtml(check.findings)}</small>` : ""}</td>
        <td>${escapeHtml(check.status)}</td>
        <td>${escapeHtml(check.evidence || "—")}</td>
      </tr>`).join("\n")
    : `<tr><td colspan="4">${en ? "No QA checks recorded." : "Aucun contrôle QA enregistré."}</td></tr>`;

  const deliveriesHtml = deliveries.length
    ? `<h2>${en ? "Release History" : "Historique des livraisons"}</h2>
       <ul>${deliveries.map((d) => `<li><strong>v${escapeHtml(d.version)}</strong> (${escapeHtml(d.status)}) — ${escapeHtml(d.environmentUrl || "workspace")}${d.releaseNotes ? ` : ${escapeHtml(d.releaseNotes)}` : ""}${d.clientFeedback ? ` · ${en ? "Feedback" : "Retour"} : ${escapeHtml(d.clientFeedback)}` : ""}</li>`).join("")}</ul>`
    : "";

  const bodyHtml = `
    <header>
      <div>
        <h1>${escapeHtml(project.title)}</h1>
        <p>${en ? "Project" : "Projet"} <code>${escapeHtml(project.id)}</code> · ${escapeHtml(project.targetStack.join(", ") || "standard")}</p>
      </div>
      <div style="text-align:right">
        <strong>${escapeHtml(organization.name)}</strong>
        <p>${formatMoney(project.budgetAmount, project.currency)} · ${escapeHtml(project.estimatedDays)} ${en ? "d" : "j"}</p>
        ${latest?.environmentUrl ? `<p>${escapeHtml(latest.environmentUrl)}</p>` : ""}
      </div>
    </header>
    <section class="meta-grid">
      <div class="card">
        <strong>${en ? "Agency" : "Agence"}</strong>
        <small>${escapeHtml(organization.name)}</small>
        <small>${en ? "Handoff" : "Démarrage"} : ${escapeHtml(formatDate(project.handoffAt, lang))}</small>
      </div>
      <div class="card">
        <strong>${en ? "Client" : "Client"}</strong>
        <small>${escapeHtml(company?.name || project.leadId)}</small>
        ${contract ? `<small>${en ? "Contract" : "Contrat"} : ${escapeHtml(contract.id)}</small>` : ""}
      </div>
    </section>
    <h2>${en ? "Scope & Technical Summary" : "Périmètre et spécifications"}</h2>
    <p>${escapeHtml(project.technicalSpecs || contract?.scopeSummary || "—")}</p>
    <h2>${en ? "Verified Lots" : "Lots réalisés"}</h2>
    <table>
      <thead><tr><th>${en ? "Lot" : "Lot"}</th><th>${en ? "Role" : "Rôle"}</th><th>${en ? "Status" : "Statut"}</th><th>${en ? "Evidence" : "Preuve"}</th></tr></thead>
      <tbody>${lotsHtml}</tbody>
    </table>
    <h2>${en ? "4-Axis QA Verification" : "Contrôle qualité 4 axes"}</h2>
    <table>
      <thead><tr><th>${en ? "Axis" : "Axe"}</th><th>${en ? "Check" : "Contrôle"}</th><th>${en ? "Result" : "Résultat"}</th><th>${en ? "Evidence" : "Preuve"}</th></tr></thead>
      <tbody>${qaHtml}</tbody>
    </table>
    ${deliveriesHtml}
    <footer>
      <span>${escapeHtml(organization.name)} · ${escapeHtml(project.id)}</span>
      <span>${en ? "Status" : "Statut"} : ${escapeHtml(project.status)}</span>
    </footer>
  `;

  return baseDocumentShell(`${en ? "Delivery Report" : "Rapport de livraison"} — ${project.title}`, bannerHtml, bodyHtml, lang);
}
