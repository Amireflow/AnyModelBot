import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AgencyService, AgencyStore } from "../src/agency/index.js";
import { agencyRoutes } from "../src/web/routes/agency.js";
import { HttpError, type WebContext } from "../src/web/http.js";

describe("Agency Production, QA Gate, Delivery, Retention, and Orchestrator HTTP routes (Lot B)", () => {
  let store: AgencyStore;
  let service: AgencyService;
  let route: ReturnType<typeof agencyRoutes>;
  let orgId: string;
  let contractId: string;

  beforeEach(() => {
    let seq = 0;
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, { now: () => 1_800_000_000_000, id: () => `http-prod-${++seq}` });
    orgId = service.createOrganization({ name: "HTTP Agency Prod", currency: "EUR" }, "local-owner").id;
    const company = service.createCompany(orgId, "local-owner", { name: "Atelier Dakar", countryCode: "SN" });
    const contact = service.createContact(orgId, "local-owner", { companyId: company.id, displayName: "Fatou", email: "fatou@dakar.example" });
    const lead = service.createLead(orgId, "local-owner", { companyId: company.id, contactId: contact.id });
    const { quote } = service.createQuote(orgId, "local-owner", {
      leadId: lead.id,
      title: "Plateforme Client",
      lines: [{ label: "Web App", quantity: 1, unitPrice: 4000, unitCost: 1800, estimatedDays: 14 }],
    });
    const qReq = service.requestQuoteApproval(orgId, "local-owner", quote.id, "Send quote");
    service.decideApproval(orgId, "local-owner", qReq.approval.id, "approved", qReq.approval.payloadHash, "Ok");
    service.sendQuote(orgId, "local-owner", quote.id);
    service.recordQuoteDecision(orgId, "local-owner", quote.id, "accepted");
    const contract = service.createContractFromQuote(orgId, "local-owner", { quoteId: quote.id, depositAmount: 1200 });
    const cReq = service.requestContractApproval(orgId, "local-owner", contract.id, "Sign");
    service.decideApproval(orgId, "local-owner", cReq.approval.id, "approved", cReq.approval.payloadHash, "Ok");
    service.markContractSigned(orgId, "local-owner", contract.id);
    service.recordContractDeposit(orgId, "local-owner", contract.id, "paid", "DEP-1");
    contractId = contract.id;
    route = agencyRoutes({ agency: service } as unknown as WebContext);
  });

  afterEach(() => store.close());

  async function invoke(method: string, path: string, body?: unknown, fetchSite = "same-origin") {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
    Object.defineProperty(request, "headers", {
      value: {
        "content-type": body === undefined ? "" : "application/json",
        "sec-fetch-site": fetchSite,
      },
    });
    const raw = {
      status: 0,
      payload: "",
      writeHead(status: number) { raw.status = status; return raw; },
      end(payload?: string) { raw.payload = String(payload ?? ""); return raw; },
    };
    const response = raw as unknown as ServerResponse & { status: number; payload: string };
    const url = new URL("http://localhost/amb/api" + path);
    const segments = url.pathname.replace(/^\/amb\/api\/?/, "").split("/").filter(Boolean);
    try {
      await route(request, response, url, segments, path, method);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      response.writeHead(error.status);
      response.end(JSON.stringify({ error: error.message }));
    }
    return { status: response.status, body: response.payload ? JSON.parse(response.payload) : null };
  }

  it("supports end-to-end project handoff, lots, scope change, QA gate, delivery, followups, agents, missions and metrics over HTTP", async () => {
    const crossSite = await invoke("POST", `/agency/${orgId}/projects`, { contractId }, "cross-site");
    expect(crossSite.status).toBe(403);

    const projRes = await invoke("POST", `/agency/${orgId}/projects`, { contractId });
    expect(projRes.status).toBe(201);
    const projectId = projRes.body.project.id as string;

    expect((await invoke("PATCH", `/agency/${orgId}/projects/${projectId}/status`, { status: "scoping" })).status).toBe(200);
    expect((await invoke("PATCH", `/agency/${orgId}/projects/${projectId}/status`, { status: "in_progress" })).status).toBe(200);

    const lotRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/lots`, {
      title: "Lot Auth & API",
      acceptanceCriteria: ["Tests pass"],
    });
    expect(lotRes.status).toBe(201);
    const lotId = lotRes.body.lot.id as string;

    const briefRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/lots/${lotId}/execution-brief`, { preferredTool: "claude" });
    expect(briefRes.status).toBe(200);
    expect(briefRes.body.brief).toContain("Lot Auth & API");

    const blockedPrep = await invoke("POST", `/agency/${orgId}/projects/${projectId}/deliveries`, {});
    expect(blockedPrep.status).toBe(409);

    expect((await invoke("PATCH", `/agency/${orgId}/projects/${projectId}/lots/${lotId}`, {
      status: "verified",
      evidenceSummary: "vitest 10/10 passed",
    })).status).toBe(200);

    const scRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/scope-changes`, {
      title: "Extra analytics page",
      budgetDelta: 400,
      daysDelta: 2,
    });
    expect(scRes.status).toBe(201);
    const scReq = await invoke("POST", `/agency/${orgId}/projects/${projectId}/scope-changes/${scRes.body.scopeChange.id}/request-approval`, {
      reason: "Client approved addendum",
    });
    expect(scReq.status).toBe(201);
    await invoke("POST", `/agency/${orgId}/approvals/${scReq.body.approval.id}/decision`, {
      decision: "approved",
      expectedPayloadHash: scReq.body.approval.payloadHash,
      reason: "OK",
    });
    const scApply = await invoke("POST", `/agency/${orgId}/projects/${projectId}/scope-changes/${scRes.body.scopeChange.id}/apply`, {});
    expect(scApply.status).toBe(200);
    expect(scApply.body.project.budgetAmount).toBe(4400);

    for (const category of ["functional", "technical", "ui_ux", "security"]) {
      const checkRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/qa-checks`, {
        lotId,
        category,
        title: `${category} check`,
        status: "passed",
        evidence: `${category}.log passed`,
      });
      expect(checkRes.status).toBe(201);
    }

    const gateRes = await invoke("GET", `/agency/${orgId}/projects/${projectId}/qa-gate`);
    expect(gateRes.status).toBe(200);
    expect(gateRes.body.gate.readyForDelivery).toBe(true);

    const prepRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/deliveries`, {
      environmentUrl: "https://app.dakar.example",
      releaseNotes: "Initial launch",
    });
    expect(prepRes.status).toBe(201);
    const deliveryId = prepRes.body.delivery.id as string;

    const depReq = await invoke("POST", `/agency/${orgId}/projects/${projectId}/deliveries/${deliveryId}/request-approval`, {
      reason: "Ready for launch",
    });
    expect(depReq.status).toBe(201);
    await invoke("POST", `/agency/${orgId}/approvals/${depReq.body.approval.id}/decision`, {
      decision: "approved",
      expectedPayloadHash: depReq.body.approval.payloadHash,
      reason: "Launch approved",
    });

    const deployRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/deliveries/${deliveryId}/deploy`, {});
    expect(deployRes.status).toBe(200);
    expect(deployRes.body.project.status).toBe("delivered");

    const acceptRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/deliveries/${deliveryId}/accept`, {
      accepted: true,
      feedback: "Great delivery",
    });
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.project.status).toBe("accepted");

    const fuRes = await invoke("POST", `/agency/${orgId}/projects/${projectId}/followups`, {
      type: "maintenance",
      dueAt: 1_800_500_000_000,
      notes: "Monthly SLA proposal",
    });
    expect(fuRes.status).toBe(201);

    const agentsRes = await invoke("GET", `/agency/${orgId}/agents`);
    expect(agentsRes.status).toBe(200);
    expect(agentsRes.body.items).toHaveLength(13);

    const toolsRes = await invoke("GET", `/agency/${orgId}/dev-tools`);
    expect(toolsRes.status).toBe(200);
    expect(toolsRes.body.items.length).toBeGreaterThan(0);

    const missionRes = await invoke("POST", `/agency/${orgId}/missions`, {
      projectId,
      agentRole: "developer",
      title: "Build dashboard",
      preferredTool: "node",
    });
    expect(missionRes.status).toBe(201);

    const metricsRes = await invoke("GET", `/agency/${orgId}/metrics`);
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body.metrics.projectsAccepted).toBe(1);
    expect(metricsRes.body.metrics.pendingFollowUps).toBe(1);
  });
});
