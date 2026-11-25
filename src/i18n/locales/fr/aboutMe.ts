import type { TranslatedCatalog } from "../../index.js";
export default {
  addedChannel: "✓ Ajouté à À propos de moi : {line} (répondez « annuler » pour le retirer)",
  changedChannel: "✓ Mis à jour dans À propos de moi : {line} (répondez « annuler » pour revenir en arrière)",
  removedChannel: "✓ Supprimé de À propos de moi : {line} (répondez « annuler » pour le rétablir)",
  undone: "Annulé. À propos de moi est revenu à son état précédent.",
  empty: "Écrivez d'abord une phrase",
  tooLong: "Une ligne peut contenir au maximum 300 caractères",
  secret: "Les mots de passe, clés, jetons et codes ne peuvent pas être enregistrés",
  idOrCard: "Les numéros de pièce d'identité et de carte bancaire ne peuvent pas être enregistrés dans À propos de moi",
  missing: "Cette ligne n'est plus là",
  stale: "Cette ligne a changé, la suggestion ne s'applique donc plus",
  notUndoable: "Cette modification ne peut plus être annulée",
} satisfies TranslatedCatalog["aboutMe"];
