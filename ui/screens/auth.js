import { useState } from "preact/hooks";
import { html, Notice, Spinner } from "../components/ui.js";
import { BotAvatar, MAIN_CHAR } from "../components/avatar.js";
import { LangSwitch } from "./onboarding.js";
import { api } from "../lib/api.js";
import { t } from "../lib/i18n.js";

export function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmNotice, setConfirmNotice] = useState(false);

  const submitAuth = async (e) => {
    e.preventDefault();
    if (busy) return;
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

  return html`<main class="onboard" data-screen="auth">
    <${LangSwitch} />
    <div class="onboard-col auth-col">
      <div class="onboard-hero">
        <${BotAvatar} char=${MAIN_CHAR} size=${88} state=${busy ? "thinking" : err ? "error" : "idle"} lively pokeable greet />
        <h1>${t("auth.title")}</h1>
        <p>${t("auth.subtitle")}</p>
      </div>

      ${confirmNotice && html`<${Notice} tone="green"><strong>${t("auth.confirmEmailTitle")}</strong> — ${t("auth.confirmEmailBody")}<//>`}

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
          <button type="submit" class="btn primary lg block" disabled=${busy || !email.trim() || !password}>
            ${busy ? html`<${Spinner} /> ${t(mode === "login" ? "auth.signingIn" : "auth.signingUp")}` : t(mode === "login" ? "auth.signInBtn" : "auth.signUpBtn")}
          </button>
        </form>
      </div>
    </div>
  </main>`;
}
