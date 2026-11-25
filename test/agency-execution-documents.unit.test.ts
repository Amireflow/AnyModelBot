import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgencyService,
  AgencyStore,
  executeAgencyMission,
  initProjectWorkspace,
  renderContractDocumentHtml,
  renderQuoteDocumentHtml,
  resolveSafeWorkspacePath,
} from "../src/agency/index.js";
import type { ModelClient } from "../src/llm/client.js";
import { HttpError, type WebContext } from "../src/web/http.js";
import { agencyRoutes } from "../src/web/routes/agency.js";

describe("Lot C — Printable documents, confined workspaces, QA runner, and mission execution", () => {
  let tmpDir: string;
  let store: AgencyStore;
  let service: AgencyService;
  let route: ReturnType<typeof agencyRoutes>;
  let orgId: string;
  let companyId: string;
  let leadId: string;
  let convId: string;
  let quoteId: string;
  let contractId: string;
  let projectId: string;

  const mockModels: ModelClient = {
    async listModels() {
      return ["gemini-2.5-pro"];
    },
    async streamChat(req, onDelta) {
      const firstContent = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const reply = firstContent.includes("conseiller commercial")
        ? "Bonjour, voici notre proposition détaillée conforme au devis validé."
        : "# Plan technique\n\n- Implémenter les modules isolés et les tests.";
      onDelta(reply);
      return reply;
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-lotc-"));
    let seq = 0;
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, { now: () => 1_810_000_000_000, id: () => `lotc-${++seq}` });
    const org = service.createOrganization({ name: "Amireflow Agency", countryCode: "SN", currency: "XOF" }, "local-owner");
    orgId = org.id;
    const company = service.createCompany(orgId, "local-owner", {
      name: "Teranga <Script> Corp",
      industry: "Fintech",
      city: "Dakar",
    });
    companyId = company.id;
    const lead = service.createLead(orgId, "local-owner", { companyId, source: "outbound" });
    leadId = lead.id;
    const conv = service.createConversation(orgId, "local-owner", {
      leadId,
      channel: "email",
      subject: "Portail Client B2B",
    });
    convId = conv.id;
    const { quote } = service.createQuote(orgId, "local-owner", {
      leadId,
      title: "Portail Web <b>B2B</b>",
      lines: [{ label: "Architecture & UI", quantity: 1, unitPrice: 1_500_000, unitCost: 600_000, estimatedDays: 10 }],
    });
    quoteId = quote.id;
    const qr = service.requestQuoteApproval(orgId, "local-owner", quoteId, "Ready");
    service.decideApproval(orgId, "local-owner", qr.approval.id, "approved", qr.approval.payloadHash, "OK");
    service.sendQuote(orgId, "local-owner", quoteId);
    service.recordQuoteDecision(orgId, "local-owner", quoteId, "accepted");

    const contract = service.createContractFromQuote(orgId, "local-owner", {
      quoteId,
      depositAmount: 450_000,
    });
    contractId = contract.id;
    const cr = service.requestContractApproval(orgId, "local-owner", contractId, "Sign");
    service.decideApproval(orgId, "local-owner", cr.approval.id, "approved", cr.approval.payloadHash, "OK");
    service.markContractSigned(orgId, "local-owner", contractId);
    service.recordContractDeposit(orgId, "local-owner", contractId, "paid", "VIR-001");

    const project = service.createProjectFromContract(orgId, "local-owner", {
      contractId,
      workspacePath: "workspaces/projects/teranga-app",
    });
    projectId = project.id;
    service.createProjectLot(orgId, "local-owner", projectId, {
      title: "API & Auth",
      acceptanceCriteria: ["Tests vitest passent"],
      ownerRole: "developer",
    });

    route = agencyRoutes({
      agency: service,
      app: {
        config: {
          dataDir: tmpDir,
          magpie: { externalBaseUrl: "http://mock-llm.local/v1", externalApiKey: "k", mode: "external" },
          llm: { defaultModel: "gemini-2.5-pro", reasoningEffort: "medium" },
          ui: { lang: "fr" },
        },
        models: mockModels,
        status: () => ({ gateway: { state: "external" } }),
      },
    } as unknown as WebContext);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function invoke(method: string, urlPath: string, body?: unknown) {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
    Object.defineProperty(request, "headers", {
      value: {
        "content-type": body === undefined ? "" : "application/json",
        "sec-fetch-site": "same-origin",
      },
    });
    const raw = {
      status: 0,
      headers: {} as Record<string, string>,
      payload: "",
      writeHead(status: number, headers: Record<string, string> = {}) {
        raw.status = status;
        raw.headers = headers;
        return raw;
      },
      end(payload?: string) {
        raw.payload = String(payload ?? "");
        return raw;
      },
    };
    const response = raw as unknown as ServerResponse;
    const fullUrl = new URL("http://localhost/amb/api" + urlPath);
    const seg = fullUrl.pathname.replace(/^\/amb\/api\/?/, "").split("/").filter(Boolean);
    try {
      await route(request, response, fullUrl, seg, urlPath, method);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      response.writeHead(error.status);
      response.end(JSON.stringify({ error: error.message }));
    }
    const isHtml = (raw.headers["content-type"] ?? "").includes("text/html");
    return {
      status: raw.status,
      headers: raw.headers,
      text: raw.payload,
      body: isHtml ? null : (raw.payload ? JSON.parse(raw.payload) : null),
    };
  }

  it("renders printable quote & contract HTML with strict XSS escaping and status banners", () => {
    const org = service.getOrganization(orgId, "local-owner");
    const company = service.getCompany(orgId, "local-owner", companyId);
    const { quote: draftQuote } = service.createQuote(orgId, "local-owner", {
      leadId,
      title: "Devis Brouillon",
      lines: [{ label: "Audit", quantity: 1, unitPrice: 100_000, unitCost: 40_000, estimatedDays: 2 }],
    });

    const draftHtml = renderQuoteDocumentHtml({ organization: org, company, quote: draftQuote, lang: "fr" });
    expect(draftHtml).toContain("BROUILLON — NON VALIDÉ");
    expect(draftHtml).toContain("Teranga &lt;Script&gt; Corp");
    expect(draftHtml).not.toContain("<Script>");

    const contract = service.getContract(orgId, "local-owner", contractId);
    const quote = service.getQuote(orgId, "local-owner", quoteId);
    const contractHtml = renderContractDocumentHtml({ organization: org, company, contract, quote, lang: "fr" });
    expect(contractHtml).toContain("CONTRAT SIGNÉ");
    expect(contractHtml).toContain("VIR-001");
    expect(contractHtml).toContain("Portail Web &lt;b&gt;B2B&lt;/b&gt;");
  });

  it("rejects traversal and absolute paths in resolveSafeWorkspacePath and initializes BRIEF.md", () => {
    expect(() => resolveSafeWorkspacePath(tmpDir, "../outside")).toThrowError(/traversal/i);
    expect(() => resolveSafeWorkspacePath(tmpDir, "C:\\Windows\\System32")).toThrowError(/Absolute/i);
    expect(() => resolveSafeWorkspacePath(tmpDir, "/etc/passwd")).toThrowError(/Absolute/i);

    const project = service.getProject(orgId, "local-owner", projectId);
    const contract = service.getContract(orgId, "local-owner", contractId);
    const lots = service.listProjectLots(orgId, "local-owner", projectId);
    const ws = initProjectWorkspace({ dataDir: tmpDir, project, contract, lots });

    expect(ws.relativePath).toBe("projects/teranga-app");
    const wsDir = path.join(tmpDir, "agency-workspaces", "projects", "teranga-app");
    expect(fs.existsSync(path.join(wsDir, "BRIEF.md"))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, "README.md"))).toBe(true);
    expect(fs.readFileSync(path.join(wsDir, "BRIEF.md"), "utf8")).toContain("API & Auth");
  });

  it("executes missions in brief_export, llm_draft, and cli_tool modes inside workspace", async () => {
    const project = service.getProject(orgId, "local-owner", projectId);
    const mission = service.createMission(orgId, "local-owner", {
      projectId,
      agentRole: "architect",
      title: "Design architecture",
      objective: "Produce isolated module boundaries",
    });

    const exported = await executeAgencyMission({
      dataDir: tmpDir,
      project,
      mission,
      mode: "brief_export",
    });
    expect(exported.status).toBe("completed");
    expect(exported.evidencePaths[0]).toBe(`missions/${mission.id}.md`);

    const drafted = await executeAgencyMission({
      dataDir: tmpDir,
      project,
      mission,
      mode: "llm_draft",
      modelClient: mockModels,
      defaultModel: "gemini-2.5-pro",
      hasLlmEndpoint: true,
    });
    expect(drafted.status).toBe("completed");
    expect(drafted.evidencePaths[0]).toBe(`missions/${mission.id}-output.md`);
    expect(drafted.outputSummary).toContain("Plan technique");

    const wsDir = path.join(tmpDir, "agency-workspaces", "projects", "teranga-app");
    fs.writeFileSync(
      path.join(wsDir, "package.json"),
      JSON.stringify({ name: "teranga-app", scripts: { test: "node -e \"process.exit(0)\"" } }),
      "utf8",
    );
    const cliRun = await executeAgencyMission({
      dataDir: tmpDir,
      project,
      mission,
      mode: "cli_tool",
      cliAction: "npm_test",
    });
    expect(cliRun.status).toBe("completed");
    expect(cliRun.evidencePaths[0]).toBe(`missions/${mission.id}-run.log`);
  });

  it("serves document HTML, workspace init, automated QA check, AI commercial suggestion, and mission execution over HTTP", async () => {
    const qDoc = await invoke("GET", `/agency/${orgId}/quotes/${quoteId}/document`);
    expect(qDoc.status).toBe(200);
    expect(qDoc.headers["content-type"]).toContain("text/html");
    expect(qDoc.text).toContain("Teranga &lt;Script&gt; Corp");

    const cDoc = await invoke("GET", `/agency/${orgId}/contracts/${contractId}/document?download=1`);
    expect(cDoc.status).toBe(200);
    expect(cDoc.headers["content-disposition"]).toContain("attachment");
    expect(cDoc.text).toContain("CONTRAT SIGNÉ");

    const initRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/workspace/init`, {});
    expect(initRes.status).toBe(200);
    expect(initRes.body.workspace.relativePath).toBe("projects/teranga-app");

    const wsDir = path.join(tmpDir, "agency-workspaces", "projects", "teranga-app");
    fs.writeFileSync(
      path.join(wsDir, "package.json"),
      JSON.stringify({ name: "teranga-app", scripts: { test: "node -e \"console.log('qa ok')\"" } }),
      "utf8",
    );

    const qaRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/qa-run`, {});
    expect(qaRes.status).toBe(201);
    expect(qaRes.body.check.status).toBe("passed");
    expect(qaRes.body.run.commandsRun).toContain("npm test");

    const suggestRes = await invoke("POST", `/agency/${orgId}/conversations/${convId}/suggest-reply`, {});
    expect(suggestRes.status).toBe(200);
    expect(suggestRes.body.draft).toContain("proposition détaillée");
    expect(suggestRes.body.model).toBe("gemini-2.5-pro");

    const mission = service.createMission(orgId, "local-owner", {
      projectId,
      agentRole: "developer",
      title: "Implémenter portail",
      objective: "Deliver portal MVP",
    });
    const execRes = await invoke("POST", `/agency/${orgId}/missions/${mission.id}/execute`, {
      mode: "llm_draft",
    });
    expect(execRes.status).toBe(200);
    expect(execRes.body.mission.status).toBe("completed");
    expect(execRes.body.mission.evidencePaths).toContain(`missions/${mission.id}-output.md`);
  });
});
