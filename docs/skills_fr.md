# Compétences (Skills)

[简体中文](./skills.md) | [English](./skills_en.md) | Français | [日本語](./skills_ja.md) | [한국어](./skills_ko.md) | [Русский](./skills_ru.md) | [Español](./skills_es.md) | [Português (Brasil)](./skills_pt.md) | [Türkçe](./skills_tr.md)

Les compétences (*skills*) sont des ensembles d'instructions et de ressources réutilisables qu'un bot charge à la demande dans son runtime d'agent.

## Formats pris en charge

Une archive `.zip` importable (jusqu'à 20 Mo, une compétence par archive) doit contenir un fichier `SKILL.md` avec un en-tête YAML (`name`, `description`) suivi des instructions Markdown, et éventuellement :

- `scripts/` — scripts d'assistance ou utilitaires ;
- `references/` — documentation complémentaire ;
- `examples/` et `resources/` — exemples ou modèles utilisés par la compétence.

## Installer ou importer une compétence

1. **Depuis la bibliothèque :** ouvrez le menu avatar → **Apps & skills**, choisissez une compétence et confirmez son installation auprès du bot.
2. **Par archive ZIP :** ouvrez **Paramètres du bot → Compétences → Importer un ZIP** et sélectionnez le fichier `.zip` (validé par `src/skills/archive.ts` : chemins sûrs, sans échappement de répertoire ni lien symbolique).
3. **Depuis une conversation :** lorsqu'un bot réussit une procédure répétable, dites « enregistrer comme compétence » ou envoyez `/skill`, puis validez la carte d'aperçu pour l'ajouter dans **Mes compétences**.

## Cycle de vie et sécurité

- Chaque compétence est activable ou désactivable indépendamment par bot.
- Les mises à jour et activations ne s'appliquent au runtime d'agent (`dsh-runtime`) que lorsque le bot est inactif, afin de ne jamais interrompre un tour ou une tâche en cours.
- Les compétences n'élargissent pas les permissions fichiers ou commandes d'un bot : le préréglage de permissions (*Lecture seule*, *Espace de travail*, *Accès complet*) et les cartes d'approbation restent pleinement appliqués.
