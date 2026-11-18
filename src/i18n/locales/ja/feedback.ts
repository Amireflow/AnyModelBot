import type { TranslatedCatalog } from "../../index.js";
export default {
  separator: "—— 以下は AnyModelBot が自動で添付 ——",
  environment: "環境：AnyModelBot {version} · {os}（{platform} {arch}）· {runtime} · 表示言語 {lang}",
  runtime_desktop: "デスクトップ版",
  runtime_cli: "コマンドライン",
  runtime_docker: "Docker",
  model: "モデル：{model}",
  default_model: "既定のモデル：{model}",
  error_heading: "エラー（キーは削除済み）：",
  diagnostics_heading: "診断情報（キーは削除済み）：",
  omitted: { other: "……（{count} 行を省略）" },
  invalid_kind: "不明なフィードバックの種類です",
  too_short: "もう少し詳しく書いてください（{min} 文字以上）",
  too_long: "長すぎます。{max} 文字以内にしてください",
  rate_limited: "今日のフィードバック送信回数（1 日 3 回）に達しました。明日もう一度送るか、メールまたは GitHub で送ってください",
  unavailable: "Modelflare は現在アプリ内フィードバックを受け付けていません。メールまたは GitHub で送ってください",
} satisfies TranslatedCatalog["feedback"];
