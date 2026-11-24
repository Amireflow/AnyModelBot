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
- les données sont lues depuis `workspaces/<botId>/app/state.json`, `app/jobs/<jobId>/sources.json` et, lorsqu'il existe, `app/jobs/<jobId>/curated.json`, sans API réseau ni copie du rapport complet ;
- seules les sources marquées comme utilisées dans le rapport sont importées ; les références inutilisées sont comptabilisées séparément ;
- les chemins sont confinés au workspace du bot, les liens symboliques et fichiers anormaux sont refusés, et les tailles/listes sont plafonnées ;
- `sources.json` reste la référence pour savoir si le rapport cite une source. L'import la rapproche de `curated.json` par URL canonique et conserve, lorsqu'ils existent, le résumé factuel, le contenu enrichi et la date de publication ;
- une empreinte par entreprise et URL déduplique les réimports ; un événement d'audit enregistre le job et les compteurs.

Le CRM peut lancer la recherche, mais le traitement est exécuté par l'instance Company Research et son runtime AnyModelBot ; les rapports doivent atteindre le statut completed avant l'import. Les rapports et sources ne sont pas déplacés ou copiés vers le workspace Agency.

La recherche web automatisée de prospection, la configuration de fournisseurs, le cache, les limites de débit, les budgets et le scoring d'adéquation commerciale ne sont pas déclarés livrés par ce lot.

## Limites de l'import

Le résumé et le contenu enrichi sont récupérés depuis `curated.json` uniquement pour les URL également présentes dans `sources.json` et marquées comme citées par le rapport. Le texte importé est conservé comme référence externe non fiable à vérifier, pas comme instruction. Les anciens rapports sans `curated.json` restent importables avec le comportement précédent : simple référence de source. La confiance reste à 0,5 (valeur neutre), car le score Company Research mesure la pertinence de la source et non la fiabilité factuelle. La date observée est renseignée uniquement lorsqu'un `publishedAt` valide est présent ; sinon elle reste inconnue (0), sans bonus artificiel de fraîcheur.

## Qualification commerciale basée sur le profil client idéal

Le CRM dispose d'un moteur `company-fit-v1` déterministe, distinct du score de qualité documentaire :

- chaque organisation peut configurer ses secteurs et pays cibles, ses secteurs exclus, ses domaines de preuves obligatoires et l'exigence d'un site officiel ;
- l'évaluation expose chaque critère, son poids, son résultat et la couverture des critères effectivement évaluables ;
- une donnée manquante produit un résultat inconnu et diminue la couverture ; elle n'est pas inventée ni automatiquement considérée comme un échec ;
- un secteur exclu est un blocage explicite ;
- l'évaluation est consultative : elle ne fait pas avancer un prospect dans le pipeline et n'infère ni intention d'achat, ni budget, ni capacité financière.

Le profil est enregistré par organisation. Seuls le propriétaire et l'administrateur peuvent le modifier. L'évaluation est calculée à la demande à partir des attributs CRM et de la présence des domaines de preuves.

## Validation à effectuer

- tests du calcul versionné, des catégories, des sources, de la fraîcheur et de la confiance ;
- tests des chemins de workspace, tâches terminées, rapports d'exemple, correspondance d'entreprise et URLs non HTTP ;
- tests d'idempotence de l'import, de la séparation score de pertinence / confiance et de l'audit ;
- tests des routes de lancement/liste/import, du verrou de concurrence et du contrôle d'accès ;
- typecheck, tests unitaires, build et workflow CI.
