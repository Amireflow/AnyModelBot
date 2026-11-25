import type { TranslatedCatalog } from "../../index.js";
export default {
  refusal: "Vous n'êtes pas encore autorisé à utiliser ce bot ; le propriétaire a été prévenu. Dès qu'il approuvera, vous pourrez discuter tout de suite.",
  approved: "Le propriétaire vous a approuvé. Vous pouvez discuter avec moi dès maintenant.",
  chWeixin: "WeChat",
  chFeishu: "Feishu",
  chWeb: "web",
  who: "utilisateur {channel} {name}",
  ownerNotice: "Quelqu'un souhaite utiliser le bot « {bot} » : {who}{said}\nRépondez « yes {code} » pour autoriser ou « no {code} » pour refuser, ou gérez cela dans le panneau d'information d'AnyModelBot.",
  allowedAck: "✅ « {who} » est maintenant autorisé à utiliser ce bot",
  deniedAck: "❌ Accès refusé pour « {who} »",
  ownerOf: "propriétaire {channel}{who}",
  notSet: " non défini",
  listSep: ", ",
  pendingRequests: " ; {count} demande(s) d'utilisation en attente (répondez « yes <code> » ou gérez-les dans le panneau d'information de l'application)",
  policy: "Qui peut l'utiliser : uniquement les propriétaires et les personnes de la liste autorisée ({owners} ; {allowed} autorisés){req}",
  said: " : « {text} »",
} satisfies TranslatedCatalog["access"];
