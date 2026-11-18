/**
 * 应用内反馈的正文（src/feedback.ts）和备用链接（ui/lib/feedback.js）。
 * Modelflare 一条工单消息最多 8000 字，超出会整条被拒：附带的诊断信息再长，拼出来的正文也不能超。
 */
import { describe, expect, it } from "vitest";
import { FEEDBACK_BODY_MAX, composeFeedback, trimDiagnostics, type FeedbackEnvironment } from "../src/feedback.js";
// @ts-expect-error 界面库是纯 JS
import { emailFeedbackUrl, githubFeedbackUrl } from "../ui/lib/feedback-links.js";

const env: FeedbackEnvironment = { version: "0.1.42", os: "Darwin 24.1.0", platform: "darwin", arch: "arm64", runtime: "desktop", lang: "zh-CN" };
const chars = (s: string) => [...s].length;

describe("反馈正文", () => {
  it("用户写的内容在最前面，后面是环境和模型；没勾诊断信息就不带", () => {
    const { body, diagnosticsTrimmed } = composeFeedback({ text: "  导出 PDF 卡住了  ", model: "gpt-test" }, env);
    expect(body.startsWith("导出 PDF 卡住了\n")).toBe(true);
    expect(body).toContain("0.1.42");
    expect(body).toContain("darwin arm64");
    expect(body).toContain("gpt-test");
    expect(diagnosticsTrimmed).toBe(false);
    expect(body.split("\n").length).toBeLessThan(6);
  });

  it("描述、报错里贴进来的密钥在发出前去掉", () => {
    const { body } = composeFeedback({ text: "我的 key 是 sk-proj-abcdefghijklmnopqrstuv", errorText: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" }, env);
    expect(body).not.toContain("sk-proj-abcdefghijklmnopqrstuv");
    expect(body).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  it("诊断信息很长时整段不超过上限：保留开头的状态和最近的日志，中间注明省略", () => {
    const status = ["# 诊断报告", "版本 0.1.42", "网关 running"];
    const logs = Array.from({ length: 2000 }, (_, i) => `2026-11-18 log line ${i} ${"x".repeat(40)}`);
    const { body, diagnosticsTrimmed } = composeFeedback({ text: "说明".repeat(1500), diagnostics: [...status, ...logs].join("\n") }, env);
    expect(chars(body)).toBeLessThanOrEqual(FEEDBACK_BODY_MAX);
    expect(diagnosticsTrimmed).toBe(true);
    expect(body).toContain("网关 running");
    expect(body).toContain("log line 1999");
    expect(body).not.toContain("log line 1000 ");
  });

  it("按 Unicode 字符计数：emoji 和中文都算一个，裁剪后不超过额度", () => {
    const text = Array.from({ length: 300 }, (_, i) => `第${i}行🙂`).join("\n");
    const out = trimDiagnostics(text, 500);
    expect(out.trimmed).toBe(true);
    expect(chars(out.text)).toBeLessThanOrEqual(500);
    expect(out.text).toContain("第299行🙂");
    expect(trimDiagnostics("短", 10)).toEqual({ text: "短", trimmed: false });
  });
});

describe("GitHub / 邮件备用链接", () => {
  it("问题用 bug_report 表单并按字段 id 预填；建议用 feature_request", () => {
    const bug = new URL(githubFeedbackUrl({ kind: "bug", text: "导出卡住", version: "0.1.42", environment: "环境：…", errorText: "HTTP 500" }).url);
    expect(bug.pathname).toBe("/modelflare-ai/AnyModelBot/issues/new");
    expect(Object.fromEntries(bug.searchParams)).toMatchObject({ template: "bug_report.yml", version: "0.1.42", steps: "导出卡住" });
    expect(bug.searchParams.get("diagnostics")).toContain("HTTP 500");
    const idea = new URL(githubFeedbackUrl({ kind: "suggestion", text: "加快捷键" }).url);
    expect(Object.fromEntries(idea.searchParams)).toEqual({ template: "feature_request.yml", problem: "加快捷键" });
  });

  it("内容太长时链接只放开头并标记 truncated（界面把全文复制给用户粘贴），链接长度有上限", () => {
    const long = "很长的描述".repeat(400);
    const gh = githubFeedbackUrl({ kind: "bug", text: long, version: "0.1.42", environment: "环境" });
    expect(gh.truncated).toBe(true);
    expect(gh.url.length).toBeLessThan(8000);
    const mail = emailFeedbackUrl({ subject: "AnyModelBot", text: long });
    expect(mail.truncated).toBe(true);
    expect(mail.url.startsWith("mailto:support@anymodel.bot?subject=AnyModelBot&body=")).toBe(true);
    expect(mail.url).not.toContain("+");
  });
});
