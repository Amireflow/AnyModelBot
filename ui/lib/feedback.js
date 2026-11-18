// 应用内反馈（「意见和反馈」）：全局一个弹窗（components/feedback.js 的 FeedbackHost，挂在 main.js），
// 从账户菜单、对话里的错误卡片、故障排查、设置 › 关于都能打开。
// 登录了 Modelflare 时在应用内发送，进用户自己的 Modelflare 工单（后端 src/web/routes/feedback.ts）；
// 没登录、或当天次数用完时，改用 GitHub（预填好内容）或邮件。
import { createStore } from "./store.js";

export { FEEDBACK_KINDS, SUPPORT_EMAIL, charCount, emailFeedbackUrl, githubFeedbackUrl } from "./feedback-links.js";

/**
 * 开着的弹窗；null = 没开。
 * { kind, errorText（已脱敏的报错）, relatedRequestId, model, includeDiagnostics, at }
 */
export const feedbackDialog = createStore(null);
export const openFeedback = (opts = {}) => feedbackDialog.set({ kind: "bug", ...opts, at: Date.now() });
export const closeFeedback = () => feedbackDialog.set(null);
