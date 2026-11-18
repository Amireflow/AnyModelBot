import type { TranslatedCatalog } from "../../index.js";
export default {
  separator: "—— Adicionado automaticamente pelo AnyModelBot ——",
  environment: "Ambiente: AnyModelBot {version} · {os} ({platform} {arch}) · {runtime} · idioma da interface {lang}",
  runtime_desktop: "App para desktop",
  runtime_cli: "Linha de comando",
  runtime_docker: "Docker",
  model: "Modelo: {model}",
  default_model: "Modelo padrão: {model}",
  error_heading: "Erro (chaves removidas):",
  diagnostics_heading: "Diagnóstico (chaves removidas):",
  omitted: { one: "… ({count} linha omitida)", many: "… ({count} linhas omitidas)", other: "… ({count} linhas omitidas)" },
  invalid_kind: "Tipo de feedback desconhecido",
  too_short: "Conte um pouco mais: pelo menos {min} caracteres",
  too_long: "Ficou longo demais. Use no máximo {max} caracteres",
  rate_limited: "Você já enviou o feedback de hoje (3 por dia). Tente de novo amanhã ou envie por e-mail ou pelo GitHub",
  unavailable: "No momento o Modelflare não consegue receber feedback pelo app. Envie por e-mail ou pelo GitHub",
} satisfies TranslatedCatalog["feedback"];
