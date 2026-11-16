import type { TranslatedCatalog } from "../../index.js";
export default {
  unreachable: "{host} adresine ulaşılamıyor ({reason}). Ağını kontrol et. Vekil sunucu veya VPN kullanıyorsan sistem vekilini veya TUN modunu açıp tekrar dene",
  timeout: "zaman aşımı",
  invalid_key: "Anahtar geçersiz veya iptal edilmiş",
  forbidden: "Bu anahtarın bu modeli veya grubu kullanmasına izin yok",
  unavailable: "Modelflare geçici olarak kullanılamıyor (HTTP {status}){retry}",
  retry_after: "; {s} sn sonra tekrar dene",
  bad_models: "Modelflare okuyamadığımız bir model listesi döndürdü",
} satisfies TranslatedCatalog["modelflare"];
