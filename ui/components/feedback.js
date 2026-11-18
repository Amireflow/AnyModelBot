// 「意见和反馈」弹窗（打开方式和去向见 lib/feedback.js）。
// - 类型：遇到问题 / 功能建议 / 其他；用户写的描述；可选附带诊断信息（和「复制诊断信息」同一份，密钥已替换成 ***）。
// - 版本、系统等环境信息总会附带；从错误卡片打开时还附带那条报错和 Request ID。
// - 「预览」显示的就是要发出去的全文（后端生成，发送时用同一个函数）。不附带对话内容和截图。
// - 登录了 Modelflare：发送 → 进用户的 Modelflare 工单，客服回复会发邮件，也能在 Modelflare 的工单页看到。
//   没登录：GitHub（预填）或邮件；内容放不进链接时把全文复制到剪贴板，提示用户粘贴。
import { useEffect, useState } from "preact/hooks";
import { html, Button, Icon, Notice, Seg, Sheet, Spinner } from "./ui.js";
import { ErrorLine } from "./app-dialogs.js";
import { api } from "../lib/api.js";
import { FEEDBACK_KINDS, charCount, closeFeedback, emailFeedbackUrl, feedbackDialog, githubFeedbackUrl } from "../lib/feedback.js";
import { toast, useStore } from "../lib/store.js";
import { t } from "../lib/i18n.js";
import { usePresence } from "../design/motion.js";

const FALLBACK_INFO = { canSend: false, environment: "", version: "", minChars: 10, maxChars: 4000 };

function Done({ receipt, onClose }) {
  const suggestion = receipt.topic === "suggestion";
  return html`<div class="fb-done" role="status">
      <span class="fb-done-mark"><${Icon} name="check" size="md" /></span>
      <p>${t(suggestion ? "feedback.doneSuggestion" : "feedback.done")}</p>
    </div>
    <div class="actions">
      ${receipt.supportUrl && html`<a class="btn" href=${receipt.supportUrl} target="_blank" rel="noopener noreferrer">${t("feedback.viewOnModelflare")} ↗</a>`}
      <${Button} variant="primary" data-autofocus onClick=${onClose}>${t("feedback.close")}<//>
    </div>`;
}

function FeedbackSheet({ open, leaving, onClose }) {
  const [info, setInfo] = useState(null);
  const [kind, setKind] = useState(FEEDBACK_KINDS.includes(open.kind) ? open.kind : "bug");
  const [text, setText] = useState("");
  const [withDiag, setWithDiag] = useState(!!open.includeDiagnostics);
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState(null);

  useEffect(() => {
    api("/feedback").then(setInfo, () => setInfo(FALLBACK_INFO));
  }, []);

  const input = () => ({ kind, text, errorText: open.errorText || "", model: open.model || "", includeDiagnostics: withDiag });
  // 预览开着、或勾了诊断信息（GitHub / 邮件要把全文复制给用户粘贴）时，按输入取一份后端拼好的正文
  useEffect(() => {
    if (!showPreview && !withDiag) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      api("/feedback/preview", { method: "POST", body: input(), signal: ctl.signal }).then(setPreview, () => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [showPreview, withDiag, kind, text]);

  const n = charCount(text);
  const min = info?.minChars ?? FALLBACK_INFO.minChars;
  const max = info?.maxChars ?? FALLBACK_INFO.maxChars;
  const canSend = !!info?.canSend;

  const send = async (e) => {
    e?.preventDefault();
    if (busy || !canSend) return;
    if (n < min) return setError(t("feedback.tooShort", { min }));
    if (n > max) return setError(t("feedback.tooLong", { max }));
    setBusy(true);
    setError("");
    try {
      setReceipt(await api("/feedback", { method: "POST", body: { ...input(), relatedRequestId: open.relatedRequestId || "" } }));
    } catch (err) {
      setError(err.message || t("feedback.failed"));
    } finally {
      setBusy(false);
    }
  };

  // GitHub / 邮件：链接放不下全部内容（或附带了诊断信息）时，把全文复制到剪贴板，用户在打开的页面里粘贴
  const external = (link) => () => {
    if (!link.truncated && !withDiag) return;
    const full = preview?.body || [text.trim(), info?.environment, open.errorText].filter(Boolean).join("\n\n");
    navigator.clipboard?.writeText(full).then(() => toast(t("feedback.copiedForPaste")), () => {});
  };
  const linkArgs = { kind, text, version: info?.version, environment: info?.environment, errorText: open.errorText };
  const github = githubFeedbackUrl(linkArgs);
  const email = emailFeedbackUrl({ ...linkArgs, subject: t("feedback.emailSubject", { kind: t(`feedback.kind_${kind}`) }) });
  const githubLink = (cls) => html`<a class=${cls} href=${github.url} target="_blank" rel="noopener noreferrer" onClick=${external(github)}>${t("feedback.viaGithub")} ↗</a>`;
  const emailLink = (cls) => html`<a class=${cls} href=${email.url} onClick=${external(email)}>${t("feedback.viaEmail")} ↗</a>`;

  const prompt = t(`feedback.prompt_${kind}`);
  return html`<${Sheet} title=${t("feedback.title")} class="fb-sheet" leaving=${leaving} sticky=${!receipt && !!text.trim()} onClose=${onClose}>
    ${receipt
      ? html`<${Done} receipt=${receipt} onClose=${onClose} />`
      : html`<form class="fb-form" onSubmit=${send}>
      <${Seg} label=${t("feedback.kindLabel")} value=${kind} onChange=${(v) => { setKind(v); setError(""); }} options=${FEEDBACK_KINDS.map((k) => [k, t(`feedback.kind_${k}`)])} />
      <label class="set-field"><span class="k">${prompt}<span class="hint">${t(`feedback.promptHint_${kind}`)}</span></span>
        <textarea class="field" rows="6" maxlength=${max * 2} data-autofocus value=${text} aria-label=${prompt} disabled=${busy}
          onInput=${(e) => { setText(e.target.value); if (error) setError(""); }}></textarea>
        <span class=${`fb-count num${n > max ? " over" : ""}`}>${t("feedback.count", { n, max })}</span>
      </label>
      ${open.errorText && html`<div class="fb-attached"><span class="t-label">${t("feedback.withError")}</span><pre class="fb-pre">${open.errorText}</pre></div>`}
      <label class="sheet-check"><input type="checkbox" checked=${withDiag} disabled=${busy} onChange=${(e) => setWithDiag(e.target.checked)} />
        <span>${t("feedback.includeDiagnostics")}<span class="hint fb-check-sub">${t("feedback.includeDiagnosticsSub")}</span></span></label>
      ${info?.environment && html`<p class="hint fb-env">${t("feedback.alwaysIncluded", { environment: info.environment })}</p>`}
      <div class="fb-preview">
        <button type="button" class="btn sm ghost" aria-expanded=${showPreview} onClick=${() => setShowPreview((v) => !v)}>
          <${Icon} name=${showPreview ? "chevDown" : "chevRight"} size="xs" />${t("feedback.preview")}</button>
        ${showPreview && html`<pre class="fb-pre fb-preview-body" tabindex="0" aria-label=${t("feedback.preview")}>${preview ? preview.body : t("common.loading")}</pre>
          ${preview?.diagnosticsTrimmed && html`<p class="hint">${t("feedback.diagnosticsTrimmed")}</p>`}`}
      </div>
      ${!info
        ? html`<p class="hint"><${Spinner} /></p>`
        : canSend
          ? html`<p class="hint fb-where">${t("feedback.whereSignedIn")}</p>`
          : html`<${Notice}>${t("feedback.whereSignedOut")}<//>`}
      <${ErrorLine} text=${error} />
      <div class="actions">
        ${canSend
          ? html`<span class="fb-alt hint">${t("feedback.or")} ${githubLink("text")} · ${emailLink("text")}</span>
            <${Button} onClick=${onClose}>${t("common.cancel")}<//>
            <${Button} type="submit" variant="primary" loading=${busy} disabled=${busy}>${t("feedback.send")}<//>`
          : html`<${Button} onClick=${onClose}>${t("common.cancel")}<//>${emailLink("btn")}${githubLink("btn primary")}`}
      </div>
    </form>`}
  <//>`;
}

/** 挂在 main.js：store 里有值就显示 */
export function FeedbackHost() {
  const cur = useStore(feedbackDialog);
  const [last, setLast] = useState(cur);
  useEffect(() => void (cur && setLast(cur)), [cur]);
  const { mounted, leaving } = usePresence(!!cur);
  const shown = cur || last;
  if (!mounted || !shown) return null;
  return html`<${FeedbackSheet} key=${shown.at} open=${shown} leaving=${leaving} onClose=${() => !leaving && closeFeedback()} />`;
}
