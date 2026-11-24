# Lot 3 — Registre de preuves et qualité des dossiers de recherche

## Périmètre livré

Le CRM local expose un registre de preuves lié à une entreprise et, facultativement, à un prospect :

- GET /amb/api/agency/:orgId/companies/:companyId/evidence liste les éléments et retourne l'évaluation du dossier ;
- POST /amb/api/agency/:orgId/companies/:companyId/evidence ajoute un élément sourcé ;
- chaque élément conserve catégorie, URL source, résumé factuel, empreinte facultative, confiance déclarée, date observée et date de collecte ;
- l'API applique les vérifications d'organisation, de rôle et de relation entreprise/prospect ;
- l'historique d'audit conserve la création de la preuve ;
- le panneau Entreprise permet d'ajouter, consulter et ouvrir les sources.

## Score de qualité des preuves

Le modèle research-evidence-v1 calcule un score de 0 à 100 à partir de quatre dimensions déterministes :

| Dimension | Poids | Règle |
|---|---:|---|
| Couverture | 40 | Présence de preuves dans les domaines company, industry, financial et news |
| Diversité des sources | 20 | Nombre de noms d'hôte distincts, plafonné à cinq |
| Confiance déclarée | 20 | Moyenne des confiances enregistrées |
| Fraîcheur | 20 | Part des preuves observées dans les 365 derniers jours |

Les recommandations et le détail des points sont retournés avec le score. Les catégories inconnues restent dans le décompte total mais ne contribuent pas à la couverture.

Ce score mesure la complétude et la qualité documentaire. Ce n'est ni une probabilité de conversion, ni un score d'adéquation commerciale. Le statut review_ready signifie uniquement que le dossier peut être soumis à une revue humaine. Il ne fait pas passer le prospect à l'étape CRM qualified.

## Relation avec Company Research

AnyModelBot contient déjà le bot company-research, qui peut produire des rapports et des sources localement. Ce lot ne déclenche pas encore ce bot depuis le CRM et n'importe pas automatiquement ses fichiers. Les preuves peuvent être ajoutées manuellement dans le panneau entreprise ; l'intégration directe du rapport et de sources.json reste un chantier suivant.

La collecte web automatisée, la configuration de fournisseurs, le cache, les limites de débit, les budgets et la déduplication multi-sources ne sont pas déclarés livrés par ce lot.

## Validation à effectuer

- tests du calcul versionné, des catégories, des sources, de la fraîcheur et de la confiance ;
- tests du contrôle d'accès et de l'isolation par organisation ;
- typecheck, tests unitaires, build et workflow CI.
