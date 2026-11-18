/**
 * 应用内反馈（「意见和反馈」）：把用户写的内容、环境信息、可选的报错和诊断信息拼成一条工单正文，
 * 经 Modelflare 的 connected-app 接口（POST /api/connected-app/feedback）提交到用户自己的 Modelflare 工单。
 * 客服在 Modelflare 后台回复，回复会发邮件，也能在 Modelflare 控制台的工单页看到。
 *
 * 只在用户点「发送」时提交；发送前界面用同一个函数生成预览，发出去的就是预览里的内容。
 * 不附带对话内容和截图；诊断信息由用户勾选，和「复制诊断信息」是同一份（密钥已替换成 ***）。
 * 整段正文最后再脱敏一次，防止用户把密钥贴进描述或报错里。
 */
import fs from "node:fs";
import os from "node:os";
import type { App } from "./app.js";
import { ApiError, type FeedbackKind } from "./account/client.js";
import { diagnosticsReport } from "./diagnostics.js";
import { lang, t } from "./i18n/index.js";
import { redactText } from "./log.js";
import { appVersion } from "./version.js";

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ["bug", "suggestion", "other"];

/** Modelflare 一条工单消息最多 8000 字（按 Unicode 字符算），留一点余量 */
export const FEEDBACK_BODY_MAX = 7800;
/** 用户自己写的部分 */
export const FEEDBACK_TEXT_MIN = 10;
export const FEEDBACK_TEXT_MAX = 4000;
/** 附带的报错最多这么长；诊断信息用剩下的额度 */
const ERROR_MAX = 1500;
/** 诊断信息取最近这么多行日志，再按剩余额度裁 */
const DIAG_LOG_LINES = 120;

export interface FeedbackEnvironment {
  version: string;
  os: string;
  platform: string;
  arch: string;
  runtime: "desktop" | "cli" | "docker";
  lang: string;
}

export interface FeedbackParts {
  /** 用户自己写的内容 */
  text: string;
  /** 用户在反馈的那条报错（从对话里的错误卡片打开时带上） */
  errorText?: string;
  model?: string;
  /** model 是应用的默认模型，不是出错那次用的模型 */
  modelIsDefault?: boolean;
  /** 诊断信息全文（已脱敏）；没勾选时不传 */
  diagnostics?: string;
}

export interface ComposedFeedback {
  body: string;
  /** 诊断信息太长、中间省略了一部分 */
  diagnosticsTrimmed: boolean;
}

const chars = (s: string) => [...s].length;
const cut = (s: string, max: number) => {
  const a = [...s];
  return a.length <= max ? s : `${a.slice(0, Math.max(0, max - 1)).join("")}…`;
};

export function feedbackEnvironment(): FeedbackEnvironment {
  return {
    version: appVersion(),
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    runtime: process.versions.electron ? "desktop" : fs.existsSync("/.dockerenv") ? "docker" : "cli",
    lang: lang(),
  };
}

/** 环境那一行：版本、系统、运行方式、界面语言 */
export function environmentLine(env: FeedbackEnvironment): string {
  return t("feedback.environment", {
    version: env.version,
    os: env.os,
    platform: env.platform,
    arch: env.arch,
    runtime: t(`feedback.runtime_${env.runtime}`),
    lang: env.lang,
  });
}

/**
 * 诊断信息超出额度时：保留开头的状态部分（约四成），其余给最近的日志（结尾），中间用一行说明省略了几行。
 * 返回值不超过 max 个字符。
 */
export function trimDiagnostics(text: string, max: number): { text: string; trimmed: boolean } {
  if (chars(text) <= max) return { text, trimmed: false };
  if (max <= 0) return { text: "", trimmed: true };
  const lines = text.split("\n");
  const headBudget = Math.floor(max * 0.4);
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    const n = chars(line) + 1;
    if (used + n > headBudget) break;
    head.push(line);
    used += n;
  }
  const tail: string[] = [];
  // 省略说明那一行的长度先按最长的数字估出来
  const reserve = chars(t("feedback.omitted", { count: lines.length })) + 1;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const n = chars(lines[i]) + 1;
    if (used + n + reserve > max) break;
    tail.unshift(lines[i]);
    used += n;
  }
  const omitted = lines.length - head.length - tail.length;
  const out = [...head, ...(omitted > 0 ? [t("feedback.omitted", { count: omitted })] : []), ...tail].join("\n");
  return { text: chars(out) <= max ? out : cut(out, max), trimmed: true };
}

/**
 * 拼出要提交的正文：用户写的内容 → 分隔行 → 环境 → 模型 → 报错 → 诊断信息。
 * 整段不超过 FEEDBACK_BODY_MAX，最后整体脱敏一次。
 */
export function composeFeedback(parts: FeedbackParts, env: FeedbackEnvironment): ComposedFeedback {
  const text = cut(parts.text.trim(), FEEDBACK_TEXT_MAX);
  const blocks = [text, t("feedback.separator"), environmentLine(env)];
  const model = parts.model?.trim();
  if (model) blocks.push(t(parts.modelIsDefault ? "feedback.default_model" : "feedback.model", { model }));
  const errorText = parts.errorText?.trim();
  if (errorText) blocks.push("", t("feedback.error_heading"), cut(redactText(errorText), ERROR_MAX));
  let body = blocks.join("\n");
  let diagnosticsTrimmed = false;
  const diagnostics = parts.diagnostics?.trim();
  if (diagnostics) {
    const heading = `\n\n${t("feedback.diagnostics_heading")}\n`;
    const room = FEEDBACK_BODY_MAX - chars(body) - chars(heading);
    const d = trimDiagnostics(diagnostics, room);
    diagnosticsTrimmed = d.trimmed;
    if (d.text) body += heading + d.text;
  }
  return { body: cut(redactText(body), FEEDBACK_BODY_MAX), diagnosticsTrimmed };
}

export interface FeedbackRequest {
  kind: FeedbackKind;
  text: string;
  errorText?: string;
  model?: string;
  includeDiagnostics?: boolean;
}

/** 按应用当前的状态拼正文：模型没给时写默认模型；勾了诊断信息才读日志 */
export function draftFeedback(app: App, req: FeedbackRequest): ComposedFeedback {
  return composeFeedback(
    {
      text: req.text,
      errorText: req.errorText,
      model: req.model || app.config.llm.defaultModel || "",
      modelIsDefault: !req.model,
      diagnostics: req.includeDiagnostics ? diagnosticsReport(app, DIAG_LOG_LINES) : undefined,
    },
    feedbackEnvironment(),
  );
}

/** 提交时的业务错误：status 是给界面的 HTTP 状态码，message 已按界面语言写好 */
export class FeedbackError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 能不能在应用内发送：登录了 Modelflare（外部网关模式没有账户，见 web/routes/account.ts） */
export function canSendFeedback(app: Pick<App, "magpie" | "account">): boolean {
  return !!app.magpie && app.account.signedIn;
}

export interface FeedbackSubmission extends FeedbackRequest {
  /** 反馈的那条报错里的 Request ID（Modelflare 能据此找到那次请求） */
  relatedRequestId?: string;
}

/**
 * 校验 → 拼正文（和预览同一个函数）→ 提交到 Modelflare。
 * 每天 3 次的限额是和控制台建工单共用的，超出时 Modelflare 回 429；还没有这个接口的 Modelflare 回 404。
 * 两种都换成能看懂的提示，让用户改用邮件或 GitHub。
 */
export async function sendFeedback(app: Pick<App, "magpie" | "account" | "config">, req: FeedbackSubmission): Promise<{ ticketId: number; topic: string; supportUrl: string }> {
  const n = [...req.text.trim()].length;
  if (n < FEEDBACK_TEXT_MIN) throw new FeedbackError(400, t("feedback.too_short", { min: FEEDBACK_TEXT_MIN }));
  if (n > FEEDBACK_TEXT_MAX) throw new FeedbackError(400, t("feedback.too_long", { max: FEEDBACK_TEXT_MAX }));
  if (!canSendFeedback(app)) throw new FeedbackError(409, t("account.sign_in_first"));
  const requestId = (req.relatedRequestId ?? "").trim().slice(0, 80);
  const { body } = draftFeedback(app as App, req);
  let receipt;
  try {
    receipt = await app.account.submitFeedback({ kind: req.kind, body, ...(requestId ? { related_request_id: requestId } : {}) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) throw new FeedbackError(429, t("feedback.rate_limited"));
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) throw new FeedbackError(502, t("feedback.unavailable"));
    throw e;
  }
  // 旧版服务端可能把未知地址当网页返回（200 但不是回执）
  if (!receipt?.ticket_id) throw new FeedbackError(502, t("feedback.unavailable"));
  return { ticketId: receipt.ticket_id, topic: receipt.topic, supportUrl: receipt.support_url || "" };
}
