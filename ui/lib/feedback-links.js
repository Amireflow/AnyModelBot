// 应用内反馈的纯函数（不碰浏览器全局，测试直接引用）：类型、字数统计、GitHub / 邮件备用链接。
// 弹窗的开关状态在 lib/feedback.js。
export const FEEDBACK_KINDS = ["bug", "suggestion", "other"];
const REPO = "https://github.com/modelflare-ai/AnyModelBot";
export const SUPPORT_EMAIL = "support@anymodel.bot";

/** 按 Unicode 字符计数（和后端、Modelflare 的算法一致，中文和 emoji 都算一个） */
export const charCount = (s) => [...String(s || "").trim()].length;
const cut = (s, max) => {
  const a = [...String(s || "")];
  return a.length <= max ? a.join("") : `${a.slice(0, max - 1).join("")}…`;
};

/** 链接里放不下太长的内容：GitHub 的地址最好在 8 KB 以内，中文编码后一个字占 9 个字节 */
const URL_TEXT_MAX = 600;
const URL_EXTRA_MAX = 300;

/**
 * GitHub issue 链接：按 .github/ISSUE_TEMPLATE 的表单字段 id 预填（文本字段才能预填，下拉框不行）。
 * 问题 → bug_report.yml；建议 → feature_request.yml；其他 → 让用户自己选。
 * truncated：内容太长、链接里只放了开头，完整内容要用户自己粘贴。
 */
export function githubFeedbackUrl({ kind, text, version, environment, errorText }) {
  const body = String(text || "").trim();
  const truncated = [...body].length > URL_TEXT_MAX || [...String(errorText || "")].length > URL_EXTRA_MAX;
  const q = new URLSearchParams();
  if (kind === "bug") {
    q.set("template", "bug_report.yml");
    if (version) q.set("version", version);
    q.set("steps", cut(body, URL_TEXT_MAX));
    q.set("diagnostics", [environment, errorText && cut(errorText, URL_EXTRA_MAX)].filter(Boolean).join("\n\n"));
  } else if (kind === "suggestion") {
    q.set("template", "feature_request.yml");
    q.set("problem", cut(body, URL_TEXT_MAX));
  } else {
    return { url: `${REPO}/issues/new/choose`, truncated: !!body };
  }
  return { url: `${REPO}/issues/new?${q}`, truncated };
}

/** 邮件链接：主题 + 正文（正文太长时只放开头，完整内容要用户自己粘贴） */
export function emailFeedbackUrl({ subject, text, environment, errorText }) {
  const body = [cut(String(text || "").trim(), URL_TEXT_MAX), environment, errorText && cut(errorText, URL_EXTRA_MAX)].filter(Boolean).join("\n\n");
  const truncated = [...String(text || "").trim()].length > URL_TEXT_MAX || [...String(errorText || "")].length > URL_EXTRA_MAX;
  // mailto 用 %20 表示空格（URLSearchParams 会写成 +，部分邮件客户端不认）
  return { url: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, truncated };
}
