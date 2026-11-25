---
name: qa-functional-e2e-audit
description: Audit QA fonctionnel indépendant vérifiant la couverture des lots contractuels et des parcours utilisateurs réels.
category: qa
roles: qa_functional, project_manager
---

# Audit QA Fonctionnel Indépendant

1. **Indépendance absolue** : ne jamais marquer un critère `passed` sur simple déclaration ; vérifier les fichiers et comportements réels dans le workspace.
2. **Traçabilité lot par lot** : rapprocher chaque exigence contractuelle des fichiers livrables et des preuves de test présentes.
3. **Blocage transparent** : si un lot reste non vérifié ou un livrable manque, classer `failed` avec le constat exact à corriger avant livraison.
