import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AgencyService, AgencyStore } from "../src/agency/index.js";
import { agencyRoutes } from "../src/web/routes/agency.js";
import { HttpError, type WebContext } from "../src/web/http.js";

describe("Agency Company Research import HTTP routes", () => {
  let dataDir: string;
  let store: AgencyStore;
  let service: AgencyService;
  let route: ReturnType<typeof agencyRoutes>;
  let orgId: string;
  let companyId: string;
  let researchPrompt = "";
  let researchRunCalls = 0;

  beforeEach(() => {
    researchPrompt = "";
    researchRunCalls = 0;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-research-http-"));
    const appRoot = path.join(dataDir, "workspaces", "cat-company-research", "app");
    const jobId = "job-20261124-acme";
    fs.mkdirSync(path.join(appRoot, "jobs", jobId), { recursive: true });
    fs.writeFileSync(path.join(appRoot, "state.json"), JSON.stringify({
      jobs: [{
        id: jobId, company: "Acme Inc.", status: "completed",
        reportPath: "app/jobs/" + jobId + "/report.md",
        sourcesPath: "app/jobs/" + jobId + "/sources.json",
        updatedAt: "2026-11-24T10:00:00Z",
      }],
    }));
    fs.writeFileSync(path.join(appRoot, "jobs", jobId, "report.md"), "# Acme Inc. research report\n");
    fs.writeFileSync(path.join(appRoot, "jobs", jobId, "sources.json"), JSON.stringify([
      { url: "https://acme.example/about", title: "About Acme", domain: "company", used: true },
    ]));
    fs.writeFileSync(path.join(appRoot, "jobs", jobId, "curated.json"), JSON.stringify({
      financial: [], news: [], industry: [],
      company: [{
        url: "https://acme.example/about",
        summary: "The company publishes its product range on the official website.",
        publishedAt: "2026-10-12",
      }],
    }));

    store = new AgencyStore(":memory:");
    service = new AgencyService(store, {
      now: () => 1_800_000_000_000,
      id: (() => { let n=0; return () => "http-research-" + (++n); })(),
    });
    const org = service.createOrganization({ name: "Agency", countryCode: "SN" }, "local-owner");
    orgId = org.id;
    companyId = service.createCompany(orgId, "local-owner", {
      name: "Acme Inc.", website: "https://acme.example/",
    }).id;

    const context = {
      app: {
        config: { dataDir },
        agent: { available: true },
        runtime: { busyBots: () => [] },
        tasks: { busy: () => false },
        store: {
          getBot: (id: string) => id === "cat-company-research"
            ? { id, origin: "catalog", app: { catalogId: "company-research" } }
            : undefined,
        },
      },
      agency: service,
      startLive: (_botId: string, text: string) => ({ id: "research-turn", done: false, text, subscribe: () => () => undefined }),
      runLive: async (_turn: unknown, event: { parts: Array<{ text?: string }> }) => {
        researchRunCalls++;
        researchPrompt = event.parts.map(part => part.text || "").join("\n");
      },
      live: { bots: () => [], end: () => undefined },
    } as unknown as WebContext;
    route = agencyRoutes(context);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function invoke(method: string, pathname: string, body?: unknown) {
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
    const segments = pathname.split("/").filter(Boolean);
    try {
      await route(request, response, new URL("http://localhost/amb/api" + pathname), segments, pathname, method);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      response.writeHead(error.status);
      response.end(JSON.stringify({ error: error.message }));
    }
    return { status: response.status, body: response.payload ? JSON.parse(response.payload) : null };
  }



  it("blocks starting a second company research job in the shared workspace", async () => {
    const statePath = path.join(dataDir, "workspaces", "cat-company-research", "app", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.jobs.push({
      id: "job-active-other-company",
      company: "Another Company",
      status: "researching",
      progress: 35,
      updatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(statePath, JSON.stringify(state));

    const pathname = "/agency/" + orgId + "/companies/" + companyId + "/research/start";
    const started = await invoke("POST", pathname, {});
    expect(started.status).toBe(409);
    expect(started.body.error).toContain("active job");
    expect(researchRunCalls).toBe(0);
  });

  it("starts a full research run in the installed Company Research bot conversation", async () => {
    const pathname = "/agency/" + orgId + "/companies/" + companyId + "/research/start";
    const started = await invoke("POST", pathname, {});
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      accepted: true, turnId: "research-turn", companyId, botId: "cat-company-research",
    });
    expect(researchRunCalls).toBe(1);
    expect(researchPrompt).toContain("Acme Inc.");
    expect(researchPrompt).toContain("https://acme.example/");
    expect(researchPrompt).toContain("full Company Research workflow");
  });

  it("lists completed jobs and imports a report into the selected company", async () => {
    const base = "/agency/" + orgId + "/companies/" + companyId + "/research";
    const jobs = await invoke("GET", base + "/jobs");
    expect(jobs.status).toBe(200);
    expect(jobs.body.items).toHaveLength(1);

    const imported = await invoke("POST", base + "/import", { jobId: jobs.body.items[0].id });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({
      job: { id: jobs.body.items[0].id },
      imported: 1, duplicates: 0,
    });

    const repeated = await invoke("POST", base + "/import", { jobId: jobs.body.items[0].id });
    expect(repeated.body).toMatchObject({ imported: 0, duplicates: 1 });
    expect(service.listEvidence(orgId, "local-owner", companyId)).toHaveLength(1);
    expect(service.listEvidence(orgId, "local-owner", companyId)[0].summary)
      .toContain("The company publishes its product range");
  });
});
