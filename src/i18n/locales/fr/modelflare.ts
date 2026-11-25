import type { TranslatedCatalog } from "../../index.js";
export default {
  unreachable: "Impossible de joindre {host} ({reason}). Vérifiez votre réseau. Si vous utilisez un proxy ou un VPN, activez son proxy système ou le mode TUN puis réessayez",
  timeout: "délai dépassé",
  invalid_key: "La clé est invalide ou a été révoquée",
  forbidden: "Cette clé n'est pas autorisée à utiliser ce modèle ou ce groupe",
  unavailable: "Modelflare est temporairement indisponible (HTTP {status}){retry}",
  retry_after: " ; réessayez dans {s} s",
  bad_models: "Modelflare a renvoyé une liste de modèles illisible",
} satisfies TranslatedCatalog["modelflare"];
