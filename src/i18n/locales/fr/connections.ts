import type { TranslatedCatalog } from "../../index.js";
export default {
  failed: "La connexion n'a pas pu être établie. Vérifiez votre réseau et réessayez.",
  feishuStartRefused: "Feishu a refusé de démarrer. Réessayez, ou utilisez une application que vous avez déjà.",
  feishuDeclined: "Vous avez refusé dans Feishu.",
  feishuQrExpired: "Le code QR a expiré. Réessayez.",
  feishuAppRefused: "Feishu a refusé cette application. Vérifiez l'App ID et l'App Secret, ainsi que les autorisations de messagerie de l'application.",
  feishuNoRefreshToken: "Feishu n'a pas fourni de connexion durable. Réessayez.",
  feishuAuthExpired: "L'autorisation a expiré. Réessayez.",
  feishuAuthIncomplete: "Feishu n'a pas terminé l'autorisation. Réessayez.",
  notionUnavailable: "Impossible de joindre le service de connexion de Notion. Réessayez dans un instant.",
  notionUnexpected: "Le service de connexion de Notion a renvoyé une réponse inattendue.",
  notionRegistrationUnavailable: "Le service de connexion de Notion n'accepte pas de nouveaux clients.",
  notionRegistrationRefused: "Le service de connexion de Notion a refusé d'enregistrer cette application.",
  notionLinkExpired: "Ce lien de connexion a expiré. Recommencez depuis les Paramètres.",
  notionDeclined: "Vous avez refusé l'autorisation.",
  notionAuthIncomplete: "Notion n'a pas terminé l'autorisation.",
  notionExchangeFailed: "Notion n'a pas terminé l'autorisation. Réessayez.",
} satisfies TranslatedCatalog["connections"];
