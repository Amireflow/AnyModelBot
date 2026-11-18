import type { TranslatedCatalog } from "../../index.js";
export default {
  separator: "—— Añadido automáticamente por AnyModelBot ——",
  environment: "Entorno: AnyModelBot {version} · {os} ({platform} {arch}) · {runtime} · idioma de la interfaz {lang}",
  runtime_desktop: "App de escritorio",
  runtime_cli: "Línea de comandos",
  runtime_docker: "Docker",
  model: "Modelo: {model}",
  default_model: "Modelo predeterminado: {model}",
  error_heading: "Error (claves eliminadas):",
  diagnostics_heading: "Diagnóstico (claves eliminadas):",
  omitted: { one: "… ({count} línea omitida)", many: "… ({count} líneas omitidas)", other: "… ({count} líneas omitidas)" },
  invalid_kind: "Tipo de comentario desconocido",
  too_short: "Cuéntanos un poco más: al menos {min} caracteres",
  too_long: "Es demasiado largo. Mantenlo por debajo de {max} caracteres",
  rate_limited: "Ya enviaste los comentarios de hoy (3 al día). Vuelve a intentarlo mañana o envíalos por correo o en GitHub",
  unavailable: "Ahora mismo Modelflare no puede recibir comentarios desde la app. Envíalos por correo o en GitHub",
} satisfies TranslatedCatalog["feedback"];
