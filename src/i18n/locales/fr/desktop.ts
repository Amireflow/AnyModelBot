import type { TranslatedCatalog } from "../../index.js";
export default {
  instanceLockUnavailable: "Ce lancement n'a pas obtenu le verrou d'instance unique. Une autre instance est peut-être en cours d'exécution ou la création du verrou a échoué. Consultez le journal de démarrage pour le résultat du verrou et le répertoire de données réel.",
  updateReady: "La version {version} a été téléchargée. Redémarrez et mettez à jour quand vous êtes prêt.",
  updateInstallFailed: "L'installation de la mise à jour ne s'est pas terminée. L'application va redémarrer. Veuillez réessayer plus tard.",
  trayOpen: "Ouvrir {product}",
  trayOpenInBrowser: "Ouvrir dans le navigateur",
  trayAutostart: "Lancer au démarrage",
  trayOpenDataDir: "Ouvrir le dossier de données",
  trayQuit: "Quitter",
  errorTitle: "{product} a rencontré un problème",
  errorDetail: "{message}\n\nVoir le journal pour les détails : {log}",
  logDisabled: "(désactivé)",
  bootFailed: "{product} n'a pas pu démarrer",
  uiNotStarted: "L'interface locale n'a pas démarré",
  trayNeeds: "A besoin de vous ({count})",
} satisfies TranslatedCatalog["desktop"];
