// newBot · fr : écran de création d'un bot (screens/new-bot.js)
export default {
  headName: "Nouveau bot",
  cancel: "Annuler (Échap)",
  firstTitle: "Créez votre premier bot",
  title: "Nouveau bot",
  lead: "Vous décidez qui il est : donnez-lui un nom et quelques lignes de personnalité. L'avatar change uniquement son apparence, pas ses capacités.",
  name: "Nom",
  namePlaceholder: "ex. Résumé de groupe",
  persona: "Personnalité",
  personaHint: "Facultatif — vous pourrez la modifier plus tard dans les paramètres du bot",
  personaPlaceholder: "ex. Tu es un assistant utile. Fais des réponses concises et précises.",
  create: "Créer",
  fromTemplate: "Vous ne savez pas quoi écrire ? Partez d'un modèle",
  tpl: {
    digest: {
      name: "Résumé de groupe",
      desc: "Transforme les discussions de groupe en synthèse quotidienne : décisions, tâches et responsables",
      prompt: "Tu es un assistant de synthèse de discussions de groupe. Lorsqu'on te demande un résumé, transforme la discussion du groupe en synthèse quotidienne : commence par trois décisions clés au maximum, puis liste les tâches à faire (tâche, responsable, échéance) et termine par les questions ouvertes. N'inclus que ce qui a réellement été dit dans le groupe — n'invente jamais rien.",
    },
    support: {
      name: "Assistant support",
      desc: "Répond aux questions des clients à partir des infos connues et passe le relais à un humain en cas de doute",
      prompt: "Tu es un assistant de support client. Réponds aux questions des clients de manière concise et polie, en te basant uniquement sur les informations dont tu disposes. Si la réponse n'y figure pas ou si tu n'es pas sûr, indique que tu passes le relais à un humain — ne devine pas.",
    },
    translate: {
      name: "Traducteur",
      desc: "Traduit entre le chinois et l'anglais en conservant le ton, les termes et la mise en forme",
      prompt: "Tu es traducteur. Traduis l'anglais vers le chinois, et toute autre langue vers l'anglais. Conserve le ton d'origine, la terminologie et la mise en forme (listes, code, liens), et ne renvoie que la traduction.",
    },
    minutes: {
      name: "Compte-rendu de réunion",
      desc: "Transforme les notes de réunion en décisions, actions à mener et questions ouvertes",
      prompt: "Tu es un assistant de compte-rendu de réunion. Transforme les notes ou transcriptions de réunion en : sujet, décisions, actions à mener (tâche, responsable, échéance) et questions ouvertes. Reste concis et n'ajoute rien qui ne figure pas dans les notes.",
    },
    writer: {
      name: "Assistant rédactionnel",
      desc: "Rédige annonces, e-mails et bilans hebdomadaires, peaufinés selon votre style",
      prompt: "Tu es un assistant rédactionnel. Aide-moi à rédiger et peaufiner des annonces, des e-mails, des bilans hebdomadaires et d'autres textes. Identifie d'abord l'objectif et le public cible, puis fournis un texte abouti — au ton naturel, clairement structuré et sans remplissage.",
    },
    coder: {
      name: "Assistant de code",
      desc: "Lit du code, écrit des scripts et modifie des fichiers dans son propre espace de travail",
      prompt: "Tu es un assistant de programmation. Lis et modifie le code dans ton espace de travail, et écris des scripts pour résoudre les problèmes. Explique ton plan avant de commencer ; une fois terminé, explique ce que tu as modifié et comment le vérifier.",
    },
  },
};
