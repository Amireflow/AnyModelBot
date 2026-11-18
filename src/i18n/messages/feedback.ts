// feedback：zh 与 en 的键必须一一对应（en 的类型由 zh 推出，少一个多一个都过不了类型检查）。
// 应用内反馈（src/feedback.ts、web/routes/feedback.ts）：提交到 Modelflare 工单的正文里附带的说明，以及提交时的报错。
// 正文会出现在用户自己的 Modelflare 工单里，客服也看这一份。
import type { Catalog } from "../types.js";

export const zh = {
  separator: "—— 以下由 AnyModelBot 自动附带 ——",
  /** {runtime} 是 runtime_* 之一；{lang} 是界面语言代码 */
  environment: "环境：AnyModelBot {version} · {os}（{platform} {arch}）· {runtime} · 界面语言 {lang}",
  runtime_desktop: "桌面版",
  runtime_cli: "命令行",
  runtime_docker: "Docker",
  model: "模型：{model}",
  default_model: "默认模型：{model}",
  error_heading: "报错（已去掉密钥）：",
  diagnostics_heading: "诊断信息（已去掉密钥）：",
  omitted: { other: "……（省略 {count} 行）" },
  invalid_kind: "不认识的反馈类型",
  too_short: "请再多写几句，至少 {min} 个字",
  too_long: "内容太长了，请控制在 {max} 个字以内",
  rate_limited: "今天的反馈次数已经用完（每天 3 次），明天再试，或者改用邮件、GitHub 提交",
  unavailable: "Modelflare 暂时收不到应用内反馈，请改用邮件或 GitHub 提交",
} satisfies Catalog;

export const en: Catalog<typeof zh> = {
  separator: "—— Added automatically by AnyModelBot ——",
  environment: "Environment: AnyModelBot {version} · {os} ({platform} {arch}) · {runtime} · UI language {lang}",
  runtime_desktop: "Desktop app",
  runtime_cli: "Command line",
  runtime_docker: "Docker",
  model: "Model: {model}",
  default_model: "Default model: {model}",
  error_heading: "Error (keys removed):",
  diagnostics_heading: "Diagnostics (keys removed):",
  omitted: { one: "… ({count} line omitted)", other: "… ({count} lines omitted)" },
  invalid_kind: "Unknown feedback type",
  too_short: "Please add a little more detail: at least {min} characters",
  too_long: "That's too long. Please keep it under {max} characters",
  rate_limited: "You've sent today's feedback (3 a day). Try again tomorrow, or send it by email or on GitHub instead",
  unavailable: "Modelflare can't take in-app feedback right now. Please send it by email or on GitHub instead",
};
