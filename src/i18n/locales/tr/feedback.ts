import type { TranslatedCatalog } from "../../index.js";
export default {
  separator: "—— Aşağısı AnyModelBot tarafından otomatik eklendi ——",
  environment: "Ortam: AnyModelBot {version} · {os} ({platform} {arch}) · {runtime} · arayüz dili {lang}",
  runtime_desktop: "Masaüstü uygulaması",
  runtime_cli: "Komut satırı",
  runtime_docker: "Docker",
  model: "Model: {model}",
  default_model: "Varsayılan model: {model}",
  error_heading: "Hata (anahtarlar kaldırıldı):",
  diagnostics_heading: "Tanılama bilgileri (anahtarlar kaldırıldı):",
  omitted: { one: "… ({count} satır atlandı)", other: "… ({count} satır atlandı)" },
  invalid_kind: "Bilinmeyen geri bildirim türü",
  too_short: "Biraz daha ayrıntı yazın: en az {min} karakter",
  too_long: "Çok uzun. Lütfen {max} karakterin altında tutun",
  rate_limited: "Bugünkü geri bildirim hakkınızı kullandınız (günde 3). Yarın tekrar deneyin ya da e-postayla veya GitHub üzerinden gönderin",
  unavailable: "Modelflare şu anda uygulama içi geri bildirim alamıyor. Lütfen e-postayla veya GitHub üzerinden gönderin",
} satisfies TranslatedCatalog["feedback"];
