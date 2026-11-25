import { useEffect, useState } from "preact/hooks";
import { html, Icon, Notice, Spinner } from "../components/ui.js";
import { BotAvatar, MAIN_CHAR } from "../components/avatar.js";
import { LangSwitch } from "./onboarding.js";
import { api } from "../lib/api.js";
import { t } from "../lib/i18n.js";

export function AuthScreen({ auth, onAuthenticated, onConfigUpdated }) {
  const configured = !!auth?.configured;
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmNotice, setConfirmNotice] = useState(false);

  const [configOpen, setConfigOpen] = useState(!configured);
  const [supabaseUrl, setSupabaseUrl] = useState(auth?.supabaseUrl || "");
  const [publishableKey, setPublishableKey] = useState("");
  const [configBusy, setConfigBusy] = useState(false);
  const [configErr, setConfigErr] = useState("");
  const [configSaved, setConfigSaved] = useState(false);

  useEffect(() => {
    if (auth?.supabaseUrl && !supabaseUrl) setSupabaseUrl(auth.supabaseUrl);
    if (!auth?.configured) setConfigOpen(true);
  }, [auth?.configured, auth?.supabaseUrl]);

  const submitAuth = async (e) => {
    e.preventDefault();
    if (busy || !configured) return;
    setBusy(true);
    setErr("");
    setConfirmNotice(false);
    try {
      if (mode === "login") {
        const res = await api("/auth/login", { method: "POST", body: { email, password } });
        onAuthenticated?.(res);
      } else {
        const res = await api("/auth/signup", { method: "POST", body: { email, password, displayName } });
        if (res.confirmationRequired || !res.authenticated) {
          setConfirmNotice(true);
          setMode("login");
        } else {
          onAuthenticated?.(res);
        }
      }
    } catch (error) {
      setErr(error.message || t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async (e) => {
    e.preventDefault();
    if (configBusy) return;
    setConfigBusy(true);
    setConfigErr("");
    setConfigSaved(false);
    try {
      const res = await api("/auth/config", {
        method: "PUT",
        body: { supabaseUrl, supabasePublishableKey: publishableKey },
      });
      setPublishableKey("");
      setConfigSaved(true);
      setConfigOpen(false);
      onConfigUpdated?.(res);
    } catch (error) {
      setConfigErr(error.message || t("common.error"));
    } finally {
      setConfigBusy(false);
    }
  };

  return html`<main class="onboard" data-screen="auth">
    <${LangSwitch} />
    <div class="onboard-col auth-col">
      <div class="onboard-hero">
        <${BotAvatar} char=${MAIN_CHAR} size=${96} state=${busy ? "thinking" : err ? "error" : "idle"} lively pokeable greet />
        <h1>${t("auth.title")}</h1>
        <p>${t("auth.subtitle")}</p>
      </div>

      ${confirmNotice && html`<${Notice} tone="green"><strong>${t("auth.confirmEmailTitle")}</strong> — ${t("auth.confirmEmailBody")}<//>`}
      ${!configured && html`<${Notice} tone="amber">${t("auth.configRequired")}<//>`}

      <div class="auth-card">
        <div class="auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected=${mode === "login"} class=${mode === "login" ? "active" : ""} onClick=${() => { setMode("login"); setErr(""); }}>
            ${t("auth.tabSignIn")}
          </button>
          <button type="button" role="tab" aria-selected=${mode === "signup"} class=${mode === "signup" ? "active" : ""} onClick=${() => { setMode("signup"); setErr(""); }}>
            ${t("auth.tabSignUp")}
          </button>
        </div>

        <form class="auth-form" onSubmit=${submitAuth}>
          ${mode === "signup" && html`<label class="auth-field">
            <span>${t("auth.displayName")}</span>
            <input class="field" type="text" autocomplete="name" placeholder=${t("auth.displayNamePlaceholder")} value=${displayName} onInput=${(e) => setDisplayName(e.currentTarget.value)} />
          </label>`}
          <label class="auth-field">
            <span>${t("auth.email")}</span>
            <input class="field" type="email" autocomplete="email" required placeholder=${t("auth.emailPlaceholder")} value=${email} onInput=${(e) => { setEmail(e.currentTarget.value); setErr(""); }} />
          </label>
          <label class="auth-field">
            <span>${t("auth.password")}</span>
            <input class="field" type="password" autocomplete=${mode === "login" ? "current-password" : "new-password"} required minLength=${mode === "signup" ? 6 : undefined} placeholder=${t("auth.passwordHint")} value=${password} onInput=${(e) => { setPassword(e.currentTarget.value); setErr(""); }} />
          </label>
          ${err && html`<div class="err-text" role="alert">${err}</div>`}
          <button type="submit" class="btn primary lg block" disabled=${busy || !configured || !email.trim() || !password}>
            ${busy ? html`<${Spinner} /> ${t(mode === "login" ? "auth.signingIn" : "auth.signingUp")}` : t(mode === "login" ? "auth.signInBtn" : "auth.signUpBtn")}
          </button>
        </form>
      </div>

      <div class="auth-config">
        <div class="auth-config-head">
          <span class=${`auth-badge ${configured ? "ok" : "warn"}`}>${t(configured ? "auth.configuredBadge" : "auth.notConfiguredBadge")}</span>
          <button type="button" class="text" onClick=${() => setConfigOpen((v) => !v)}>
            <${Icon} name="gear" size="sm" /> ${t("auth.configToggle")}
          </button>
        </div>
        ${configSaved && html`<p class="hint" role="status">${t("auth.configSaved")}</p>`}
        ${configOpen && html`<form class="auth-form" onSubmit=${saveConfig}>
          <p class="hint">${t("auth.configHint")}</p>
          <label class="auth-field">
            <span>${t("auth.supabaseUrl")}</span>
            <input class="field" type="url" required placeholder=${t("auth.supabaseUrlPlaceholder")} value=${supabaseUrl} onInput=${(e) => { setSupabaseUrl(e.currentTarget.value); setConfigErr(""); }} />
          </label>
          <label class="auth-field">
            <span>${t("auth.publishableKey")}</span>
            <input class="field" type="password" required placeholder=${t("auth.publishableKeyPlaceholder")} value=${publishableKey} onInput=${(e) => { setPublishableKey(e.currentTarget.value); setConfigErr(""); }} />
          </label>
          ${configErr && html`<div class="err-text" role="alert">${configErr}</div>`}
          <button type="submit" class="btn outline block" disabled=${configBusy || !supabaseUrl.trim() || !publishableKey.trim()}>
            ${configBusy ? html`<${Spinner} /> ${t("auth.savingConfig")}` : t("auth.saveConfigBtn")}
          </button>
        </form>`}
      </div>

      <p class="hint auth-foot-hint">${t("auth.modelsHint")}</p>
    </div>
  </main>`;
}
