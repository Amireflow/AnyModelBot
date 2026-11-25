import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgencyService,
  AgencyStore,
  createAgencyBackup,
  detectDeployAdapters,
  detectHeadlessBrowser,
  executeProjectDeploy,
  exportCompaniesCsv,
  exportLeadsCsv,
  getLlmUsageSummary,
  listAgencyBackups,
  recordLlmUsage,
  resolveProjectFile,
  runDeploymentHealthCheck,
  runVisualE2eQa,
  toSafeCsvCell,
} from "../src/agency/index.js";
import { agencyRoutes } from "../src/web/routes/agency.js";
import { HttpError, type WebContext } from "../src/web/http.js";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function makeTempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  while (servers.length) {
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  }
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("Visual E2E QA, Deployment Adapters & Ops Tools", () => {
  it("runs Visual E2E QA against a live HTTP page (including headless browser screenshots if available)", async () => {
    const dataDir = makeTempDir("amb-qa-e2e-");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Client App E2E</title></head><body><h1>Dashboard Client OK</h1><p>Tout fonctionne.</p></body></html>`,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    const targetUrl = `http://127.0.0.1:${addr.port}/`;

    const store = new AgencyStore(path.join(dataDir, "agency.db"));
    try {
      const service = new AgencyService(store);
      const org = service.createOrganization({ name: "Amireflow", countryCode: "SN", currency: "XOF" }, "local-owner");
      const created = service.createDirectProject(org.id, "local-owner", { title: "Client App" });

      const browser = detectHeadlessBrowser();
      const qa = await runVisualE2eQa({
        dataDir,
        project: created.project,
        url: targetUrl,
      });

      expect(qa.passed).toBe(true);
      expect(qa.httpStatus).toBe(200);
      expect(qa.hasViewportMeta).toBe(true);
      expect(qa.title).toBe("Client App E2E");
      expect(qa.renderedTextLength).toBeGreaterThan(10);
      expect(qa.qaItems).toHaveLength(2);
      expect(fs.existsSync(resolveProjectFile(dataDir, created.project, qa.reportPath).absPath)).toBe(true);

      if (browser.available) {
        expect(qa.screenshots.desktop).toContain("desktop.png");
        expect(qa.screenshots.mobile).toContain("mobile.png");
        expect(fs.existsSync(resolveProjectFile(dataDir, created.project, qa.screenshots.desktop!).absPath)).toBe(true);
        expect(fs.existsSync(resolveProjectFile(dataDir, created.project, qa.screenshots.mobile!).absPath)).toBe(true);
      }
    } finally {
      store.close();
    }
  }, 35_000);

  it("supports deployment health checks, dry-run deploys, SQLite backups, CSV injection safety, and LLM usage ledger", async () => {
    const dataDir = makeTempDir("amb-ops-tools-");
    const store = new AgencyStore(path.join(dataDir, "agency.db"));
    try {
      const service = new AgencyService(store);
      const org = service.createOrganization({ name: "Ops Agency", countryCode: "SN", currency: "XOF" }, "local-owner");
      const co = service.createCompany(org.id, "local-owner", { name: "=SUM(1+1) Evil Corp", website: "https://evil.example" });
      const lead = service.createLead(org.id, "local-owner", { companyId: co.id, source: "+cmd|calc", notes: "Lead note" });
      const created = service.createDirectProject(org.id, "local-owner", { title: "Ops App" });

      // CSV formula neutralization
      expect(toSafeCsvCell("=1+1")).toBe("'=1+1");
      expect(toSafeCsvCell("+CMD")).toBe("'+CMD");
      const compCsv = exportCompaniesCsv([co]);
      expect(compCsv).toContain("'=SUM(1+1) Evil Corp");
      const leadCsv = exportLeadsCsv([lead], [co]);
      expect(leadCsv).toContain("'+cmd|calc");

      // Backup & listing
      const bkp = createAgencyBackup(dataDir);
      expect(bkp.filename).toMatch(/^agency-backup-.*\.db$/);
      expect(listAgencyBackups(dataDir)).toHaveLength(1);

      // LLM ledger
      recordLlmUsage(dataDir, {
        organizationId: org.id,
        projectId: created.project.id,
        feature: "prospecting_deep_search",
        model: "GLM-5.3",
        inputChars: 2000,
        outputChars: 1200,
      });
      const usage = getLlmUsageSummary(dataDir, org.id);
      expect(usage.totalCalls).toBe(1);
      expect(usage.totalTokens).toBe(800);
      expect(usage.estimatedCostUsd).toBeGreaterThan(0);

      // Deploy adapters & dry-run
      const adapters = detectDeployAdapters();
      expect(adapters.map((a) => a.id)).toContain("docker_compose");

      const deploy = await executeProjectDeploy({
        dataDir,
        project: created.project,
        adapter: "docker_compose",
        dryRun: true,
      });
      expect(deploy.ok).toBe(true);
      expect(deploy.output).toContain("[dry-run] adapter=docker_compose");

      // Health check mock
      const healthy = await runDeploymentHealthCheck("https://app.example/health", (async () =>
        new Response("ok", { status: 200 })) as typeof fetch);
      expect(healthy.healthy).toBe(true);
      expect(healthy.statusCode).toBe(200);

      // HTTP routes check
      const route = agencyRoutes({ agency: service, app: { dataDir, config: { dataDir, ui: { lang: "fr" } } } } as unknown as WebContext);
      const invoke = async (method: string, routePath: string, body?: unknown) => {
        const req = Readable.from(body ? [JSON.stringify(body)] : []) as unknown as IncomingMessage;
        Object.defineProperty(req, "headers", { value: { "content-type": body ? "application/json" : "", "sec-fetch-site": "same-origin" } });
        const chunks: Buffer[] = [];
        let status = 0;
        const res = {
          writeHead(s: number) { status = s; return res; },
          write(c: string | Buffer) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true; },
          end(c?: string | Buffer) { if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); },
        };
        const url = new URL(`http://127.0.0.1:3600/amb/api${routePath}`);
        const seg = url.pathname.replace(/^\/amb\/api\//, "").split("/");
        try { await route(req, res as unknown as ServerResponse, url, seg, url.pathname, method); }
        catch (err) { if (err instanceof HttpError) return { status: err.status, text: err.message, json: null }; throw err; }
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* csv */ }
        return { status, text, json };
      };

      const csvRes = await invoke("GET", `/agency/${org.id}/ops/export/companies.csv`);
      expect(csvRes.status).toBe(200);
      expect(csvRes.text).toContain("'=SUM(1+1) Evil Corp");

      const usageRes = await invoke("GET", `/agency/${org.id}/ops/llm-usage`);
      expect(usageRes.status).toBe(200);
      expect(usageRes.json.summary.totalCalls).toBe(1);
    } finally {
      store.close();
    }
  });
});
