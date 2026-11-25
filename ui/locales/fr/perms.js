// perms · fr
export default {
  workspace: "Écriture dans l'espace de travail",
  workspaceNote: "Peut uniquement modifier l'espace de travail de ce bot ; toute action extérieure vous demande d'abord confirmation",
  readonly: "Lecture seule",
  readonlyNote: "Ne peut pas modifier de fichiers ; les commandes s'exécutent dans un bac à sable en lecture seule",
  full: "Accès complet",
  fullNote: "Les commandes s'exécutent sans bac à sable et peuvent lire et modifier tous vos fichiers ; les suppressions récursives demandent toujours confirmation",
  fullWarning: "Les commandes s'exécutent sans bac à sable, directement avec votre utilisateur : elles peuvent lire et modifier n'importe quel fichier sur votre ordinateur, y compris les données propres à AnyModelBot (historique des conversations, jetons de canaux et clés). Les actions hors limites ne demandent plus d'approbation ; seules les suppressions récursives (rm -r, Remove-Item -Recurse, etc.) demandent encore confirmation. N'activez cette option que lorsque vous faites confiance au modèle et à la tâche en cours.",
  confirmTitle: "Activer l'accès complet ?",
  confirmLabel: "Activer l'accès complet",
};
