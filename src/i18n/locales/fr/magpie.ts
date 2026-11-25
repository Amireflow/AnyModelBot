import type { TranslatedCatalog } from "../../index.js";
export default {
  no_binary_cli: "Exécutable magpie introuvable. Exécutez d'abord npm run setup",
  no_binary: "Exécutable magpie introuvable (exécutez npm run setup pour le compiler depuis vendor/magpie)",
  unsupported_url: "Adresse Modelflare non prise en charge",
  missing_key: "Clé API manquante",
  create_failed: "Impossible de créer la connexion Modelflare : {detail}",
  not_running: "La passerelle de modèles ne fonctionne pas. Réessayez dans un instant",
  disconnect_failed: "Échec de la déconnexion : HTTP {status} {body}",
  save_failed: "Échec de l'enregistrement : HTTP {status} {body}",
  verify_failed: "Échec de la vérification après l'enregistrement",
} satisfies TranslatedCatalog["magpie"];
