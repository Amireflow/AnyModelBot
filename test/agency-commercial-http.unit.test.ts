import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AgencyService, AgencyStore } from "../src/agency/index.js";
import { agencyRoutes } from "../src/web/routes/agency.js";
import { HttpError, type WebContext } from "../src/web/http.js";

describe("Agency commercial HTTP routes (Lot A)", () => {
  let store: AgencyStore;
  let service: AgencyService;
  let route: ReturnType<typeof agencyRoutes>;
  let orgId: string;
  let leadId: string;

  beforeEach(() => {
    let seq = 0;
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, { now: () => 1_800_000_000_000, id: () => `http-comm-${++seq}` });
    orgId = service.createOrganization({ name: "HTTP Commercial Agency", currency: "EUR" }, "local-owner").id;
    const company = service.createCompany(orgId, "local-owner", { name: "Dakar Tech", countryCode: "SN" });
    const contact = service.createContact(orgId, "local-owner", { companyId: company.id, displayName: "Moussa", email: "moussa@dakartech.example" });
    leadId = service.createLead(orgId, "local-owner", { companyId: company.id, contactId: contact.id }).id;
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

  it("supports catalog, commercial rules, needs, conversations, quotes, negotiation, and contracts over HTTP", async () => {
    const cat = await invoke("POST", `/agency/${orgId}/catalog`, {
      code: "vitrine_pro",
      name: "Site Vitrine Pro",
      category: "vitrine",
      description: "Site vitrine moderne",
      estimatedDays: 7,
      priceMin: 900,
      priceBase: 1400,
      priceMax: 2200,
      estimatedCost: 600,
    });
    expect(cat.status).toBe(201);

    const preview = await invoke("POST", `/agency/${orgId}/quotes/tiered-preview`, { catalogItemId: cat.body.item.id });
    expect(preview.status).toBe(200);
    expect(preview.body.tiers).toHaveLength(3);

    const rules = await invoke("PUT", `/agency/${orgId}/commercial-rules`, {
      minMarginPct: 35,
      maxAutonomousDiscountPct: 10,
      defaultDepositPct: 30,
    });
    expect(rules.status).toBe(200);
    expect(rules.body.rules.minMarginPct).toBe(35);

    const needs = await invoke("PUT", `/agency/${orgId}/leads/${leadId}/needs`, {
      problemStatement: "Besoin d'un site rapide et crédible",
      solutionType: "vitrine",
      mustHaveFeatures: ["Accueil", "Contact"],
      clientConfirmed: true,
    });
    expect(needs.status).toBe(200);
    expect(needs.body.needs.solutionType).toBe("vitrine");

    const conv = await invoke("POST", `/agency/${orgId}/conversations`, {
      leadId,
      channel: "email",
      subject: "Proposition Vitrine",
    });
    expect(conv.status).toBe(201);
    const convId = conv.body.conversation.id as string;

    const inboundOptOut = await invoke("POST", `/agency/${orgId}/conversations/${convId}/messages`, {
      direction: "inbound",
      body: "STOP veuillez retirer mon adresse",
    });
    expect(inboundOptOut.status).toBe(201);
    expect(inboundOptOut.body.conversation.status).toBe("opted_out");

    const blockedOutbound = await invoke("POST", `/agency/${orgId}/conversations/${convId}/messages`, {
      direction: "outbound",
      body: "Relance",
    });
    expect(blockedOutbound.status).toBe(409);

    const quote = await invoke("POST", `/agency/${orgId}/quotes`, {
      leadId,
      title: "Devis Site Vitrine",
      tier: "standard",
      lines: [{ label: "Site Vitrine Pro", quantity: 1, unitPrice: 1400, unitCost: 600, estimatedDays: 7 }],
    });
    expect(quote.status).toBe(201);
    const quoteId = quote.body.quote.id as string;

    const neg = await invoke("POST", `/agency/${orgId}/quotes/${quoteId}/negotiate`, { requestedDiscountPct: 50 });
    expect(neg.status).toBe(200);
    expect(neg.body.evaluation.allowedAutonomously).toBe(false);

    const reqApp = await invoke("POST", `/agency/${orgId}/quotes/${quoteId}/request-approval`, { reason: "Prêt pour envoi" });
    expect(reqApp.status).toBe(201);
    await invoke("POST", `/agency/${orgId}/approvals/${reqApp.body.approval.id}/decision`, {
      decision: "approved",
      expectedPayloadHash: reqApp.body.approval.payloadHash,
    });

    const sent = await invoke("POST", `/agency/${orgId}/quotes/${quoteId}/send`, {});
    expect(sent.status).toBe(200);
    expect(sent.body.quote.status).toBe("sent");

    const accepted = await invoke("POST", `/agency/${orgId}/quotes/${quoteId}/decision`, { decision: "accepted" });
    expect(accepted.status).toBe(200);

    const contract = await invoke("POST", `/agency/${orgId}/contracts`, { quoteId });
    expect(contract.status).toBe(201);
    const contractId = contract.body.contract.id as string;

    const reqSign = await invoke("POST", `/agency/${orgId}/contracts/${contractId}/request-approval`, { reason: "Signature" });
    expect(reqSign.status).toBe(201);
    await invoke("POST", `/agency/${orgId}/approvals/${reqSign.body.approval.id}/decision`, {
      decision: "approved",
      expectedPayloadHash: reqSign.body.approval.payloadHash,
    });

    const signed = await invoke("POST", `/agency/${orgId}/contracts/${contractId}/sign`, {});
    expect(signed.status).toBe(200);
    expect(signed.body.contract.status).toBe("signed");

    const deposit = await invoke("POST", `/agency/${orgId}/contracts/${contractId}/deposit`, {
      status: "paid",
      reference: "BANK-789",
    });
    expect(deposit.status).toBe(200);
    expect(deposit.body.contract.depositStatus).toBe("paid");
  });

  it("rejects cross-site mutations on commercial endpoints", async () => {
    const res = await invoke("POST", `/agency/${orgId}/catalog`, { code: "x" }, "cross-site");
    expect(res.status).toBe(403);
  });
});
