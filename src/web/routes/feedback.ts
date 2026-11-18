/**
 * 应用内反馈（界面：components/feedback.js；校验、正文拼装和提交：src/feedback.ts）。
 * - GET  /feedback          能不能在应用内发送（登录了 Modelflare）、环境那一行、字数限制
 * - POST /feedback/preview  按当前输入生成要发送的正文，界面的「预览」显示的就是它
 * - POST /feedback          提交到用户的 Modelflare 工单，返回在 Modelflare 查看回复的地址
 */
import { FEEDBACK_KINDS, FEEDBACK_TEXT_MAX, FEEDBACK_TEXT_MIN, FeedbackError, canSendFeedback, draftFeedback, environmentLine, feedbackEnvironment, sendFeedback, type FeedbackSubmission } from "../../feedback.js";
import { t } from "../../i18n/index.js";
import { HttpError, accountCall, readJson, send, type Route, type WebContext } from "../http.js";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** 界面传来的输入：只取认识的字段，长度先粗截一下（正文拼装时还会按字符精确截断） */
function feedbackInput(b: any): FeedbackSubmission {
  const kind = FEEDBACK_KINDS.find((k) => k === b?.kind);
  if (!kind) throw new HttpError(400, t("feedback.invalid_kind"));
  return {
    kind,
    text: str(b.text, FEEDBACK_TEXT_MAX * 2),
    errorText: str(b.errorText, 20_000),
    model: str(b.model, 200),
    includeDiagnostics: b.includeDiagnostics === true,
    relatedRequestId: str(b.relatedRequestId, 80),
  };
}

export function feedbackRoutes(ctx: WebContext): Route {
  const { app } = ctx;
  return async (req, res, _url, seg, _p, m) => {
    if (seg[0] !== "feedback") return false;
    const sub = seg.slice(1).join("/");
    if (sub === "" && m === "GET") {
      const env = feedbackEnvironment();
      // version 给界面预填 GitHub issue 用
      return send(res, 200, { canSend: canSendFeedback(app), environment: environmentLine(env), version: env.version, minChars: FEEDBACK_TEXT_MIN, maxChars: FEEDBACK_TEXT_MAX });
    }
    if (sub === "preview" && m === "POST") return send(res, 200, draftFeedback(app, feedbackInput(await readJson(req))));
    if (sub === "" && m === "POST") {
      const input = feedbackInput(await readJson(req));
      const receipt = await accountCall(async () => {
        try {
          return await sendFeedback(app, input);
        } catch (e) {
          if (e instanceof FeedbackError) throw new HttpError(e.status, e.message);
          throw e;
        }
      });
      return send(res, 200, receipt);
    }
    return false;
  };
}
