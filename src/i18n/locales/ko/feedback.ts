import type { TranslatedCatalog } from "../../index.js";
export default {
  separator: "—— 아래는 AnyModelBot이 자동으로 첨부함 ——",
  environment: "환경: AnyModelBot {version} · {os} ({platform} {arch}) · {runtime} · 화면 언어 {lang}",
  runtime_desktop: "데스크톱 앱",
  runtime_cli: "명령줄",
  runtime_docker: "Docker",
  model: "모델: {model}",
  default_model: "기본 모델: {model}",
  error_heading: "오류(키 제거됨):",
  diagnostics_heading: "진단 정보(키 제거됨):",
  omitted: { other: "… ({count}줄 생략)" },
  invalid_kind: "알 수 없는 피드백 유형입니다",
  too_short: "조금 더 자세히 적어 주세요. 최소 {min}자",
  too_long: "너무 깁니다. {max}자 이내로 줄여 주세요",
  rate_limited: "오늘 보낼 수 있는 피드백(하루 3회)을 모두 사용했습니다. 내일 다시 보내거나 이메일 또는 GitHub로 보내 주세요",
  unavailable: "지금은 Modelflare에서 앱 내 피드백을 받을 수 없습니다. 이메일 또는 GitHub로 보내 주세요",
} satisfies TranslatedCatalog["feedback"];
