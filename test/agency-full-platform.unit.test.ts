import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgencyService,
  AgencyStore,
  auditWebsiteSafely,
  buildProjectZipArchive,
  isPrivateOrReservedIp,
  prospectWebCompanies,
  runAgencyCopilot,
  runFourAxisQaAudit,
  runStudioAiAgent,
  scaffoldProjectTemplate,
  writeWorkspaceFile,
  readWorkspaceFile,
  deleteWorkspaceFile,
  listWorkspaceFiles,
  resolveStudioPreviewAsset,
} from "../src/agency/index.js";
import { agencyRoutes } from "../src/web/routes/agency.js";
import { HttpError, type WebContext } from "../src/web/http.js";
import type { ModelClient } from "../src/llm/client.js";
import type { EmailSender } from "../src/agency/email-outbox.js";

describe("AnyModelBot Full Agency Platform (Phases 1-6)", () => {
  let tmpDir: string;
  let store: AgencyStore;
  let sentEmails: Array<{ to: string; subject: string; text: string }>;
  let service: AgencyService;
  let orgId: string;

  beforeEach(() => {
    let seq = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-full-platform-"));
    store = new AgencyStore(":memory:");
    sentEmails = [];
    const mockEmailSender: EmailSender = {
      async isConfigured() {
        return true;
      },
      async sendEmail(msg) {
        sentEmails.push({ to: msg.recipient, subject: msg.subject, text: msg.bodyText });
        return { providerMessageId: `smtp-${sentEmails.length}` };
      },
    };
    service = new AgencyService(store, {
      now: () => 1_850_000_000_000 + ++seq,
      id: () => `fp-${++seq}`,
      email: mockEmailSender,
    });
    orgId = service.createOrganization({ name: "Amireflow Studio", currency: "EUR" }, "local-owner").id;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("blocks SSRF private/loopback targets and allows public website audits", async () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.0.0.5")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.10")).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);

    await expect(
      auditWebsiteSafely({
        url: "http://127.0.0.1:3600/secret",
        lookup: async () => [{ address: "127.0.0.1" }],
      }),
    ).rejects.toThrow();

    await expect(
      auditWebsiteSafely({
        url: "https://internal.corp.example",
        lookup: async () => [{ address: "10.24.0.12" }],
      }),
    ).rejects.toThrow();

    const audited = await auditWebsiteSafely({
      url: "https://client-dakar.example",
      lookup: async () => [{ address: "93.184.216.34" }],
      fetchImpl: (async () =>
        new Response(
          `<!doctype html><html lang="fr"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Agence immobilière à Dakar"><title>Immo Dakar Pro</title></head><body><h1>Immo Dakar</h1></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        )) as typeof fetch,
    });
    expect(audited.audit.statusCode).toBe(200);
    expect(audited.audit.title).toBe("Immo Dakar Pro");
    expect(audited.audit.hasViewportMeta).toBe(true);
    expect(audited.audit.usesHttps).toBe(true);
    expect(audited.evidenceSummary).toContain("HTTPS");
  });

  it("prospects companies from search results and flags CRM duplicates", async () => {
    service.createCompany(orgId, "local-owner", {
      name: "Teranga Tech",
      website: "https://teranga-tech.example",
      countryCode: "SN",
    });

    const result = await prospectWebCompanies({
      query: "agence logistique",
      city: "Dakar",
      countryCode: "SN",
      search: {
        async search() {
          return {
            backend: "searxng",
            sources: [
              { title: "Teranga Tech | Solutions", url: "https://teranga-tech.example/about", snippet: "Existante" },
              { title: "Sahel Logistics - Fret", url: "https://sahel-logistics.example/contact", snippet: "Transport B2B" },
            ],
          };
        },
      },
      findDuplicate: (normalized, website) =>
        service.findDuplicateCompanies(orgId, "local-owner", normalized, website)[0]?.id,
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.duplicateCompanyId).toBeTruthy();
    expect(result.candidates[1]?.name).toBe("Sahel Logistics");
    expect(result.candidates[1]?.duplicateCompanyId).toBeUndefined();
  });

  it("enforces consent + payload-bound owner approval before dispatching governed email outbox", async () => {
    const co = service.createCompany(orgId, "local-owner", { name: "Ndiaye BTP", countryCode: "SN" });
    const contact = service.createContact(orgId, "local-owner", {
      companyId: co.id,
      displayName: "Moussa Ndiaye",
      email: "moussa@ndiayebtp.example",
    });

    const payload = {
      contactId: contact.id,
      channel: "email",
      purpose: "commercial",
      recipient: "moussa@ndiayebtp.example",
      subject: "Proposition Portail Client",
      bodyText: "Bonjour Moussa, voici notre proposition détaillée.",
    };

    // Blocked even at approval-request stage without evidenced email consent
    expect(() =>
      service.requestApproval(orgId, "local-owner", {
        action: "send_message",
        resourceType: "email_message",
        resourceId: contact.id,
        payload,
        reason: "Send initial proposal email",
      }),
    ).toThrow(/consent/i);

    service.recordConsent(orgId, "local-owner", {
      contactId: contact.id,
      channel: "email",
      purpose: "commercial",
      status: "granted",
      source: "web_form",
      proof: "optin-form-991",
      textVersion: "email-v1",
    });

    const approval = service.requestApproval(orgId, "local-owner", {
      action: "send_message",
      resourceType: "email_message",
      resourceId: contact.id,
      payload,
      reason: "Send initial proposal email",
    });
    service.decideApproval(orgId, "local-owner", approval.id, "approved", approval.payloadHash, "Approved");

    // Blocked if payload differs from approved payload hash
    expect(() =>
      service.queueEmailMessage(orgId, "local-owner", {
        approvalId: approval.id,
        idempotencyKey: "email-idem-bad-0001",
        payload: { ...payload, subject: "Sujet modifié" },
      }),
    ).toThrow(/approval/i);

    const queued = service.queueEmailMessage(orgId, "local-owner", {
      approvalId: approval.id,
      idempotencyKey: "email-idem-0001",
      payload,
    });
    expect(queued.status).toBe("queued");

    const dispatched = await service.dispatchEmailMessage(orgId, "local-owner", queued.id);
    expect(dispatched.status).toBe("sent");
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.to).toBe("moussa@ndiayebtp.example");
  });

  it("runs In-App Project Studio (scaffold, confined files, AI tool loop, preview, 4-axis QA, ZIP export)", async () => {
    const co = service.createCompany(orgId, "local-owner", { name: "Keur Mode", countryCode: "SN" });
    const lead = service.createLead(orgId, "local-owner", { companyId: co.id });
    service.transitionLead(orgId, "local-owner", lead.id, "researching");
    service.transitionLead(orgId, "local-owner", lead.id, "qualified");
    const { quote } = service.createQuote(orgId, "local-owner", {
      leadId: lead.id,
      title: "Site E-commerce Keur Mode",
      lines: [{ label: "Vitrine + Catalogue", quantity: 1, unitPrice: 3000, unitCost: 1200, estimatedDays: 10 }],
    });
    const qReq = service.requestQuoteApproval(orgId, "local-owner", quote.id, "Ok");
    service.decideApproval(orgId, "local-owner", qReq.approval.id, "approved", qReq.approval.payloadHash, "Ok");
    service.sendQuote(orgId, "local-owner", quote.id);
    service.recordQuoteDecision(orgId, "local-owner", quote.id, "accepted");

    const contract = service.createContractFromQuote(orgId, "local-owner", { quoteId: quote.id, depositAmount: 900 });
    const cReq = service.requestContractApproval(orgId, "local-owner", contract.id, "Ok");
    service.decideApproval(orgId, "local-owner", cReq.approval.id, "approved", cReq.approval.payloadHash, "Ok");
    service.markContractSigned(orgId, "local-owner", contract.id);
    service.recordContractDeposit(orgId, "local-owner", contract.id, "paid", "DEP-900");

    const project = service.createProjectFromContract(orgId, "local-owner", { contractId: contract.id });
    service.transitionProject(orgId, "local-owner", project.id, "scoping");
    service.transitionProject(orgId, "local-owner", project.id, "in_progress");

    const lot = service.createProjectLot(orgId, "local-owner", project.id, {
      title: "Frontend Vitrine",
      acceptanceCriteria: ["Responsive", "Valid HTML"],
    });

    const scaffolded = scaffoldProjectTemplate({
      dataDir: tmpDir,
      project,
      contract,
      lots: [lot],
      template: "vitrine-html",
    });
    expect(scaffolded.files).toContain("index.html");
    expect(scaffolded.files).toContain("styles.css");

    expect(() => writeWorkspaceFile(tmpDir, project, "../escape.txt", "bad")).toThrow();

    writeWorkspaceFile(tmpDir, project, "notes.txt", "v1");
    expect(readWorkspaceFile(tmpDir, project, "notes.txt").content).toBe("v1");
    deleteWorkspaceFile(tmpDir, project, "notes.txt");
    expect(listWorkspaceFiles(tmpDir, project).some((f) => f.path === "notes.txt")).toBe(false);

    let call = 0;
    const mockModelClient = {
      async listModels() {
        return ["coder-pro"];
      },
      async streamChat() {
        call += 1;
        if (call === 1) {
          return JSON.stringify({
            tool: "write_file",
            path: "app.js",
            content: "console.log('Keur Mode ready');\n",
          });
        }
        return JSON.stringify({
          tool: "finish",
          summary: "Added clean app.js entrypoint",
        });
      },
    } as unknown as ModelClient;

    const agentRes = await runStudioAiAgent({
      dataDir: tmpDir,
      project,
      lot,
      instruction: "Ajoute un script app.js propre",
      modelClient: mockModelClient,
      defaultModel: "coder-pro",
      hasLlmEndpoint: true,
    });
    expect(agentRes.model).toBe("coder-pro");
    expect(agentRes.modifiedFiles).toContain("app.js");

    const preview = resolveStudioPreviewAsset(tmpDir, project, "index.html");
    expect(preview.mimeType).toContain("text/html");
    expect(preview.data.toString("utf8")).toContain("Site E-commerce Keur Mode");

    service.updateProjectLot(orgId, "local-owner", project.id, lot.id, {
      status: "verified",
      evidenceSummary: "index.html + app.js vérifiés",
    });

    const qa = await runFourAxisQaAudit({
      dataDir: tmpDir,
      project,
      contract,
      lots: service.listProjectLots(orgId, "local-owner", project.id),
    });
    expect(qa.items).toHaveLength(4);
    expect(qa.items.every((i) => i.status === "passed")).toBe(true);

    const zip = buildProjectZipArchive({
      dataDir: tmpDir,
      organization: service.getOrganization(orgId, "local-owner"),
      project,
      contract,
      lots: service.listProjectLots(orgId, "local-owner", project.id),
      deliveries: [],
      qaChecks: qa.items.map((item, idx) => ({
        id: `qa-${idx}`,
        organizationId: orgId,
        projectId: project.id,
        lotId: lot.id,
        category: item.category,
        title: item.title,
        status: item.status,
        evidence: item.evidence,
        findings: item.findings,
        checkedBy: "qa-bot",
        checkedAt: 1_850_000_000_000,
        createdAt: 1_850_000_000_000,
        updatedAt: 1_850_000_000_000,
      })),
    });
    expect(zip.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(zip.fileCount).toBeGreaterThan(2);

    const copilot = await runAgencyCopilot({
      organization: service.getOrganization(orgId, "local-owner"),
      dashboard: service.dashboard(orgId, "local-owner"),
      metrics: service.getMetrics(orgId, "local-owner"),
      tab: "projects",
      question: "Quel est le statut global ?",
      project,
      lots: service.listProjectLots(orgId, "local-owner", project.id),
    });
    expect(copilot.mode).toBe("deterministic");
    expect(copilot.answer).toContain("Keur Mode");
  });

  it("wires full 14-stage agency HTTP endpoints cleanly (prospecting, extract-needs, estimate, studio, qa-audit, zip, retention, copilot, audit)", async () => {
    const route = agencyRoutes({
      agency: service,
      emailConfig: {
        status: () => ({ configured: true, provider: "smtp", from: "agence@anymodelbot.local", replyTo: "" }),
      },
      app: {
        dataDir: tmpDir,
        config: { dataDir: tmpDir, workspace: tmpDir },
      },
    } as unknown as WebContext);

    async function invoke(method: string, routePath: string, body?: unknown) {
      const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
      Object.defineProperty(request, "headers", {
        value: {
          "content-type": body === undefined ? "" : "application/json",
          "sec-fetch-site": "same-origin",
        },
      });
      const chunks: Buffer[] = [];
      let status = 0;
      let headers: Record<string, string> = {};
      const raw = {
        writeHead(s: number, h: Record<string, string> = {}) {
          status = s;
          headers = h;
          return raw;
        },
        end(payload?: string | Buffer) {
          if (payload !== undefined) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
          return raw;
        },
      };
      const response = raw as unknown as ServerResponse;
      const url = new URL("http://localhost/amb/api" + routePath);
      const segments = url.pathname.replace(/^\/amb\/api\/?/, "").split("/").filter(Boolean);
      try {
        await route(request, response, url, segments, routePath, method);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        response.writeHead(err.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: err.message }));
      }
      const buf = Buffer.concat(chunks);
      const ct = String(headers["content-type"] || "");
      return {
        status,
        headers,
        buffer: buf,
        text: buf.toString("utf8"),
        json: ct.includes("application/json") && buf.length ? JSON.parse(buf.toString("utf8")) : null,
      };
    }

    const coRes = await invoke("POST", `/agency/${orgId}/companies`, { name: "Dakar Solar", countryCode: "SN" });
    expect(coRes.status).toBe(201);
    const companyId = coRes.json.company.id as string;

    const patchCo = await invoke("PATCH", `/agency/${orgId}/companies/${companyId}`, { city: "Dakar" });
    expect(patchCo.status).toBe(200);
    expect(patchCo.json.company.city).toBe("Dakar");

    const leadRes = await invoke("POST", `/agency/${orgId}/leads`, { companyId });
    expect(leadRes.status).toBe(201);
    const leadId = leadRes.json.lead.id as string;
    await invoke("PATCH", `/agency/${orgId}/leads/${leadId}/stage`, { stage: "researching" });
    await invoke("PATCH", `/agency/${orgId}/leads/${leadId}/stage`, { stage: "qualified" });

    const convRes = await invoke("POST", `/agency/${orgId}/conversations`, {
      leadId,
      channel: "email",
      subject: "Portail Solaire",
    });
    expect(convRes.status).toBe(201);
    const convId = convRes.json.conversation.id as string;

    await invoke("POST", `/agency/${orgId}/conversations/${convId}/messages`, {
      direction: "inbound",
      body: "Nous voulons une application web dashboard et auth avec budget 4500 EUR en 3 semaines",
    });
    const extRes = await invoke("POST", `/agency/${orgId}/conversations/${convId}/extract-needs`, {});
    expect(extRes.status).toBe(200);
    expect(extRes.json.extracted.problemStatement).toBeTruthy();

    await invoke("PUT", `/agency/${orgId}/leads/${leadId}/needs`, {
      problemStatement: extRes.json.extracted.problemStatement,
      solutionType: "web_app",
      mustHaveFeatures: ["Dashboard", "Auth"],
      desiredTimeline: "3 semaines",
      budgetMin: 3500,
      budgetMax: 5000,
      clientConfirmed: true,
    });

    const estRes = await invoke("POST", `/agency/${orgId}/quotes/estimate`, { leadId });
    expect(estRes.status).toBe(200);
    expect(estRes.json.lines.length).toBeGreaterThan(0);

    const qRes = await invoke("POST", `/agency/${orgId}/quotes`, {
      leadId,
      title: estRes.json.title,
      lines: estRes.json.lines,
    });
    expect(qRes.status).toBe(201);
    const quoteId = qRes.json.quote.id as string;

    const revRes = await invoke("POST", `/agency/${orgId}/quotes/${quoteId}/revise`, { discountPct: 5 });
    expect(revRes.status).toBe(201);
    const v2Id = revRes.json.quote.id as string;
    expect(revRes.json.quote.version).toBe(2);

    const qReq = await invoke("POST", `/agency/${orgId}/quotes/${v2Id}/request-approval`, { reason: "Ok" });
    await invoke("POST", `/agency/${orgId}/approvals/${qReq.json.approval.id}/decision`, {
      decision: "approved",
      expectedPayloadHash: qReq.json.approval.payloadHash,
    });
    await invoke("POST", `/agency/${orgId}/quotes/${v2Id}/send`, {});
    await invoke("POST", `/agency/${orgId}/quotes/${v2Id}/decision`, { decision: "accepted" });

    const cRes = await invoke("POST", `/agency/${orgId}/contracts`, { quoteId: v2Id, depositAmount: 1000 });
    const contractId = cRes.json.contract.id as string;
    const cReq = await invoke("POST", `/agency/${orgId}/contracts/${contractId}/request-approval`, { reason: "Sign" });
    await invoke("POST", `/agency/${orgId}/approvals/${cReq.json.approval.id}/decision`, {
      decision: "approved",
      expectedPayloadHash: cReq.json.approval.payloadHash,
    });
    await invoke("POST", `/agency/${orgId}/contracts/${contractId}/sign`, {});
    await invoke("POST", `/agency/${orgId}/contracts/${contractId}/deposit`, { status: "paid", reference: "SOL-1" });

    const projRes = await invoke("POST", `/agency/${orgId}/projects`, { contractId });
    expect(projRes.status).toBe(201);
    const projectId = projRes.json.project.id as string;
    await invoke("PATCH", `/agency/${orgId}/projects/${projectId}/status`, { status: "scoping" });
    await invoke("PATCH", `/agency/${orgId}/projects/${projectId}/status`, { status: "in_progress" });

    const planRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/auto-plan`, { apply: true });
    expect(planRes.status).toBe(201);
    expect(planRes.json.lots.length).toBeGreaterThanOrEqual(3);

    const scafRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/studio/scaffold`, { template: "vitrine-html" });
    expect(scafRes.status).toBe(201);

    for (const lot of planRes.json.lots as Array<{ id: string }>) {
      await invoke("PATCH", `/agency/${orgId}/projects/${projectId}/lots/${lot.id}`, {
        status: "verified",
        evidenceSummary: "Verified via Studio",
      });
    }

    const qaRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/qa-audit`, {});
    expect(qaRes.status).toBe(201);
    expect(qaRes.json.checks).toHaveLength(4);

    const reportRes = await invoke("GET", `/agency/${orgId}/projects/${projectId}/delivery-report`);
    expect(reportRes.status).toBe(200);
    expect(reportRes.text).toContain("Dakar Solar");

    const zipRes = await invoke("GET", `/agency/${orgId}/projects/${projectId}/package.zip`);
    expect(zipRes.status).toBe(200);
    expect(zipRes.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);

    const fuRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/followups`, {
      type: "upsell",
      dueAt: 1_860_000_000_000,
      notes: "Application mobile V2",
    });
    const convOppRes = await invoke("POST", `/agency/${orgId}/followups/${fuRes.json.followUp.id}/convert-opportunity`, {});
    expect(convOppRes.status).toBe(201);
    expect(convOppRes.json.lead.stage).toBe("opportunity");

    const copRes = await invoke("POST", `/agency/${orgId}/copilot`, { tab: "operations", question: "État ?" });
    expect(copRes.status).toBe(200);
    expect(copRes.json.answer).toBeTruthy();

    const auditVer = await invoke("GET", `/agency/${orgId}/audit/verify`);
    expect(auditVer.status).toBe(200);
    expect(auditVer.json.verification.valid).toBe(true);

    const emailStatus = await invoke("GET", `/agency/${orgId}/email/status`);
    expect(emailStatus.status).toBe(200);
    expect(emailStatus.json.configured).toBe(true);
  });
});
