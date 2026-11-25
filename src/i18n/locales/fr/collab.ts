import type { TranslatedCatalog } from "../../index.js";
export default {
  msgPoints: "Contexte :",
  msgFiles: "Fichiers :",
  msgAskOnly: "Rien à faire. Répondez simplement.",
  msgDoneWhen: "Terminé quand : {criteria}",
  msgRedo: "{issue}. Veuillez corriger cela. (Reprise {n}/{limit})",
  msgAdds: "L'utilisateur ajoute : {text}",
  whyUser: "vous lui avez demandé d'arrêter",
  whyTimeout: "au-delà de {limit}",
  whyBudget: "ceci a épuisé {budget}",
  whyError: "un problème est survenu : {reason}",
  hours: {
    one: "{count} heure",
    many: "{count} heures",
    other: "{count} heures",
  },
  minutes: {
    one: "{count} minute",
    many: "{count} minutes",
    other: "{count} minutes",
  },
  noText: "(aucun résumé)",
  fallbackReply: "Message de {bot} :\n\n{text}",
  fallbackStopped: "{bot} s'est arrêté ({why}). {text}",
  droppedExpired: "{bot} n'a pas démarré dans les 24 heures ; cette demande a donc été abandonnée.",
  droppedModel: "{bot} est passé à un modèle utilisant votre propre clé API ; cette demande en attente a donc été annulée.",
  deleted: "{bot} a été supprimé ; ceci s'est donc arrêté.",
} satisfies TranslatedCatalog["collab"];
