import type { TranslatedCatalog } from "../../index.js";
export default {
  separator: "—— Ниже добавлено AnyModelBot автоматически ——",
  environment: "Окружение: AnyModelBot {version} · {os} ({platform} {arch}) · {runtime} · язык интерфейса {lang}",
  runtime_desktop: "Настольное приложение",
  runtime_cli: "Командная строка",
  runtime_docker: "Docker",
  model: "Модель: {model}",
  default_model: "Модель по умолчанию: {model}",
  error_heading: "Ошибка (ключи удалены):",
  diagnostics_heading: "Диагностика (ключи удалены):",
  omitted: { one: "… (пропущена {count} строка)", few: "… (пропущено {count} строки)", many: "… (пропущено {count} строк)", other: "… (пропущено {count} строки)" },
  invalid_kind: "Неизвестный тип отзыва",
  too_short: "Опишите чуть подробнее: не меньше {min} символов",
  too_long: "Слишком длинно. Уложитесь в {max} символов",
  rate_limited: "Лимит отзывов на сегодня исчерпан (3 в день). Попробуйте завтра или отправьте по почте или на GitHub",
  unavailable: "Сейчас Modelflare не принимает отзывы из приложения. Отправьте отзыв по почте или на GitHub",
} satisfies TranslatedCatalog["feedback"];
