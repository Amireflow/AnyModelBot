import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgencyService,
  AgencyStore,
  EmailSecretsFile,
  EnvEmailSender,
  LocalNodeSecretBox,
  createStudioSnapshot,
  listStudioSnapshots,
  readWorkspaceFile,
  renderInvoiceDocumentHtml,
  rollbackStudioSnapshot,
  runStudioAiAgent,
  scaffoldProjectTemplate,
  writeWorkspaceFile,
} from "../src/agency/index.js";
import { agencyRoutes } from "../src/web/routes/agency.js";
import type { WebContext } from "../src/web/http.js";
import type { ModelClient } from "../src/llm/client.js";

describe("AnyModelBot Audit Upgrades (P0 / P1 / P2)", () => {
  let tmpDir: string;
  let store: AgencyStore;
  let service: AgencyService;
  let orgId: string;

  beforeEach(() => {
    let seq = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-audit-up-"));
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, {
      now: () => 1_860_000_000_000 + ++seq * 1000,
      id: () => `au-${++seq}`,
    });
    orgId = service.createOrganization({ name: "Dim Agency", countryCode: "SN", currency: "XOF" }, "local-owner").id;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupProject() {
    const co = service.createCompany(orgId, "local-owner", { name: "Dakar Market", countryCode: "SN" });
    const lead = service.createLead(orgId, "local-owner", { companyId: co.id });
    service.transitionLead(orgId, "local-owner", lead.id, "researching");
    service.transitionLead(orgId, "local-owner", lead.id, "qualified");
    const { quote } = service.createQuote(orgId, "local-owner", {
      leadId: lead.id,
      title: "Portail E-commerce Dakar",
      lines: [{ label: "Boutique", quantity: 1, unitPrice: 1_500_000, unitCost: 600_000, estimatedDays: 15 }],
    });
    const qAp = service.requestQuoteApproval(orgId, "local-owner", quote.id, "OK");
    service.decideApproval(orgId, "local-owner", qAp.approval.id, "approved", qAp.approval.payloadHash);
    service.sendQuote(orgId, "local-owner", quote.id);
    service.recordQuoteDecision(orgId, "local-owner", quote.id, "accepted");
    const contract = service.createContractFromQuote(orgId, "local-owner", { quoteId: quote.id });
    const cAp = service.requestContractApproval(orgId, "local-owner", contract.id, "Sign");
    service.decideApproval(orgId, "local-owner", cAp.approval.id, "approved", cAp.approval.payloadHash);
    service.markContractSigned(orgId, "local-owner", contract.id);
    service.recordContractDeposit(orgId, "local-owner", contract.id, "paid", "OM-2026-009");
    const project = service.createProjectFromContract(orgId, "local-owner", { contractId: contract.id });
    return { co, lead, quote, contract, project };
  }

  function makeInvoker(overrides: Partial<WebContext> = {}) {
    const route = agencyRoutes({
      agency: service,
      app: {
        dataDir: tmpDir,
        config: { dataDir: tmpDir, workspace: tmpDir, ui: { lang: "fr" }, llm: { defaultModel: "GLM-5.3" } },
      },
      ...overrides,
    } as unknown as WebContext);

    return async function invoke(method: string, routePath: string, body?: unknown) {
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
        writableEnded: false,
        writeHead(s: number, h: Record<string, string> = {}) {
          status = s;
          headers = h;
          return raw;
        },
        write(chunk: string | Buffer) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        },
        end(payload?: string | Buffer) {
          if (payload !== undefined) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
          raw.writableEnded = true;
        },
      };
      const url = new URL(`http://127.0.0.1:3600/amb/api${routePath}`);
      const seg = url.pathname.replace(/^\/amb\/api\//, "").split("/");
      await route(request, raw as unknown as ServerResponse, url, seg, url.pathname, method);
      const rawText = Buffer.concat(chunks).toString("utf8");
      let json: any = null;
      try { json = JSON.parse(rawText); } catch { /* SSE/HTML response */ }
      return { status, headers, rawText, json };
    };
  }

  it("P0 regression: POST /prospecting/search returns items as an array alongside backend", async () => {
    const invoke = makeInvoker({
      app: {
        dataDir: tmpDir,
        config: { dataDir: tmpDir, workspace: tmpDir },
        search: {
          async search() {
            return {
              backend: "exa-mcp",
              sources: [
                { title: "Gaïa Immobilier | Dakar", url: "https://gaia-immo.example/contact", snippet: "Agence Dakar" },
              ],
            };
          },
        },
      } as any,
    });
    const res = await invoke("POST", `/agency/${orgId}/prospecting/search`, { query: "agence immobiliere", city: "Dakar" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.items)).toBe(true);
    expect(res.json.items).toHaveLength(1);
    expect(res.json.items[0].name).toBe("Gaïa Immobilier");
    expect(res.json.backend).toBe("exa-mcp");
  });

  it("P1: encrypts email vault credentials without leaking secrets in GET /email/config", async () => {
    const vault = EmailSecretsFile.at(tmpDir, new LocalNodeSecretBox(tmpDir, ".email-vault.key"));
    const sender = new EnvEmailSender({});
    let cached: any;
    const invoke = makeInvoker({
      emailConfig: {
        async status(organizationId?: string) {
          const st = sender.status();
          return {
            ...st,
            organizationMatches: !cached || cached.organizationId === organizationId,
            savedInSecureStorage: vault.status().hasStoredSecret,
          };
        },
        async save(organizationId: string, config: unknown) {
          await vault.set({ ...(config as object), organizationId }, organizationId);
          cached = await vault.get();
          sender.setConfig(cached);
        },
        async clear() {
          vault.clear();
          cached = undefined;
          sender.setConfig({});
        },
      },
    });

    const putRes = await invoke("PUT", `/agency/${orgId}/email/config`, {
      provider: "resend",
      resendApiKey: "re_super_secret_token_12345",
      fromAddress: "agence@dimagency.sn",
      replyTo: "direction@dimagency.sn",
    });
    expect(putRes.status).toBe(200);
    expect(putRes.json.secretReturned).toBe(false);
    expect(putRes.json.configuration.configured).toBe(true);
    expect(putRes.json.configuration.provider).toBe("resend");
    expect(putRes.json.configuration.hasApiKey).toBe(true);
    expect(putRes.rawText).not.toContain("re_super_secret_token_12345");

    const getRes = await invoke("GET", `/agency/${orgId}/email/config`);
    expect(getRes.status).toBe(200);
    expect(getRes.rawText).not.toContain("re_super_secret_token_12345");
    expect((await vault.get())?.resendApiKey).toBe("re_super_secret_token_12345");

    const delRes = await invoke("DELETE", `/agency/${orgId}/email/config`);
    expect(delRes.status).toBe(200);
    expect(delRes.json.configuration.configured).toBe(false);
  });

  it("P1: generates 40/40/20 contract milestone invoices, marks paid, and renders printable invoice HTML", async () => {
    const { contract, co } = setupProject();
    const invoke = makeInvoker();

    const genRes = await invoke("POST", `/agency/${orgId}/contracts/${contract.id}/milestones`, {});
    expect(genRes.status).toBe(201);
    expect(genRes.json.items).toHaveLength(3);
    expect(genRes.json.items.map((i: any) => i.percentage)).toEqual([40, 40, 20]);
    expect(genRes.json.items[0].invoiceNumber).toMatch(/^FAC-\d{4}-001$/);
    const totalSum = genRes.json.items.reduce((acc: number, i: any) => acc + i.amount, 0);
    expect(totalSum).toBe(contract.totalAmount);

    const invId = genRes.json.items[0].id;
    const payRes = await invoke("PATCH", `/agency/${orgId}/invoices/${invId}`, {
      status: "paid",
      paymentReference: "WAVE-99182",
    });
    expect(payRes.status).toBe(200);
    expect(payRes.json.invoice.status).toBe("paid");
    expect(payRes.json.invoice.paymentReference).toBe("WAVE-99182");

    const docRes = await invoke("GET", `/agency/${orgId}/invoices/${invId}/document`);
    expect(docRes.status).toBe(200);
    expect(docRes.headers["content-type"]).toContain("text/html");
    expect(docRes.rawText).toContain("FAC-");
    expect(docRes.rawText).toContain("WAVE-99182");

    const directHtml = renderInvoiceDocumentHtml({
      organization: service.getOrganization(orgId, "local-owner"),
      company: co,
      contract,
      invoice: payRes.json.invoice,
      lang: "fr",
    });
    expect(directHtml).toContain("FACTURE ACQUITTÉE");
  });

  it("P2: creates Git snapshots & rolls back Studio changes, streams steps via SSE, and runs qa-autofix + lot pipeline", async () => {
    const { project, contract } = setupProject();
    scaffoldProjectTemplate({
      dataDir: tmpDir,
      project,
      contract,
      lots: [],
      template: "vitrine-html",
    });
    const lot = service.createProjectLot(orgId, "local-owner", project.id, {
      title: "Page d'accueil et hero",
      description: "Finaliser le hero HTML",
      acceptanceCriteria: ["index.html contient le titre"],
      ownerRole: "developer",
    });

    const snap1 = await createStudioSnapshot(tmpDir, project, "initial");
    expect(snap1.created).toBe(true);
    expect(snap1.commitHash).toMatch(/^[0-9a-f]{7,40}$/i);

    writeWorkspaceFile(tmpDir, project, "index.html", "<!doctype html><html><body>Broken edit</body></html>");
    const rolled = await rollbackStudioSnapshot(tmpDir, project);
    expect(rolled.restoredCommit).toBe(snap1.commitHash);
    expect(readWorkspaceFile(tmpDir, project, "index.html").content).toContain("Portail E-commerce Dakar");

    const snaps = await listStudioSnapshots(tmpDir, project);
    expect(snaps.length).toBeGreaterThanOrEqual(1);

    // Live onStep streaming callback check
    const liveSteps: any[] = [];
    let callIdx = 0;
    const mockClient: ModelClient = {
      async listModels() { return ["GLM-5.3"]; },
      async streamChat() {
        callIdx += 1;
        if (callIdx === 1) {
          return JSON.stringify({ tool: "patch_file", path: "index.html", search: "Solutions", replace: "Solutions Pro" });
        }
        if (callIdx === 2) {
          return JSON.stringify({ tool: "write_file", path: "BRIEF.md", content: `# ${project.title}\nBrief validé` });
        }
        return JSON.stringify({ tool: "finish", summary: "SSE et auto-fix exécutés." });
      },
    } as unknown as ModelClient;

    const agentOut = await runStudioAiAgent({
      dataDir: tmpDir,
      project,
      instruction: "Mettre à jour BRIEF.md",
      hasLlmEndpoint: true,
      defaultModel: "GLM-5.3",
      modelClient: mockClient,
      onStep: (st) => liveSteps.push(st),
    });
    expect(liveSteps.length).toBe(agentOut.steps.length);
    expect(agentOut.snapshotBefore).toMatch(/^[0-9a-f]{7,40}$/i);

    // HTTP SSE stream + qa-autofix + run-pipeline
    const invoke = makeInvoker({
      app: {
        dataDir: tmpDir,
        config: { dataDir: tmpDir, workspace: tmpDir, ui: { lang: "fr" }, llm: { defaultModel: "GLM-5.3" } },
        models: {
          async listModels() { return ["GLM-5.3"]; },
          async streamChat() {
            return JSON.stringify({ tool: "finish", summary: "Livré proprement" });
          },
        },
      } as any,
    });

    const sseRes = await invoke("POST", `/agency/${orgId}/projects/${project.id}/studio/ai-agent-stream`, {
      instruction: "Vérifier l'état du projet",
      agentRole: "developer",
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers["content-type"]).toContain("text/event-stream");
    expect(sseRes.rawText).toContain("event: step");
    expect(sseRes.rawText).toContain("event: done");

    // Trigger QA failure deliberately, then run qa-autofix
    service.recordQaCheck(orgId, "local-owner", project.id, {
      category: "technical",
      title: "Vérif syntaxe",
      status: "failed",
      findings: "Corriger index.html",
    });
    const fixRes = await invoke("POST", `/agency/${orgId}/projects/${project.id}/qa-autofix`, {});
    expect(fixRes.status).toBe(200);
    expect(fixRes.json.qaResult.checks).toHaveLength(4);

    // 1-click lot pipeline
    const pipeRes = await invoke("POST", `/agency/${orgId}/projects/${project.id}/lots/${lot.id}/run-pipeline`, {});
    expect(pipeRes.status).toBe(200);
    expect(pipeRes.json.architectBrief).toBeTruthy();
    expect(pipeRes.json.devResult.summary).toBe("Livré proprement");
    expect(pipeRes.json.qaResult.checks).toHaveLength(4);
    expect(["in_qa", "in_progress"]).toContain(pipeRes.json.lot.status);
  });

  it("Copilot reads attached CSV/brief files and executes governed CRM & prospecting tools", async () => {
    let turn = 0;
    const invoke = makeInvoker({
      app: {
        dataDir: tmpDir,
        config: { dataDir: tmpDir, workspace: tmpDir, ui: { lang: "fr" }, llm: { defaultModel: "GLM-5.3" } },
        search: {
          async search() {
            return {
              backend: "exa-mcp",
              sources: [{ title: "Teranga Immo | Dakar", url: "https://teranga-immo.example", snippet: "Immobilier" }],
            };
          },
        },
        models: {
          async listModels() { return ["GLM-5.3"]; },
          async streamChat(req: any) {
            turn += 1;
            if (turn === 1) {
              const userPrompt = req.messages.map((m: any) => m.content).join("\n");
              expect(userPrompt).toContain("prospects.csv");
              expect(userPrompt).toContain("Senegal Logistics");
              return JSON.stringify({
                tool: "import_companies",
                args: {
                  companies: [{ name: "Senegal Logistics", website: "https://senegal-logistics.example", industry: "Transport", city: "Dakar" }],
                },
              });
            }
            if (turn === 2) {
              return JSON.stringify({ tool: "prospect_web", args: { query: "immobilier", city: "Dakar" } });
            }
            return "## Actions terminées\n- Importé **Senegal Logistics** depuis `prospects.csv`.\n- Trouvé **Teranga Immo** sur le web.";
          },
        },
      } as any,
    });

    const copRes = await invoke("POST", `/agency/${orgId}/copilot`, {
      tab: "copilot",
      question: "Importe les entreprises du CSV et cherche un prospect immobilier à Dakar",
      attachments: [
        {
          name: "prospects.csv",
          mimeType: "text/csv",
          size: 84,
          textContent: "name,website,city\nSenegal Logistics,https://senegal-logistics.example,Dakar\n",
        },
      ],
      history: [{ role: "user", text: "Bonjour Copilote" }],
    });

    expect(copRes.status).toBe(200);
    expect(copRes.json.mode).toBe("llm");
    expect(copRes.json.actions).toHaveLength(2);
    expect(copRes.json.actions[0].tool).toBe("import_companies");
    expect(copRes.json.actions[0].ok).toBe(true);
    expect(copRes.json.actions[1].tool).toBe("prospect_web");
    expect(copRes.json.actions[1].ok).toBe(true);
    expect(copRes.json.answer).toContain("Senegal Logistics");

    const companies = service.listCompanies(orgId, "local-owner");
    expect(companies.some((c) => c.name === "Senegal Logistics")).toBe(true);
  });
});
