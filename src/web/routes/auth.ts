import type { IncomingMessage } from "node:http";
import { SupabaseAuthError } from "../../auth/supabase.js";
import { HttpError, readJson, send, type Route, type WebContext } from "../http.js";

const SESSION_COOKIE = "amb_auth_session";

function readSessionCookie(req: IncomingMessage): string {
  const cookie = String(req.headers.cookie || "");
  for (const part of cookie.split(/;\s*/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return "";
}

function assertSameSite(req: IncomingMessage): void {
  const site = String(req.headers["sec-fetch-site"] || "");
  if (site === "cross-site") {
    throw new HttpError(403, "Cross-site requests are forbidden");
  }
}

function authError(error: unknown): never {
  if (error instanceof SupabaseAuthError) throw new HttpError(error.status, error.message);
  throw error;
}

export function authRoutes(ctx: WebContext): Route {
  return async (req, res, _url, seg, _p, method) => {
    if (seg[0] !== "auth") return false;
    if (!ctx.auth) throw new HttpError(503, "Auth service unavailable");

    try {
      if (seg.length === 2 && seg[1] === "session" && method === "GET") {
        const sid = readSessionCookie(req);
        return send(res, 200, await ctx.auth.status(sid));
      }

      if (seg.length === 2 && seg[1] === "config" && method === "PUT") {
        assertSameSite(req);
        const body = await readJson(req);
        const view = ctx.auth.configure(String(body?.supabaseUrl ?? ""), String(body?.supabasePublishableKey ?? ""));
        return send(res, 200, view);
      }

      if (seg.length === 2 && seg[1] === "login" && method === "POST") {
        assertSameSite(req);
        const body = await readJson(req);
        const result = await ctx.auth.signIn(String(body?.email ?? ""), String(body?.password ?? ""));
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(result.sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
        });
        res.end(JSON.stringify(result.view));
        return;
      }

      if (seg.length === 2 && seg[1] === "signup" && method === "POST") {
        assertSameSite(req);
        const body = await readJson(req);
        const result = await ctx.auth.signUp(
          String(body?.email ?? ""),
          String(body?.password ?? ""),
          String(body?.displayName ?? ""),
        );
        const headers: Record<string, string> = {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        };
        if (result.sessionId) {
          headers["set-cookie"] = `${SESSION_COOKIE}=${encodeURIComponent(result.sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ...result.view, confirmationRequired: result.confirmationRequired }));
        return;
      }

      if (seg.length === 2 && seg[1] === "logout" && method === "POST") {
        assertSameSite(req);
        const sid = readSessionCookie(req);
        const view = await ctx.auth.signOut(sid);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        });
        res.end(JSON.stringify(view));
        return;
      }

      return false;
    } catch (error) {
      authError(error);
    }
  };
}
