---
name: lot-breakdown-sop
description: Découpage de projet logiciel en lots atomiques ordonnés (SOP MetaGPT) avec critères d'acceptation vérifiables.
category: delivery
roles: project_manager
---

# SOP Découpage en Lots Atomiques

1. **Enchaînement standard** : ordonner les lots selon la chaîne `Architecture & Données` → `Cœur API / Logique` → `Interface Utilisateur` → `Intégrations & Tests E2E` → `Recette QA & Livraison`.
2. **Lots vérifiables** : chaque lot doit contenir 2 à 4 critères d'acceptation testables, un rôle responsable précis et une estimation en heures réaliste.
3. **Zéro lot orphelin** : s'assurer que chaque livrable du contrat signé est couvert par au moins un lot avant passage en `in_progress`.
