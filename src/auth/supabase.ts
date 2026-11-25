import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { saveConfigFile, type AppConfig } from "../config.js";
import { logger, registerSecret } from "../log.js";

const log = logger("auth");

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  emailConfirmedAt: string | null;
}

export interface AuthSessionView {
  provider: "supabase";
  configured: boolean;
  supabaseUrl: string;
  hasPublishableKey: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  expiresAt: number | null;
}

interface StoredAuthSession {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AuthUser;
  createdAt: number;
  updatedAt: number;
}

export class SupabaseAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "AUTH_ERROR",
  ) {
    super(message);
    this.name = "SupabaseAuthError";
  }
}

export function validateSupabaseConfig(urlInput: string, publishableKeyInput: string): {
  supabaseUrl: string;
  supabasePublishableKey: string;
} {
  const rawUrl = String(urlInput ?? "").trim().replace(/\/+$/, "");
  const rawKey = String(publishableKeyInput ?? "").trim();
  if (!rawUrl) throw new SupabaseAuthError(400, "L'URL du projet Supabase est requise", "INVALID_URL");

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SupabaseAuthError(400, "URL Supabase invalide", "INVALID_URL");
  }

  const isLocal = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    throw new SupabaseAuthError(400, "L'URL Supabase doit utiliser HTTPS (ou HTTP en local uniquement)", "INVALID_URL");
  }

  if (!rawKey || /\s/.test(rawKey)) {
    throw new SupabaseAuthError(400, "La clé publique Supabase (publishable/anon) est requise et ne doit contenir aucun espace", "INVALID_KEY");
  }
  if (rawKey.startsWith("sb_secret_") || rawKey.includes("service_role")) {
    throw new SupabaseAuthError(400, "Ne jamais utiliser une clé secrète (sb_secret / service_role) côté client : utilisez une clé publishable ou anon", "FORBIDDEN_SECRET_KEY");
  }

  return {
    supabaseUrl: parsed.origin + parsed.pathname.replace(/\/+$/, ""),
    supabasePublishableKey: rawKey,
  };
}

function normalizeUser(raw: Record<string, unknown> | undefined): AuthUser {
  const id = String(raw?.id ?? "").trim();
  const email = String(raw?.email ?? "").trim();
  if (!id || !email) {
    throw new SupabaseAuthError(502, "Réponse utilisateur Supabase incomplète", "INVALID_USER_PAYLOAD");
  }
  // Security: NEVER derive authorization roles from user_metadata (user-editable).
  const appMeta = (raw?.app_metadata && typeof raw.app_metadata === "object" ? raw.app_metadata : {}) as Record<string, unknown>;
  const userMeta = (raw?.user_metadata && typeof raw.user_metadata === "object" ? raw.user_metadata : {}) as Record<string, unknown>;
  const role = typeof appMeta.role === "string" && appMeta.role.trim() ? appMeta.role.trim() : "member";
  const displayName =
    String(userMeta.display_name ?? userMeta.full_name ?? userMeta.name ?? "").trim() ||
    email.split("@")[0] ||
    email;
  return {
    id,
    email,
    displayName,
    role,
    emailConfirmedAt: typeof raw?.email_confirmed_at === "string" ? raw.email_confirmed_at : null,
  };
}

function mapSupabaseErrorMessage(status: number, body: Record<string, unknown>): string {
  const code = String(body.error_code ?? body.code ?? body.error ?? "").toLowerCase();
  const raw = String(body.msg ?? body.error_description ?? body.message ?? "").trim();
  if (code.includes("invalid_credentials") || raw.toLowerCase().includes("invalid login credentials")) {
    return "Identifiants invalides (e-mail ou mot de passe incorrect)";
  }
  if (code.includes("email_not_confirmed") || raw.toLowerCase().includes("email not confirmed")) {
    return "Veuillez confirmer votre adresse e-mail avant de vous connecter";
  }
  if (code.includes("user_already_exists") || raw.toLowerCase().includes("already registered")) {
    return "Un compte existe déjà avec cette adresse e-mail";
  }
  if (code.includes("weak_password")) {
    return "Mot de passe trop faible (6 caractères minimum requis par Supabase)";
  }
  if (code.includes("over_request_rate_limit") || status === 429) {
    return "Trop de tentatives. Veuillez réessayer dans quelques instants";
  }
  return raw || `Erreur d'authentification Supabase (HTTP ${status})`;
}

export class SupabaseAuthService {
  private readonly sessionsFile: string;
  private readonly sessions = new Map<string, StoredAuthSession>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: {
    dataDir: string;
    config: AppConfig;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    this.sessionsFile = path.join(options.dataDir, "auth-sessions.json");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.loadSessions();
    if (options.config.auth.supabasePublishableKey) {
      registerSecret(options.config.auth.supabasePublishableKey);
    }
  }

  private isConfigured(): boolean {
    return !!(this.options.config.auth.supabaseUrl && this.options.config.auth.supabasePublishableKey);
  }

  private loadSessions(): void {
    try {
      if (!fs.existsSync(this.sessionsFile)) return;
      const parsed = JSON.parse(fs.readFileSync(this.sessionsFile, "utf8")) as StoredAuthSession[];
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (item && typeof item.id === "string" && typeof item.accessToken === "string" && item.user?.id) {
          registerSecret(item.accessToken);
          if (item.refreshToken) registerSecret(item.refreshToken);
          this.sessions.set(item.id, item);
        }
      }
    } catch (error) {
      log.warn("failed to load saved auth sessions", { message: (error as Error).message });
    }
  }

  private saveSessions(): void {
    fs.mkdirSync(this.options.dataDir, { recursive: true });
    const tmp = `${this.sessionsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.sessions.values()], null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.sessionsFile);
  }

  private requireConfig(): { supabaseUrl: string; supabasePublishableKey: string } {
    const { supabaseUrl, supabasePublishableKey } = this.options.config.auth;
    if (!supabaseUrl || !supabasePublishableKey) {
      throw new SupabaseAuthError(409, "Configurez d'abord l'URL et la clé publique Supabase", "NOT_CONFIGURED");
    }
    return { supabaseUrl, supabasePublishableKey };
  }

  private async callAuth(
    endpoint: string,
    init: { method?: string; body?: unknown; accessToken?: string },
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const { supabaseUrl, supabasePublishableKey } = this.requireConfig();
    const headers: Record<string, string> = {
      apikey: supabasePublishableKey,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.accessToken ? { authorization: `Bearer ${init.accessToken}` } : {}),
    };
    let response: Response;
    try {
      response = await this.fetchImpl(`${supabaseUrl}${endpoint}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (error) {
      throw new SupabaseAuthError(502, `Impossible de joindre Supabase Auth : ${(error as Error).message}`, "NETWORK_ERROR");
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new SupabaseAuthError(
        response.status >= 400 && response.status < 500 ? response.status : 502,
        mapSupabaseErrorMessage(response.status, data),
        String(data.error_code ?? data.error ?? "SUPABASE_ERROR"),
      );
    }
    return { status: response.status, data };
  }

  private createSessionFromPayload(payload: Record<string, unknown>): StoredAuthSession {
    const accessToken = String(payload.access_token ?? "").trim();
    const refreshToken = String(payload.refresh_token ?? "").trim();
    const expiresIn = Math.max(60, Number(payload.expires_in ?? 3600) || 3600);
    if (!accessToken) {
      throw new SupabaseAuthError(502, "Session Supabase invalide (access_token manquant)", "INVALID_SESSION");
    }
    registerSecret(accessToken);
    if (refreshToken) registerSecret(refreshToken);
    const now = this.now();
    const user = normalizeUser(payload.user as Record<string, unknown> | undefined);
    const session: StoredAuthSession = {
      id: crypto.randomBytes(32).toString("base64url"),
      accessToken,
      refreshToken,
      expiresAt: now + expiresIn * 1000,
      user,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.saveSessions();
    return session;
  }

  private view(session?: StoredAuthSession): AuthSessionView {
    return {
      provider: "supabase",
      configured: this.isConfigured(),
      supabaseUrl: this.options.config.auth.supabaseUrl,
      hasPublishableKey: !!this.options.config.auth.supabasePublishableKey,
      authenticated: !!session,
      user: session?.user ?? null,
      expiresAt: session?.expiresAt ?? null,
    };
  }

  configure(supabaseUrl: string, supabasePublishableKey: string): AuthSessionView {
    const validated = validateSupabaseConfig(supabaseUrl, supabasePublishableKey);
    registerSecret(validated.supabasePublishableKey);
    this.options.config.auth = {
      provider: "supabase",
      supabaseUrl: validated.supabaseUrl,
      supabasePublishableKey: validated.supabasePublishableKey,
    };
    saveConfigFile(this.options.dataDir, (file) => {
      file.auth = {
        provider: "supabase",
        supabaseUrl: validated.supabaseUrl,
        supabasePublishableKey: validated.supabasePublishableKey,
      };
    });
    return this.view();
  }

  async status(sessionId?: string): Promise<AuthSessionView> {
    if (!sessionId) return this.view();
    const existing = this.sessions.get(sessionId);
    if (!existing) return this.view();
    if (!this.isConfigured()) return this.view(existing);

    const now = this.now();
    if (existing.expiresAt - now > 60_000) {
      return this.view(existing);
    }
    if (!existing.refreshToken) {
      this.sessions.delete(sessionId);
      this.saveSessions();
      return this.view();
    }
    try {
      const { data } = await this.callAuth("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: existing.refreshToken },
      });
      const accessToken = String(data.access_token ?? "").trim();
      const refreshToken = String(data.refresh_token ?? existing.refreshToken).trim();
      const expiresIn = Math.max(60, Number(data.expires_in ?? 3600) || 3600);
      if (!accessToken) throw new SupabaseAuthError(401, "Session expirée");
      registerSecret(accessToken);
      if (refreshToken) registerSecret(refreshToken);
      existing.accessToken = accessToken;
      existing.refreshToken = refreshToken;
      existing.expiresAt = now + expiresIn * 1000;
      if (data.user) existing.user = normalizeUser(data.user as Record<string, unknown>);
      existing.updatedAt = now;
      this.saveSessions();
      return this.view(existing);
    } catch {
      this.sessions.delete(sessionId);
      this.saveSessions();
      return this.view();
    }
  }

  async signUp(emailInput: string, passwordInput: string, displayNameInput = ""): Promise<{
    view: AuthSessionView;
    sessionId?: string;
    confirmationRequired: boolean;
  }> {
    const email = String(emailInput ?? "").trim().toLowerCase();
    const password = String(passwordInput ?? "");
    const displayName = String(displayNameInput ?? "").trim().slice(0, 120);
    if (!email || !email.includes("@")) throw new SupabaseAuthError(400, "Adresse e-mail invalide", "INVALID_EMAIL");
    if (password.length < 6) throw new SupabaseAuthError(400, "Le mot de passe doit contenir au moins 6 caractères", "INVALID_PASSWORD");

    const { data } = await this.callAuth("/auth/v1/signup", {
      method: "POST",
      body: {
        email,
        password,
        ...(displayName ? { data: { display_name: displayName } } : {}),
      },
    });
    if (typeof data.access_token === "string" && data.access_token.trim()) {
      const session = this.createSessionFromPayload(data);
      return { view: this.view(session), sessionId: session.id, confirmationRequired: false };
    }
    return { view: this.view(), confirmationRequired: true };
  }

  async signIn(emailInput: string, passwordInput: string): Promise<{
    view: AuthSessionView;
    sessionId: string;
  }> {
    const email = String(emailInput ?? "").trim().toLowerCase();
    const password = String(passwordInput ?? "");
    if (!email || !email.includes("@")) throw new SupabaseAuthError(400, "Adresse e-mail invalide", "INVALID_EMAIL");
    if (!password) throw new SupabaseAuthError(400, "Le mot de passe est requis", "INVALID_PASSWORD");

    const { data } = await this.callAuth("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email, password },
    });
    const session = this.createSessionFromPayload(data);
    return { view: this.view(session), sessionId: session.id };
  }

  async signOut(sessionId?: string): Promise<AuthSessionView> {
    if (!sessionId) return this.view();
    const existing = this.sessions.get(sessionId);
    if (existing && this.isConfigured()) {
      await this.callAuth("/auth/v1/logout", {
        method: "POST",
        accessToken: existing.accessToken,
      }).catch(() => undefined);
    }
    this.sessions.delete(sessionId);
    this.saveSessions();
    return this.view();
  }
}
