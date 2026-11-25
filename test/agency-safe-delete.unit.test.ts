import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgencyService, AgencyStore } from "../src/agency/index.js";
import { agencyRoutes } from "../src/web/routes/agency.js";
import { HttpError, type WebContext } from "../src/web/http.js";

describe("Agency Safe & Audited Deletion", () => {
  let store: AgencyStore;
  let service: AgencyService;
  let orgId: string;
  let invoke: (method: string, routePath: string, body?: unknown) => Promise<{
    status: number;
    json: any;
  }>;

  beforeEach(() => {
    let seq = 0;
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, {
      now: () => 1_860_000_000_000 + ++seq,
      id: () => `del-${++seq}`,
    });
    orgId = service.createOrganization({ name: "SafeDelete Agency", currency: "XOF" }, "local-owner").id;

    const route = agencyRoutes({
      agency: service,
      app: { config: { dataDir: process.cwd(), ui: { lang: "fr" } }, models: null, magpie: null } as unknown as WebContext["app"],
    } as unknown as WebContext);

    invoke = async (method: string, routePath: string, body?: unknown) => {
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
        json: ct.includes("application/json") && buf.length ? JSON.parse(buf.toString("utf8")) : null,
      };
    };
  });

  afterEach(() => {
    store.close();
  });

  it("previews impact, requires confirm + exact name + cascade, deletes clean company tree, and audits", async () => {
    const company = service.createCompany(orgId, "local-owner", {
      name: "Dakar Test SARL",
      website: "https://dakartest.example",
      city: "Dakar",
    });
    const contact = service.createContact(orgId, "local-owner", {
      companyId: company.id,
      displayName: "Awa Diop",
      email: "awa@dakartest.example",
    });
    const lead = service.createLead(orgId, "local-owner", {
      companyId: company.id,
      contactId: contact.id,
      source: "prospecting",
      notes: "Test prospect",
    });
    service.addEvidence(orgId, "local-owner", {
      companyId: company.id,
      leadId: lead.id,
      evidenceType: "website_audit",
      sourceUrl: "https://dakartest.example",
      summary: "No HTTPS redirect",
    });
    const conv = service.createConversation(orgId, "local-owner", {
      leadId: lead.id,
      contactId: contact.id,
      channel: "email",
      subject: "Audit web",
    });
    service.addConversationMessage(orgId, "local-owner", conv.id, {
      direction: "inbound",
      body: "Bonjour, besoin d'un devis",
    });
    service.upsertNeedsQualification(orgId, "local-owner", lead.id, {
      problemStatement: "Refonte vitrine",
      solutionType: "vitrine",
      mustHaveFeatures: ["Responsive"],
    });
    service.createQuote(orgId, "local-owner", {
      leadId: lead.id,
      title: "Devis brouillon",
      lines: [{ label: "Site vitrine", quantity: 1, unitPrice: 500_000, unitCost: 200_000, estimatedDays: 7 }],
    });

    const previewRes = await invoke("GET", `/agency/${orgId}/companies/${company.id}/delete-preview`);
    expect(previewRes.status).toBe(200);
    expect(previewRes.json.preview.canDelete).toBe(true);
    expect(previewRes.json.preview.requiresNameConfirmation).toBe(true);
    expect(previewRes.json.preview.willDelete).toEqual({
      contacts: 1,
      leads: 1,
      evidence: 1,
      conversations: 1,
      messages: 1,
      quotes: 1,
      needs: 1,
    });

    const noConfirm = await invoke("DELETE", `/agency/${orgId}/companies/${company.id}`, {});
    expect(noConfirm.status).toBe(400);

    const wrongName = await invoke("DELETE", `/agency/${orgId}/companies/${company.id}`, {
      confirm: true,
      confirmName: "Wrong Name",
      cascade: true,
    });
    expect(wrongName.status).toBe(400);

    const noCascade = await invoke("DELETE", `/agency/${orgId}/companies/${company.id}`, {
      confirm: true,
      confirmName: "Dakar Test SARL",
      cascade: false,
    });
    expect(noCascade.status).toBe(400);

    const ok = await invoke("DELETE", `/agency/${orgId}/companies/${company.id}`, {
      confirm: true,
      confirmName: "dakar test sarl",
      cascade: true,
      reason: "Doublon de test",
    });
    expect(ok.status).toBe(200);
    expect(ok.json.deleted.deleted).toEqual({
      contacts: 1,
      leads: 1,
      evidence: 1,
      conversations: 1,
      messages: 1,
      quotes: 1,
      needs: 1,
    });

    expect(store.getCompany(orgId, company.id)).toBeUndefined();
    expect(store.getContact(orgId, contact.id)).toBeUndefined();
    expect(store.getLead(orgId, lead.id)).toBeUndefined();

    const auditEvents = service.listAuditFiltered(orgId, "local-owner", { action: "company.deleted" });
    expect(auditEvents).toHaveLength(1);
    expect(JSON.parse(auditEvents[0].payloadJson).reason).toBe("Doublon de test");
    expect(service.verifyAudit(orgId, "local-owner").valid).toBe(true);
  });

  it("blocks deletion when immutable RGPD consent or financial contracts exist and recommends archiving", async () => {
    const company = service.createCompany(orgId, "local-owner", { name: "Protected Corp" });
    const contact = service.createContact(orgId, "local-owner", {
      companyId: company.id,
      displayName: "Moussa Ndiaye",
      email: "moussa@protected.example",
    });
    service.recordConsent(orgId, "local-owner", {
      contactId: contact.id,
      channel: "email",
      purpose: "marketing",
      status: "granted",
      source: "web_form",
      proof: "form-submission-991",
      textVersion: "v1",
    });

    const ctPreview = await invoke("GET", `/agency/${orgId}/contacts/${contact.id}/delete-preview`);
    expect(ctPreview.status).toBe(200);
    expect(ctPreview.json.preview.canDelete).toBe(false);
    expect(ctPreview.json.preview.recommendArchive).toBe(true);
    expect(ctPreview.json.preview.blockers.length).toBeGreaterThan(0);

    const ctDel = await invoke("DELETE", `/agency/${orgId}/contacts/${contact.id}`, { confirm: true });
    expect(ctDel.status).toBe(409);

    const coDel = await invoke("DELETE", `/agency/${orgId}/companies/${company.id}`, {
      confirm: true,
      confirmName: "Protected Corp",
      cascade: true,
    });
    expect(coDel.status).toBe(409);

    // Separate company with a contract & won lead
    const co2 = service.createCompany(orgId, "local-owner", { name: "Contracted SA" });
    const lead2 = service.createLead(orgId, "local-owner", { companyId: co2.id });
    service.transitionLead(orgId, "local-owner", lead2.id, "researching");
    service.transitionLead(orgId, "local-owner", lead2.id, "qualified");
    const { quote } = service.createQuote(orgId, "local-owner", {
      leadId: lead2.id,
      title: "Devis signé",
      lines: [{ label: "Web App", quantity: 1, unitPrice: 1_000_000, unitCost: 400_000, estimatedDays: 10 }],
    });
    const { approval } = service.requestQuoteApproval(orgId, "local-owner", quote.id, "OK");
    service.decideApproval(orgId, "local-owner", approval.id, "approved", approval.payloadHash);
    service.sendQuote(orgId, "local-owner", quote.id);
    service.recordQuoteDecision(orgId, "local-owner", quote.id, "accepted");
    service.createContractFromQuote(orgId, "local-owner", { quoteId: quote.id });

    const qDel = await invoke("DELETE", `/agency/${orgId}/quotes/${quote.id}`, { confirm: true });
    expect(qDel.status).toBe(409);

    const leadPreview = await invoke("GET", `/agency/${orgId}/leads/${lead2.id}/delete-preview`);
    expect(leadPreview.status).toBe(200);
    expect(leadPreview.json.preview.canDelete).toBe(false);
    expect(leadPreview.json.preview.recommendArchive).toBe(true);

    const leadDel = await invoke("DELETE", `/agency/${orgId}/leads/${lead2.id}`, {
      confirm: true,
      cascade: true,
    });
    expect(leadDel.status).toBe(409);

    expect(service.verifyAudit(orgId, "local-owner").valid).toBe(true);
  });

  it("unlinks lead.contactId safely when deleting an unconsented contact and handles evidence, catalog, quote, mission, followup, and RBAC", async () => {
    const company = service.createCompany(orgId, "local-owner", { name: "Flex Co" });
    const contact = service.createContact(orgId, "local-owner", {
      companyId: company.id,
      displayName: "Temp Contact",
    });
    const lead = service.createLead(orgId, "local-owner", {
      companyId: company.id,
      contactId: contact.id,
    });

    const delContact = await invoke("DELETE", `/agency/${orgId}/contacts/${contact.id}`, { confirm: true });
    expect(delContact.status).toBe(200);
    expect(service.getLead(orgId, "local-owner", lead.id).contactId).toBe("");

    const ev = service.addEvidence(orgId, "local-owner", {
      companyId: company.id,
      leadId: lead.id,
      evidenceType: "company",
      sourceUrl: "https://flex.example",
      summary: "Public site",
    });
    expect((await invoke("DELETE", `/agency/${orgId}/evidence/${ev.id}`, { confirm: true })).status).toBe(200);

    const cat = service.createCatalogItem(orgId, "local-owner", {
      code: "TEMP-SVC",
      name: "Temp Service",
      category: "vitrine",
      description: "Temporary offer",
      estimatedDays: 3,
      priceMin: 100_000,
      priceBase: 150_000,
      priceMax: 200_000,
      estimatedCost: 50_000,
    });
    expect((await invoke("DELETE", `/agency/${orgId}/catalog/${cat.id}`, { confirm: true })).status).toBe(200);

    const { quote } = service.createQuote(orgId, "local-owner", {
      leadId: lead.id,
      title: "Draft Quote",
      lines: [{ label: "Audit", quantity: 1, unitPrice: 200_000, unitCost: 80_000, estimatedDays: 2 }],
    });
    expect((await invoke("DELETE", `/agency/${orgId}/quotes/${quote.id}`, { confirm: true })).status).toBe(200);

    const mission = service.createMission(orgId, "local-owner", {
      leadId: lead.id,
      agentRole: "prospecting",
      title: "Mission test",
    });
    service.updateMissionStatus(orgId, "local-owner", mission.id, "running");
    expect((await invoke("DELETE", `/agency/${orgId}/missions/${mission.id}`, { confirm: true })).status).toBe(409);
    service.updateMissionStatus(orgId, "local-owner", mission.id, "completed");
    expect((await invoke("DELETE", `/agency/${orgId}/missions/${mission.id}`, { confirm: true })).status).toBe(200);

    // RBAC: member and auditor cannot permanently delete
    service.addMember(orgId, "local-owner", "member-1", "member");
    service.addMember(orgId, "local-owner", "auditor-1", "auditor");
    expect(() => service.deleteLead(orgId, "member-1", lead.id, { confirm: true })).toThrow(/permission/i);
    expect(() => service.deleteLead(orgId, "auditor-1", lead.id, { confirm: true })).toThrow(/permission/i);

    expect(service.verifyAudit(orgId, "local-owner").valid).toBe(true);
  });
});
