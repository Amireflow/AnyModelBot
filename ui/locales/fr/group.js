// group · fr : discussions de groupe (screens/group.js)
export default {
  /** L'élément de la liste @ qui désigne tous les membres ; c'est aussi ce qui est inséré dans le champ de saisie (src/core/groups.ts le reconnaît) */
  everyone: "everyone",
  placeholder: "Envoyez un message, mentionnez quelqu'un avec @ pour choisir qui répond",
  mentionLabel: "Choisir un membre à mentionner avec @",
  editTitle: "Nom et membres du groupe",
  empty: "La personne que vous mentionnez avec @ répond. Sans @, le dernier bot ayant répondu continue. Chaque bot utilise son propre modèle, son espace de travail et sa mémoire.",
  /** Le nom affiché sur les réponses laissées par un bot qui a été supprimé */
  removedBot: "Bot supprimé",
  working: "{name} répond…",
  noMessages: "Aucun message pour le moment",
  sheet: {
    newTitle: "Nouvelle discussion de groupe",
    editTitle: "Nom et membres du groupe",
    name: "Nom",
    namePlaceholder: "Laissez vide pour utiliser les noms des membres",
    members: "Membres",
    membersHint: "Choisissez au moins deux bots",
    create: "Créer",
    save: "Enregistrer",
  },
  delete: {
    title: "Supprimer « {name} » ?",
    body: "Cela supprime définitivement la discussion de groupe et ses messages. Les bots et leurs discussions individuelles ne sont pas affectés.",
    confirm: "Supprimer définitivement",
  },
};
