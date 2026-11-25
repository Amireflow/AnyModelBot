import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgencyService,
  AgencyStore,
  buildWhatsAppDesktopUri,
  detectLocalWhatsAppDesktop,
  normalizeWhatsAppPhone,
} from "../src/agency/index.js";
import { agencyRoutes } from "../src/web/routes/agency.js";
import { HttpError, type WebContext } from "../src/web/http.js";

describe("Local WhatsApp Desktop Bridge", () => {
  const stores: AgencyStore[] = [];

  afterEach(() => {
    while (stores.length) stores.pop()!.close();
  });

  function makeInvoker(service: AgencyService) {
    const route = agencyRoutes({
      agency: service,
      app: { dataDir: process.cwd(), config: { ui: { lang: "fr" } } },
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
      const raw = {
        writableEnded: false,
        writeHead(s: number) {
          status = s;
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
      try {
        await route(request, raw as unknown as ServerResponse, url, seg, url.pathname, method);
      } catch (err) {
        if (err instanceof HttpError) {
          return { status: err.status, json: { error: err.message } };
        }
        throw err;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      return { status, json: text ? JSON.parse(text) : null };
    };
  }

  it("normalizes local and international phone numbers into E.164 and builds encoded WhatsApp Desktop URIs", () => {
    expect(normalizeWhatsAppPhone("+221 77 123 45 67", "SN")).toEqual({
      e164: "+221771234567",
      digits: "221771234567",
    });
    expect(normalizeWhatsAppPhone("77 123 45 67", "SN").e164).toBe("+221771234567");
    expect(normalizeWhatsAppPhone("06 12 34 56 78", "FR").e164).toBe("+33612345678");
    expect(normalizeWhatsAppPhone("0033612345678", "SN").e164).toBe("+33612345678");
    expect(() => normalizeWhatsAppPhone("123")).toThrow(/Invalid WhatsApp phone/);

    const uri = buildWhatsAppDesktopUri("77 888 99 00", "Bonjour & audit prêt à 100%", "SN");
    expect(uri.desktopUri).toBe(
      `whatsapp://send?phone=221778889900&text=${encodeURIComponent("Bonjour & audit prêt à 100%")}`,
    );
    expect(uri.webUrl).toBe(
      `https://wa.me/221778889900?text=${encodeURIComponent("Bonjour & audit prêt à 100%")}`,
    );
  });

  it("enforces consent for CRM contacts, opens desktop bridge dry-run, and logs conversation + audit", async () => {
    const store = new AgencyStore(":memory:");
    stores.push(store);
    const service = new AgencyService(store);
    const org = service.createOrganization({ name: "Amireflow", countryCode: "SN", currency: "XOF" }, "local-owner");
    const co = service.createCompany(org.id, "local-owner", { name: "Dakar BTP", countryCode: "SN" });
    const contact = service.createContact(org.id, "local-owner", {
      companyId: co.id,
      displayName: "Moussa Diop",
      phone: "771234567",
    });
    const lead = service.createLead(org.id, "local-owner", { companyId: co.id, contactId: contact.id });
    const conv = service.createConversation(org.id, "local-owner", {
      leadId: lead.id,
      channel: "whatsapp",
      subject: "Audit site Dakar BTP",
    });
    const invoke = makeInvoker(service);

    const statusRes = await invoke("GET", `/agency/${org.id}/whatsapp/desktop/status`);
    expect(statusRes.status).toBe(200);
    expect(typeof statusRes.json.status.available).toBe("boolean");

    // Blocked when targeting a CRM contact without active WhatsApp consent
    const blockedRes = await invoke("POST", `/agency/${org.id}/whatsapp/desktop/open`, {
      contactId: contact.id,
      text: "Bonjour Moussa",
      dryRun: true,
    });
    expect(blockedRes.status).toBe(409);

    service.recordConsent(org.id, "local-owner", {
      contactId: contact.id,
      channel: "whatsapp",
      purpose: "marketing",
      status: "granted",
      source: "crm_panel",
      proof: "confirmed-whatsapp",
      textVersion: "v1",
    });

    const openRes = await invoke("POST", `/agency/${org.id}/whatsapp/desktop/open`, {
      contactId: contact.id,
      conversationId: conv.id,
      text: "Bonjour Moussa, voici l'audit de votre site.",
      dryRun: true,
    });
    expect(openRes.status).toBe(200);
    expect(openRes.json.opened).toBe(true);
    expect(openRes.json.e164).toBe("+221771234567");
    expect(openRes.json.desktopUri).toContain("whatsapp://send?phone=221771234567&text=");
    expect(openRes.json.message?.body).toContain("Bonjour Moussa");

    const audit = service.listAuditFiltered(org.id, "local-owner", { action: "whatsapp.desktop_opened", limit: 10 });
    expect(audit).toHaveLength(1);
    expect(detectLocalWhatsAppDesktop().platform).toBe(process.platform);
  });
});
