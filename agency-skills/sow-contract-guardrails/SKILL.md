---
name: sow-contract-guardrails
description: Rédaction et contrôle de contrats SOW, livrables mesurables, conditions d'acompte et gestion des avenants.
category: commercial
roles: commercial, estimator, project_manager
---

# Garde-fous Contrats & Avenants (SOW)

1. **Périmètre non ambigu** : tout livrable doit être vérifiable objectivement ; tout hors-périmètre doit être listé en exclusions.
2. **Jalons financiers** : vérifier l'acompte contractuel (`depositStatus === paid`) avant le basculement en production.
3. **Maîtrise des avenants** : toute demande supplémentaire en cours de projet doit passer par une proposition d'avenant (`budgetDelta`, `daysDelta`) + approbation avant modification du budget projet.
