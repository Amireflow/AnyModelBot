import type { TranslatedCatalog } from "../../index.js";
export default {
  invalid_key: "{name} n'a pas accepté cette clé. Vérifiez-la puis réessayez",
  rate_limited: "{name} applique une limitation de débit pour le moment. Réessayez dans un instant",
  network: "Impossible de joindre {name}. Si cet appareil a besoin d'un proxy pour y accéder, configurez d'abord le proxy",
  upstream: "{name} n'a pas renvoyé de liste de modèles : {detail}",
} satisfies TranslatedCatalog["official"];
