import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../src/config.js";
import { SupabaseAuthError, SupabaseAuthService, validateSupabaseConfig } from "../src/auth/supabase.js";
import { authRoutes } from "../src/web/routes/auth.js";
import { HttpError, type WebContext } from "../src/web/http.js";

describe("Supabase Auth service & HTTP routes", () => {
  let tmpDir: string;
  let mockServer: http.Server;
  let mockBaseUrl: string;
  let requests: Array<{ path: string; method: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let nextMode: "immediate" | "confirm" | "invalid" = "immediate";

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-supa-auth-"));
    requests = [];
    nextMode = "immediate";

    mockServer = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url || "", method: req.method || "GET", headers: req.headers, body });

      if (req.headers.apikey !== "sb_publishable_test_key") {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ message: "Missing apikey" }));
        return;
      }

      if (req.url === "/auth/v1/signup" && req.method === "POST") {
        if (nextMode === "confirm") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            id: "user-1",
            email: body.email,
          }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          access_token: "jwt_signup_1",
          refresh_token: "ref_signup_1",
          expires_in: 3600,
          user: {
            id: "user-1",
            email: body.email,
            app_metadata: { role: "owner" },
            user_metadata: { role: "spoofed_admin", display_name: body.data?.display_name || "Khadim" },
            email_confirmed_at: "2026-11-24T23:00:00Z",
          },
        }));
        return;
      }

      if (req.url === "/auth/v1/token?grant_type=password" && req.method === "POST") {
        if (nextMode === "invalid") {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
            error_code: "invalid_credentials",
            msg: "Invalid login credentials",
          }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          access_token: "jwt_login_1",
          refresh_token: "ref_login_1",
          expires_in: 3600,
          user: {
            id: "user-2",
            email: body.email,
            app_metadata: { role: "admin" },
            user_metadata: { role: "super_owner", full_name: "Amireflow Admin" },
          },
        }));
        return;
      }

      if (req.url === "/auth/v1/token?grant_type=refresh_token" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          access_token: "jwt_refreshed_2",
          refresh_token: "ref_login_2",
          expires_in: 3600,
          user: {
            id: "user-2",
            email: "admin@amireflow.test",
            app_metadata: { role: "admin" },
            user_metadata: { display_name: "Amireflow Admin" },
          },
        }));
        return;
      }

      if (req.url === "/auth/v1/logout" && req.method === "POST") {
        if (req.headers.authorization !== "Bearer jwt_login_1" && req.headers.authorization !== "Bearer jwt_refreshed_2") {
          res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ message: "Unauthorized" }));
          return;
        }
        res.writeHead(204).end();
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = mockServer.address() as { port: number };
    mockBaseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates Supabase URL & rejects secret keys explicitly", () => {
    expect(() => validateSupabaseConfig("http://remote.example.com", "sb_publishable_x")).toThrowError(SupabaseAuthError);
    expect(() => validateSupabaseConfig("https://proj.supabase.co", "sb_secret_forbidden")).toThrowError(SupabaseAuthError);
    expect(() => validateSupabaseConfig("https://proj.supabase.co", "service_role_key")).toThrowError(SupabaseAuthError);
    expect(validateSupabaseConfig("https://proj.supabase.co/", "sb_publishable_ok")).toEqual({
      supabaseUrl: "https://proj.supabase.co",
      supabasePublishableKey: "sb_publishable_ok",
    });
  });

  it("handles signup, confirmation required, login headers, app_metadata roles, token refresh, and logout over HTTP", async () => {
    const config = loadConfig({ dataDir: tmpDir, env: {} });
    expect(config.ui.lang).toBe("system");
    const authService = new SupabaseAuthService({ dataDir: tmpDir, config });
    const route = authRoutes({ auth: authService } as unknown as WebContext);

    const invoke = async (method: string, pathUrl: string, body?: unknown, cookie = "", fetchSite = "same-origin") => {
      const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
      Object.defineProperty(request, "headers", {
        value: {
          "content-type": body === undefined ? "" : "application/json",
          cookie,
          "sec-fetch-site": fetchSite,
        },
      });
      const headersOut: Record<string, string> = {};
      const raw = {
        status: 0,
        payload: "",
        writeHead(status: number, hdrs?: Record<string, string>) {
          raw.status = status;
          if (hdrs) Object.assign(headersOut, hdrs);
          return raw;
        },
        end(payload?: string) {
          raw.payload = String(payload ?? "");
          return raw;
        },
      };
      const response = raw as unknown as ServerResponse;
      const url = new URL("http://localhost/amb/api" + pathUrl);
      const segments = url.pathname.replace(/^\/amb\/api\/?/, "").split("/").filter(Boolean);
      try {
        await route(request, response, url, segments, pathUrl, method);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        raw.writeHead(error.status);
        raw.end(JSON.stringify({ error: error.message }));
      }
      return {
        status: raw.status,
        headers: headersOut,
        body: raw.payload ? JSON.parse(raw.payload) : null,
      };
    };

    // Unconfigured initially
    const initial = await invoke("GET", "/auth/session");
    expect(initial.status).toBe(200);
    expect(initial.body.configured).toBe(false);
    expect(initial.body.authenticated).toBe(false);

    // Rejects cross-site config update
    const csrfBlocked = await invoke("PUT", "/auth/config", {
      supabaseUrl: mockBaseUrl,
      supabasePublishableKey: "sb_publishable_test_key",
    }, "", "cross-site");
    expect(csrfBlocked.status).toBe(403);

    // Save valid local mock Supabase config
    const cfgRes = await invoke("PUT", "/auth/config", {
      supabaseUrl: mockBaseUrl,
      supabasePublishableKey: "sb_publishable_test_key",
    });
    expect(cfgRes.status).toBe(200);
    expect(cfgRes.body.configured).toBe(true);

    // Signup with email confirmation pending
    nextMode = "confirm";
    const confirmSignup = await invoke("POST", "/auth/signup", {
      email: "new@amireflow.test",
      password: "Password123!",
      displayName: "Khadim",
    });
    expect(confirmSignup.status).toBe(200);
    expect(confirmSignup.body.confirmationRequired).toBe(true);
    expect(confirmSignup.body.authenticated).toBe(false);
    expect(confirmSignup.headers["set-cookie"]).toBeUndefined();

    // Signup with immediate session: role comes strictly from app_metadata, NOT user_metadata
    nextMode = "immediate";
    const immediateSignup = await invoke("POST", "/auth/signup", {
      email: "owner@amireflow.test",
      password: "Password123!",
      displayName: "Khadim",
    });
    expect(immediateSignup.status).toBe(200);
    expect(immediateSignup.body.authenticated).toBe(true);
    expect(immediateSignup.body.user.role).toBe("owner");
    expect(immediateSignup.headers["set-cookie"]).toContain("amb_auth_session=");

    // Login: sends ONLY apikey (not Authorization Bearer) to /auth/v1/token
    const loginRes = await invoke("POST", "/auth/login", {
      email: "admin@amireflow.test",
      password: "Password123!",
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.authenticated).toBe(true);
    expect(loginRes.body.user.role).toBe("admin"); // ignored spoofed super_owner in user_metadata
    const tokenReq = requests.find((r) => r.path.includes("grant_type=password"))!;
    expect(tokenReq.headers.apikey).toBe("sb_publishable_test_key");
    expect(tokenReq.headers.authorization).toBeUndefined();

    const sessionCookie = loginRes.headers["set-cookie"].split(";")[0];
    const checkSession = await invoke("GET", "/auth/session", undefined, sessionCookie);
    expect(checkSession.status).toBe(200);
    expect(checkSession.body.authenticated).toBe(true);
    expect(checkSession.body.user.email).toBe("admin@amireflow.test");

    // Logout revokes session on Supabase and clears cookie
    const logoutRes = await invoke("POST", "/auth/logout", {}, sessionCookie);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.authenticated).toBe(false);
    expect(logoutRes.headers["set-cookie"]).toContain("Max-Age=0");

    const afterLogout = await invoke("GET", "/auth/session", undefined, sessionCookie);
    expect(afterLogout.body.authenticated).toBe(false);
  });
});
