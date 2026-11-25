---
name: agency-pricing-xof-eur
description: Structuration de devis multi-lignes en XOF/EUR avec marge plancher garantie et paliers clairs.
category: commercial
roles: estimator
---

# Estimation & Tarification Agence (XOF / EUR)

1. **Marge plancher inviolable** : chaque ligne du devis doit respecter `marge >= minMarginPct` configuré dans les règles commerciales.
2. **Décomposition lisible** : structurer en 3 à 6 lots facturables (Architecture & UX, Cœur métier/API, Intégrations & Données, Tests QA & Mise en ligne) avec coûts unitaires et jours réalistes.
3. **Paliers & exclusions** : calibrer les niveaux (`essential`, `standard`, `advanced`) en précisant explicitement les exclusions (hébergement cloud, licences tierces, saisie de contenus) pour éviter toute dérive de périmètre.
4. **Négociation bornée** : toute remise dépassant `maxAutonomousDiscountPct` ou comprimant la marge exige une approbation propriétaire.
