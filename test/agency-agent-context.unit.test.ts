import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgencyError, AgencyService, AgencyStore } from "../src/agency/index.js";
import { Store } from "../src/store/db.js";
import { AgentManager } from "../src/agent/manager.js";

describe("commercial agent prospect context", () => {
  let agencyStore: AgencyStore | undefined;
  afterEach(() => {
    agencyStore?.close();
    agencyStore = undefined;
  });

  it("returns a source-linked dossier without raw consent proof or direct contact coordinates", () => {
    agencyStore = new AgencyStore(":memory:");
    const service = new AgencyService(agencyStore, { now: () => 1_800_000_000_000 });
    const org = service.createOrganization({ name: "Agency", countryCode: "SN", currency: "XOF" }, "local-owner");
    const company = service.createCompany(org.id, "local-owner", {
      name: "Baobab Systems", website: "https://baobab.example", industry: "Software", countryCode: "SN", city: "Dakar",
    });
    const contact = service.createContact(org.id, "local-owner", {
      companyId: company.id, displayName: "Awa Diallo", role: "Operations Director",
      email: "awa@example.test", phone: "+221770000000", preferredChannel: "whatsapp",
    });
    const lead = service.createLead(org.id, "local-owner", {
      companyId: company.id, contactId: contact.id, source: "Referral", notes: "Asked about a booking platform.",
    });
    service.addEvidence(org.id, "local-owner", {
      companyId: company.id, leadId: lead.id, evidenceType: "company_profile",
      sourceUrl: "https://baobab.example/about", summary: "The company operates a local booking service.", confidence: 0.8,
    });
    service.recordConsent(org.id, "local-owner", {
      contactId: contact.id, channel: "whatsapp", purpose: "service_followup", status: "granted",
      source: "website_form", proof: "private-proof-reference-123", textVersion: "consent-v1",
    });

    const dossier = service.getProspectDossier(org.id, "local-owner", lead.id);
    expect(dossier.lead.id).toBe(lead.id);
    expect(dossier.company.name).toBe("Baobab Systems");
    expect(dossier.contact).toEqual({
      id: contact.id, displayName: "Awa Diallo", role: "Operations Director", preferredChannel: "whatsapp",
    });
    expect(dossier.evidence[0]).toMatchObject({
      sourceUrl: "https://baobab.example/about", evidenceType: "company_profile",
    });
    expect(dossier.consents[0]).toMatchObject({
      channel: "whatsapp", purpose: "service_followup", status: "granted", proofRecorded: true,
    });
    const serialized = JSON.stringify(dossier);
    expect(serialized).not.toContain("private-proof-reference-123");
    expect(serialized).not.toContain("awa@example.test");
    expect(serialized).not.toContain("+221770000000");
  });

  it("keeps prospect searches tenant-scoped and pagination bounded", () => {
    agencyStore = new AgencyStore(":memory:");
    const service = new AgencyService(agencyStore);
    const a = service.createOrganization({ name: "A" }, "owner-a");
    const b = service.createOrganization({ name: "B" }, "owner-b");
    const aCompany = service.createCompany(a.id, "owner-a", { name: "Acme Dakar" });
    const bCompany = service.createCompany(b.id, "owner-b", { name: "Acme Dakar" });
    service.createLead(a.id, "owner-a", { companyId: aCompany.id, notes: "Booking project" });
    service.createLead(b.id, "owner-b", { companyId: bCompany.id, notes: "Booking project" });

    expect(service.searchProspects(a.id, "owner-a", { query: "booking" }).total).toBe(1);
    expect(service.searchProspects(b.id, "owner-b", { query: "booking" }).total).toBe(1);
    expect(() => service.searchProspects(a.id, "owner-b", { query: "booking" })).toThrowError(AgencyError);
    expect(() => service.searchProspects(a.id, "owner-a", { limit: 101 })).toThrowError(AgencyError);
  });
});

describe("commercial agent CRM bridge authorization", () => {
  let dataDir = "";
  let store: Store | undefined;
  let crm: AgencyStore | undefined;
  afterEach(() => {
    store?.close();
    crm?.close();
    store = undefined;
    crm = undefined;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = "";
  });

  it("permits only the active owner's private chat and denies background sessions", async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-agency-agent-"));
    store = new Store(":memory:");
    store.createBot({ id: "b", name: "Owner bot" });
    store.ensureConversation("b", "web", "console");
    const conversationId = "b:web:console";
    store.setAgentSession(conversationId, "b", "owner-session");
    crm = new AgencyStore(":memory:");
    const service = new AgencyService(crm);
    const org = service.createOrganization({ name: "Owner agency" }, "local-owner");

    let owner = true;
    const manager = new AgentManager({
      store, dataDir, runtimeDir: "/runtime", upstream: () => ({ baseUrl: "", apiKey: "" }),
      enabled: false, ownsConversation: () => owner,
    });
    manager.attachAgencyService(service);
    manager.host("b");
    manager.turnsInProgress.set(conversationId, { botId: "b" } as never);
    const invoke = (sessionId: string) => (manager as any).agencyOp({
      botId: "b", sessionId, op: "list_organizations", args: {},
    }, new AbortController().signal) as Promise<{ text?: string; error?: string }>;

    const allowed = await invoke("owner-session");
    expect(allowed.error).toBeUndefined();
    expect(JSON.parse(allowed.text ?? "{}").organizations[0].id).toBe(org.id);
    owner = false;
    expect((await invoke("owner-session")).error).toMatch(/owner's active private conversation/i);
    owner = true;
    expect((await invoke("task-background-1")).error).toMatch(/background or scheduled sessions/i);
    manager.turnsInProgress.clear();
    expect((await invoke("owner-session")).error).toMatch(/owner's active private conversation/i);
  });
});
