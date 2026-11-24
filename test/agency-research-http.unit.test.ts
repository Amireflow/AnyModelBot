import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { agencyRoutes } from "../src/web/routes/agency.js";
import type { WebContext } from "../src/web/http.js";
import { AgencyService, AgencyStore } from "../src/agency/index.js";

describe("Agency research evidence HTTP API", () => {
  let store: AgencyStore;
  let service: AgencyService;
  let route: ReturnType<typeof agencyRoutes>;
  let sequence: number;

  beforeEach(() => {
    sequence = 0;
    store = new AgencyStore(":memory:");
    service = new AgencyService(store, {
      now: () => 1_800_000_000_000,
      id: () => "research-http-" + (++sequence),
    });
    route = agencyRoutes({ agency: service } as WebContext);
  });
  afterEach(() => store.close());

  async function invoke(method: string, path: string, body?: unknown) {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
    Object.defineProperty(request, "headers", { value: {
      "content-type": body === undefined ? "" : "application/json",
      "sec-fetch-site": "same-origin",
    } });
    const raw = {
      status: 0,
      payload: "",
      writeHead(status: number) { raw.status = status; return raw; },
      end(payload?: string) { raw.payload = String(payload ?? ""); return raw; },
    };
    const response = raw as unknown as ServerResponse & { status: number; payload: string };
    const segments = path.split("/").filter(Boolean);
    await route(request, response, new URL("http://localhost/amb/api" + path), segments, path, method);
    return { status: response.status, body: response.payload ? JSON.parse(response.payload) : null };
  }

  it("creates and lists evidence with an updated quality assessment", async () => {
    const org = service.createOrganization({ name: "Local agency", countryCode: "SN" }, "local-owner");
    const company = service.createCompany(org.id, "local-owner", { name: "Example Ltd" });
    const created = await invoke("POST", "/agency/" + org.id + "/companies/" + company.id + "/evidence", {
      evidenceType: "company_profile",
      sourceUrl: "https://example.com/about",
      summary: "The official website describes the company's products.",
      confidence: 0.9,
    });
    expect(created.status).toBe(201);
    expect(created.body.evidence.sourceUrl).toBe("https://example.com/about");
    expect(created.body.assessment).toMatchObject({
      modelVersion: "research-evidence-v1",
      evidenceCount: 1,
      status: "developing",
    });

    const listed = await invoke("GET", "/agency/" + org.id + "/companies/" + company.id + "/evidence");
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.assessment.evidenceCount).toBe(1);
  });
});
