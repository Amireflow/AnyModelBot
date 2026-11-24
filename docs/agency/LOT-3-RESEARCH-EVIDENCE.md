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

## Intégration avec Company Research

Le CRM réutilise maintenant l'instance catalogue `cat-company-research` si elle est déjà installée :

- POST /amb/api/agency/:orgId/companies/:companyId/research/start lance une recherche complète dans la conversation web de l'instance installée ;
- GET /amb/api/agency/:orgId/companies/:companyId/research/jobs liste les tâches actives et terminées non issues des exemples dont le nom ou le domaine correspond à l'entreprise CRM, avec statut/progression ;
- POST /amb/api/agency/:orgId/companies/:companyId/research/import importe les sources d'une tâche terminée sélectionnée ;
- l'interface actualise automatiquement les statuts ; les tâches actives sont vérifiées dans tout le workspace partagé, les lancements concurrents sont refusés et une tâche sans mise à jour depuis 30 minutes ne bloque plus un nouveau lancement ;
- les données sont lues depuis `workspaces/<botId>/app/state.json` et `app/jobs/<jobId>/sources.json`, sans API réseau ni copie des rapports complets ;
- seules les sources marquées comme utilisées dans le rapport sont importées ; les références inutilisées sont comptabilisées séparément ;
- les chemins sont confinés au workspace du bot, les liens symboliques et fichiers anormaux sont refusés, et les tailles/listes sont plafonnées ;
- l'import conserve le titre et le lien de la source, l'identifiant du job et le domaine. Le score de pertinence produit par Company Research reste une pertinence et n'est pas transformé en confiance documentaire ;
- une empreinte par entreprise et URL déduplique les réimports ; un événement d'audit enregistre le job et les compteurs.

Le CRM peut lancer la recherche, mais le traitement est exécuté par l'instance Company Research et son runtime AnyModelBot ; les rapports doivent atteindre le statut completed avant l'import. Les rapports et sources ne sont pas déplacés ou copiés vers le workspace Agency.

La recherche web automatisée de prospection, la configuration de fournisseurs, le cache, les limites de débit, les budgets et le scoring d'adéquation commerciale ne sont pas déclarés livrés par ce lot.

## Limites de l'import

Le fichier `sources.json` n'expose pas nécessairement un résumé factuel de chaque article. L'import crée donc une référence de source traçable, pas une affirmation issue du contenu de l'article. La confiance reste à 0,5 (valeur neutre) et le score de pertinence est conservé dans le résumé comme indicateur distinct. Comme l'export sources.json ne fournit pas de date de publication, la date observée importée reste inconnue (0) : ces références ne sont pas artificiellement comptées comme fraîches. Les résumés factuels devront être importés depuis les fichiers de recherche de domaine dans une étape dédiée.

## Validation à effectuer

- tests du calcul versionné, des catégories, des sources, de la fraîcheur et de la confiance ;
- tests des chemins de workspace, tâches terminées, rapports d'exemple, correspondance d'entreprise et URLs non HTTP ;
- tests d'idempotence de l'import, de la séparation score de pertinence / confiance et de l'audit ;
- tests des routes de lancement/liste/import, du verrou de concurrence et du contrôle d'accès ;
- typecheck, tests unitaires, build et workflow CI.
