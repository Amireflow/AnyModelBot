import type { Channel } from "./channels";

export default [
  {
    id: "slack",
    icon: "hash",
    title: "Slack",
    body: "Écrivez au bot en message privé Slack — au bureau ou sur téléphone, avec images et fichiers.",
    format: "Canal (Socket Mode)",
    guide: {
      title: "Connecter Slack",
      steps: [
        "Sur api.slack.com/apps, créez une application, activez Socket Mode et générez un jeton d'application (xapp-…) avec connections:write.",
        "Ajoutez les permissions bot chat:write, im:history, files:read et files:write, abonnez-vous à l'événement message.im et autorisez les messages dans App Home. Installez l'application dans votre espace de travail et copiez le jeton bot (xoxb-…).",
        "Ouvrez Paramètres → Connexions → Slack → Ajouter un compte, collez les deux jetons et enregistrez. Envoyez ensuite un message privé au bot dans Slack.",
      ],
      limit: "Messages directs uniquement pour l'instant. L'application doit rester ouverte : les messages envoyés lorsqu'elle est fermée ne sont pas reçus.",
    },
  },
  {
    id: "telegram",
    icon: "send",
    title: "Telegram",
    body: "Créez un bot avec @BotFather, puis discutez partout avec images et fichiers.",
    format: "Canal (jeton bot)",
    guide: {
      title: "Connecter Telegram",
      steps: [
        "Dans Telegram, écrivez à @BotFather, envoyez /newbot et suivez les instructions. Copiez le jeton du bot fourni.",
        "Ouvrez Paramètres → Connexions → Telegram → Ajouter un compte, collez le jeton et enregistrez.",
        "Ouvrez votre nouveau bot dans Telegram et envoyez-lui un message. La connexion utilise le long polling, sans adresse publique requise.",
      ],
      limit: "Messages directs uniquement pour l'instant. Les messages reçus pendant la fermeture sont récupérés dans un délai maximal de 24 heures.",
    },
  },
  {
    id: "discord",
    icon: "headset",
    title: "Discord",
    body: "Ajoutez le bot à votre serveur, puis envoyez-lui un message privé sur ordinateur ou mobile.",
    format: "Canal (jeton bot)",
    guide: {
      title: "Connecter Discord",
      steps: [
        "Dans le Discord Developer Portal, créez une application, ajoutez un bot et copiez son jeton.",
        "Sous OAuth2 → URL Generator, cochez la portée bot et ouvrez le lien pour ajouter le bot à l'un de vos serveurs.",
        "Ouvrez Paramètres → Connexions → Discord → Ajouter un compte, collez le jeton et enregistrez. Envoyez ensuite un message privé au bot.",
      ],
      limit: "Messages directs uniquement pour l'instant. L'application doit rester ouverte : les messages envoyés lorsqu'elle est fermée ne sont pas reçus.",
    },
  },
] satisfies Channel[];
