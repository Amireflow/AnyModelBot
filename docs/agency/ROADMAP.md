# Agency OS — roadmap d'implémentation par lots

**Règle de livraison :** un commit significatif par grand lot fonctionnel terminé, pas un commit par fichier ou petite correction. Les travaux incomplets d'un même lot restent regroupés jusqu'à ce que les critères de sortie soient satisfaits.

## Politique Git

- Travailler exclusivement sur `master`, conformément à `AGENTS.md`.
- Lire le SHA courant de `master` avant un push et utiliser une mise à jour protégée par `expected_sha`.
- Regrouper code, tests, migrations et documentation associés dans le même commit de lot.
- Ne pas créer de commits rapprochés pour des changements intermédiaires sans valeur autonome.
- Ne jamais écraser l'historique ni forcer une mise à jour de branche.
- Utiliser un message décrivant le résultat du lot, par exemple `feat(agency): implement crm and prospect pipeline`.
- Un lot peut contenir plusieurs sous-chantiers internes, mais n'est commité qu'après vérification intégrale.
- Si un lot doit être interrompu, conserver son état de travail sans le déclarer terminé ; reprendre les vérifications avant le commit.
- Les releases restent séparées des commits de développement et suivent strictement les exigences existantes d'AnyModelBot.

## Méthode commune à tous les lots

Pour chaque lot :

1. vérifier l'état de `master` et les fichiers impactés ;
2. lire les conventions et tests existants ;
3. définir les contrats et invariants ;
4. implémenter les changements cohérents ensemble ;
5. ajouter tests unitaires, intégration et régression ;
6. exécuter les suites pertinentes et les commandes de build/typecheck ;
7. vérifier les migrations et les cas de reprise ;
8. inspecter le diff complet ;
9. documenter ce qui est prouvé, non prouvé et reporté ;
10. créer un seul commit de lot après réussite.

Un commit ne signifie pas automatiquement qu'une fonctionnalité est prête pour la production.

## Lot 0 — Audit et baseline technique

**Objectif :** établir la carte vérifiée d'AnyModelBot et figer les frontières d'intégration.

Travaux :
- examiner architecture, cycle de vie, stockage, routes, UI, agents, bridge, outils, tâches et approbations ;
- inventorier les tests et leur couverture pertinente ;
- identifier les migrations et règles d'accès ;
- confirmer les possibilités exactes du CLI IDE et de l'environnement ;
- examiner les licences et dépendances des composants existants ;
- définir les frontières de modules et les contrats d'événements ;
- écrire les décisions d'architecture et les critères de sortie des lots.

Sortie :
- blueprint, modèle de données, carte d'intégration, matrice de risques et roadmap validés ;
- baseline de tests enregistrée sans prétendre avoir exécuté les tests qui n'ont pas été lancés ;
- aucun changement de comportement de l'application.

## Lot 1 — Agency Core, gouvernance et audit

**Objectif :** créer le socle métier fiable.

Travaux :
- namespace métier isolé ;
- migrations métier versionnées ;
- identifiants, relations et contraintes ;
- organisation, entreprises, contacts et projets ;
- machine à états et transitions métier ;
- registre d'approbations métier ;
- journal d'événements append-only ;
- idempotency keys et déduplication ;
- contrats de services et validation des entrées ;
- tests d'isolation et de transition.

Sortie :
- services et stockage utilisables sans modifier les fonctions personnelles existantes ;
- isolation vérifiée entre organisations/projets ;
- tests migration, reprise, déduplication et autorisations.

## Lot 2 — CRM et pipeline commercial

Travaux :
- entreprises et contacts ;
- gestion des sources et preuves ;
- qualification manuelle/assistée ;
- pipeline et transitions ;
- notes, tâches de suivi et rappels ;
- recherche, filtres et fusion contrôlée des doublons ;
- API et première interface CRM ;
- export et sauvegarde.

Sortie :
- parcours complet de création, qualification, suivi et archivage testé ;
- historique cohérent et traçable.

## Lot 3 — Intelligence commerciale et recherche

Travaux :
- fournisseurs de recherche configurables ;
- collecte de données publiques et pages officielles ;
- extraction structurée avec provenance ;
- détection des sites et présences numériques ;
- observations factuelles séparées des hypothèses ;
- scoring explicable et versionné ;
- déduplication multi-sources ;
- cache, limites de débit et budgets ;
- validation humaine des dossiers à fort impact.

Sortie :
- un lot d'entreprises analysé avec sources vérifiables ;
- chaque score explicable ;
- aucun enrichissement non sourcé présenté comme un fait.

## Lot 4 — Consentement et WhatsApp Business officiel

Travaux :
- adaptateur Cloud API officiel ;
- stockage des identifiants dans un coffre de secrets ;
- vérification de signature des webhooks ;
- déduplication des événements entrants ;
- modèles approuvés et statut d'approbation ;
- fenêtre de service et règles de messages ;
- registre de consentement avec provenance, portée, horodatage et révocation ;
- opt-out et suppression ;
- gestion des erreurs et reprise ;
- simulation complète en environnement de test.

Sortie :
- messages bloqués par défaut si les conditions de contact ne sont pas démontrées ;
- tests des règles de consentement, modèles, fenêtres, doublons et désinscription ;
- aucun contournement via WhatsApp Web.

## Lot 5 — Agent commercial

Travaux :
- contexte CRM et dossier prospect ;
- qualification conversationnelle ;
- classification des intentions et objections ;
- propositions de réponses sourcées ;
- transfert à l'humain ;
- règles de ton et identité commerciale ;
- garde-fous contre promesses inventées ;
- suivi de conversion et qualité des échanges.

Sortie :
- scénarios commerciaux simulés et revus ;
- agent capable de s'arrêter et demander une décision ;
- aucune prise d'engagement non approuvée.

## Lot 6 — Catalogue de services, devis et contrats

Travaux :
- catalogue de prestations ;
- prix versionnés, coûts, marges et limites ;
- calculs déterministes ;
- options et changements de périmètre ;
- génération de devis et versions ;
- modèles contractuels approuvés ;
- approbation propriétaire ;
- état de signature et de paiement enregistré sans simuler leur réalisation.

Sortie :
- devis reproductible et mathématiquement vérifié ;
- engagements sensibles bloqués jusqu'à approbation ;
- contrats étiquetés comme projets tant qu'ils ne sont pas validés/signés.

## Lot 7 — Client onboarding et gestion de projet

Travaux :
- ouverture d'un dossier après acceptation ;
- collecte guidée des documents ;
- stockage privé ;
- clarification des ambiguïtés ;
- brief, PRD, spécifications, parcours et critères d'acceptation ;
- jalons et suivi du périmètre ;
- validation client/propriétaire ;
- procédure de changement de périmètre.

Sortie :
- projet prêt à développer uniquement lorsque les critères d'entrée sont satisfaits ;
- exigences reliées à des tests ou critères d'acceptation.

## Lot 8 — Local Execution Node et adaptateur IDE

Travaux :
- identité du poste et enregistrement de l'agent local ;
- connexion sortante authentifiée ;
- heartbeat, révocation et mode pause ;
- file de tâches durable ;
- adaptateur Antigravity CLI ;
- suivi d'événements structurés ;
- délais, interruption et récupération ;
- contrôle workspace, commandes, permissions et coût ;
- capture des sorties, changements et traces ;
- tests de refus et de session interrompue.

Sortie :
- tâche de test lancée depuis le Control Plane, exécutée localement et rapportée avec un statut vérifié ;
- aucun accès au poste hors du workspace autorisé.

## Lot 9 — Orchestration de développement

Travaux :
- planification technique à partir des exigences ;
- découpage en tâches indépendantes ;
- agent architecte et agent développeur ;
- gestion des dépendances et verrous de fichiers ;
- règles Git et contrôle des modifications ;
- checkpoints et reprise après panne ;
- budget et limites d'exécution ;
- tests automatiques déclenchés après chaque sous-ensemble cohérent.

Sortie :
- petit projet réel ou démonstrateur construit par l'IDE ;
- modifications traçables et reproductibles ;
- arrêt propre lorsqu'une décision est nécessaire.

## Lot 10 — QA, sécurité et preuves

Travaux :
- vérificateur indépendant ;
- tests de type, lint, unitaires, intégration et E2E ;
- navigation Playwright ;
- captures et vérification visuelle ;
- audit sécurité adapté ;
- gestion des vulnérabilités et anomalies ;
- rapport de couverture des critères ;
- non-régression.

Sortie :
- aucun résultat déclaré réussi sans preuve ;
- anomalies bloquantes empêchent le passage au lot livraison.

## Lot 11 — Livraison et maintenance

Travaux :
- environnements développement, préproduction et production ;
- adaptateurs de déploiement ;
- vérification des variables, migrations et domaines ;
- smoke tests et health checks ;
- approbation avant production ;
- rollback ;
- dossier de livraison client ;
- monitoring et gestion d'incidents ;
- maintenance et rapports.

Sortie :
- livraison vérifiée et acceptée ;
- capacité de retour arrière testée ;
- client reçoit les documents et éléments prévus au contrat.

## Lot 12 — Industrialisation

Travaux :
- tableaux de bord de conversion et de rentabilité ;
- amélioration du routage des modèles par tâche ;
- optimisation des coûts ;
- quotas globaux et par projet ;
- observabilité et alertes ;
- sauvegardes et restauration ;
- évaluation périodique des agents ;
- amélioration des prompts par résultats mesurés ;
- automatisations avancées uniquement après preuve d'utilité.

Sortie :
- système exploitable de façon durable avec indicateurs de fiabilité, coût, qualité et rentabilité.

## Critères de passage transversaux

Un lot est terminé uniquement si :
- les objectifs écrits sont satisfaits ;
- les tests concernés ont réellement été exécutés ;
- les régressions pertinentes passent ;
- le diff complet a été relu ;
- les risques et limites sont documentés ;
- la documentation correspond au comportement réel ;
- les preuves sont accessibles ;
- la branche n'a pas été mise à jour si le SHA courant diffère de celui inspecté.

## Ordre recommandé pour la première livraison commerciale

Les lots 1 à 7 fournissent le premier flux commercial ; le lot 8 commence ensuite le pont avec la machine et l'IDE. Les lots 9 à 11 transforment le pont en service complet de développement et de livraison. Le système doit rechercher et valider une demande réelle pendant sa construction — pas attendre le dernier lot pour découvrir si quelqu'un achète.


---

## État d'implémentation — socle CRM

Le noyau API du Lot 2 est maintenant intégré derrière l'authentification du serveur local : organisations, entreprises, contacts, prospects, filtres, pagination, tableau de bord et historique d'audit. La base CRM reste séparée de la base conversationnelle.

**Le CRM local dispose maintenant d'un premier écran utilisable**, intégré à la navigation AnyModelBot : création d'organisation, tableau de bord, entreprises, contacts et pipeline des prospects, avec recherche, pagination et transitions de statut. L'authentification multi-utilisateur, PostgreSQL centralisé, la recherche web de prospects et les workflows de qualification restent à livrer. Les envois commerciaux automatisés demeurent désactivés tant que le consentement et l'intégration officielle du fournisseur ne sont pas vérifiés.

Le registre de preuves du Lot 3 est maintenant exposé dans le CRM local : ajout et listage de sources par entreprise, provenance conservée et score de qualité de dossier explicable. Ce score mesure la couverture des domaines, la diversité des sites, la confiance et la fraîcheur des sources ; il ne mesure pas l'appétence commerciale et ne qualifie jamais automatiquement un prospect. La recherche web automatisée, les fournisseurs configurables, l'import automatique des rapports du bot Company Research, les quotas et le cache restent à livrer.

Le contrôle CI doit être exécuté sur le commit livré avant de déclarer le lot validé.
