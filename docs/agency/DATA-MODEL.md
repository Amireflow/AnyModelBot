# Agency OS — modèle de données métier logique

Ce document décrit le modèle métier cible. Il ne constitue pas encore une migration SQL : les types définitifs, index, contraintes et stratégie de stockage seront arrêtés après l'audit des conventions de persistance existantes.

## 1. Identifiants et conventions

- Utiliser des identifiants UUID générés côté application ou équivalents résistants aux collisions.
- Enregistrer les horodatages en UTC sous forme numérique ou ISO normalisée de manière cohérente.
- Les montants sont stockés en unités monétaires mineures entières et accompagnés d'un code devise ISO, par exemple XOF.
- Les statuts sont des enums/versionnés, avec transitions validées dans des services métier.
- Les données supprimées pour raison légale ou opérationnelle suivent une politique explicite de rétention ; ne pas conserver indéfiniment les données simplement parce qu'un audit existe.
- Toute entité métier possède `created_at`, `updated_at` et, quand nécessaire, `archived_at` ou `deleted_at`.
- Les tables multi-tenant contiennent une clé d'organisation et/ou de projet, vérifiée côté service et base de données.

## 2. Organisation et accès

### Organization
- `id`
- `name`
- `legal_name`
- `country_code`
- `default_currency`
- `status`
- `created_at`

### User / Membership
- identité locale ou fédérée ;
- organisation ;
- rôle ;
- statut ;
- permissions ciblées ;
- date de révocation.

Rôles de départ : propriétaire, administrateur, collaborateur, auditeur et client limité. Ne pas implémenter une matrice complexe avant de définir les usages réels.

### LocalNode
- identifiant de l'installation locale ;
- organisation propriétaire ;
- nom de poste ;
- plateforme et version ;
- dernière activité ;
- statut de révocation ;
- capacités déclarées ;
- clé d'identité gérée séparément.

Les secrets d'authentification du nœud ne sont jamais présents dans les événements ni les réponses de l'API.

## 3. Prospection et CRM

### Company
- organisation propriétaire de la fiche ;
- nom normalisé ;
- nom commercial ;
- secteur ;
- pays et localisation ;
- site officiel ;
- identifiants publics éventuellement disponibles ;
- statut CRM ;
- date de dernière vérification.

### Contact
- entreprise ;
- nom, rôle et canal professionnel ;
- coordonnées avec classification de source ;
- statut ;
- préférences de communication ;
- niveau de confiance ;
- date de vérification.

### Lead
- entreprise et contact principal ;
- source d'acquisition ;
- propriétaire commercial ;
- étape du pipeline ;
- valeur potentielle estimée ;
- devise ;
- score et version de l'algorithme ;
- prochaine action ;
- date de qualification.

### Evidence
- entreprise ou prospect ;
- type de preuve ;
- URL/source ;
- extrait ou résumé limité ;
- date de collecte ;
- date observée ;
- niveau de confiance ;
- empreinte du contenu ;
- auteur/processus de collecte.

Une information issue d'un site web doit rester distincte de l'interprétation produite par le modèle.

### ConsentRecord
- contact et organisation ;
- canal et finalité exacts (aucune portée implicite ou wildcard) ;
- source, référence de preuve et version exacte du texte présenté ;
- date d'obtention et expiration éventuelle ;
- retrait enregistré comme nouvel événement, sans effacer l'historique ;
- statut accordé ou retiré.

Un accord ne peut autoriser un envoi que si sa source, sa référence de preuve et sa version de texte sont présentes, qu'il est le dernier événement pour le couple canal/finalité et qu'il n'est pas expiré. La référence est une pièce justificative à examiner par un humain ; sa seule présence ne constitue pas une vérification automatisée de son authenticité.

### SuppressionRecord
- identifiant minimal nécessaire pour empêcher un nouveau contact ;
- canal ;
- date ;
- portée ;
- source de la demande ;
- statut et motif.

## 4. Conversations

### Conversation
- prospect/client ;
- canal et identifiant externe ;
- statut ;
- fenêtre de service calculée à partir des événements pertinents ;
- agent affecté ;
- propriétaire humain ;
- dernier événement ;
- métadonnées de routage non sensibles.

### Message
- conversation ;
- identifiant provider unique ;
- direction ;
- type et contenu ou référence sécurisée ;
- modèle utilisé le cas échéant ;
- statuts provider ;
- horodatages ;
- empreinte et identifiant de déduplication.

Les pièces jointes sont conservées séparément avec accès privé.

### WhatsAppWebhookEvent
- organisation et clé idempotente de l'événement ;
- identifiant du message Meta ;
- nature de l'événement (message entrant ou statut) ;
- statut provider, timestamp et contact CRM associé lorsqu'il est identifié ;
- date de réception.

Ne pas conserver le payload JSON brut par défaut : les textes entrants et médias ne sont pas nécessaires à la synchronisation de statuts ou à la désinscription. Les événements de statut alimentent `provider_status` de la ligne sortante sans confondre acceptation HTTP et livraison.

Pour WhatsApp Cloud API, une ligne de file sortante doit référencer exactement le contact, le consentement actif, l'approbation propriétaire, l'empreinte du payload, le modèle approuvé, la clé d'idempotence, le statut de soumission et l'identifiant provider. Une acceptation HTTP par Meta ne vaut pas confirmation de livraison ; les statuts delivered/read/failed viennent des webhooks vérifiés.

### ChannelTemplate
- provider ;
- identifiant externe ;
- catégorie ;
- langue ;
- statut d'approbation ;
- version et paramètres autorisés.

## 5. Ventes et engagements

### ServiceCatalogItem
- nom et description ;
- catégorie ;
- périmètre inclus/exclu ;
- options ;
- coûts estimés ;
- prix plancher, recommandé et plafond ;
- durée indicative ;
- version et statut.

### PriceBook
- devise ;
- version ;
- date d'effet ;
- règles de remise et d'approbation.

### Deal
- lead ;
- étape ;
- montant estimé ;
- probabilité, si utilisée, explicitement marquée comme estimation ;
- prochaine action ;
- raison de gain/perte.

### Quote / QuoteLine
- version ;
- client et deal ;
- lignes, quantités et prix ;
- remises ;
- taxes/traitement fiscal à définir ;
- total calculé de façon déterministe ;
- conditions ;
- date de validité ;
- statut ;
- approbation liée à l'empreinte du devis.

### Contract
- devis source ;
- version de modèle ;
- version du contenu ;
- statut de revue ;
- statut de signature ;
- parties ;
- dates ;
- lien sécurisé vers le document.

Un document généré est un brouillon tant que sa revue et sa signature ne sont pas confirmées.

### PaymentRecord
- client et projet/deal ;
- montant et devise ;
- moyen et référence du fournisseur ;
- statut confirmé par source fiable ;
- date ;
- frais ;
- justificatif privé.

Une promesse de paiement ou un webhook non vérifié ne constitue pas un encaissement.

## 6. Projets

### Project
- client ;
- devis et contrat approuvés ;
- nom et objectif ;
- statut ;
- budget et devise ;
- échéances ;
- responsables ;
- dépôt/workspace ;
- version des spécifications ;
- état du paiement/démarrage ;
- niveau de risque.

### ClientDocument
- projet ;
- catégorie ;
- stockage privé ;
- nom et type MIME validés ;
- taille ;
- empreinte ;
- provenance ;
- visibilité ;
- statut d'analyse ;
- dates de rétention.

### Requirement
- projet ;
- identifiant lisible ;
- description ;
- priorité ;
- source (client, analyse, décision) ;
- statut ;
- critère d'acceptation ;
- version ;
- lien vers test ou preuve.

### Specification
- projet ;
- type (brief, PRD, fonctionnel, technique, UX, API, données, test) ;
- version ;
- statut de revue ;
- approbateur ;
- empreinte ;
- document associé.

### Milestone
- projet ;
- ordre ;
- livrable ;
- date prévue ;
- dépendances ;
- statut ;
- critère d'acceptation.

## 7. Exécution et qualité

### Workspace
- projet ;
- LocalNode ;
- chemin local ;
- dépôt distant ;
- branche de travail selon politique du dépôt ;
- commit de départ ;
- statut de confinement ;
- date de création et d'archivage.

### DevelopmentTask
- projet ;
- exigence(s) liées ;
- tâche parent ;
- description ;
- critères ;
- priorité ;
- statut ;
- budget ;
- échéance ;
- tentative et stratégie de reprise.

### AgentRun
- tâche ;
- agent/rôle ;
- modèle et version ;
- session IDE ;
- dates ;
- statut final ;
- coût et usage ;
- événement de corrélation ;
- résumé non sensible.

### TestRun
- projet et commit ;
- suite et commande ;
- environnement ;
- statut ;
- durée ;
- rapport ;
- artefacts de preuve ;
- date.

### Finding
- projet ;
- catégorie et sévérité ;
- description ;
- preuve ;
- exigence liée ;
- statut ;
- décision ;
- version corrigée.

### Deployment / Release
- projet ;
- environnement ;
- commit/artifact ;
- demandeur ;
- approbation ;
- statut provider ;
- health check ;
- rollback associé.

### Delivery
- projet ;
- éléments remis ;
- destinataire ;
- date ;
- statut d'acceptation ;
- pièces justificatives.

## 8. Gouvernance et audit

### Approval
- acteur demandeur ;
- action et ressource exactes ;
- client/projet ;
- paramètres et empreinte ;
- motif ;
- coût/risque ;
- expiration ;
- statut ;
- décideur ;
- résultat d'exécution.

### AuditEvent
- identifiant et horodatage ;
- acteur ;
- type d'événement ;
- organisation et ressource ;
- action ;
- résultat ;
- identifiant de corrélation ;
- empreinte de l'événement et référence précédente ;
- métadonnées non sensibles.

### IdempotencyRecord
- fournisseur et scope ;
- clé ;
- résultat associé ;
- statut de traitement ;
- expiration ;
- date.

## 9. Relations importantes

- Une organisation possède plusieurs entreprises, contacts, prospects, utilisateurs et projets.
- Une entreprise possède plusieurs contacts et preuves.
- Un prospect référence une entreprise et peut avoir plusieurs conversations et opportunités.
- Un contact possède des consentements distincts par canal et finalité.
- Une opportunité produit plusieurs versions de devis ; un devis approuvé peut être lié à un contrat.
- Un projet ne devient exécutable qu'après les conditions commerciales et de démarrage exigées.
- Un projet possède des documents, exigences, spécifications, jalons, workspaces et livraisons.
- Une tâche de développement référence une exigence et produit des exécutions et preuves.
- Toute action externe ou critique référence une approbation quand la politique l'exige.

## 10. Invariants métier

1. Aucun message commercial sortant n'est envoyé sans autorisation applicable démontrée.
2. Aucun projet n'est lancé avec un périmètre et des conditions de démarrage inconnus.
3. Aucun prix n'est calculé par génération libre de texte ; le moteur tarifaire est déterministe.
4. Un devis ou contrat modifié après approbation nécessite une nouvelle approbation.
5. Aucune lecture inter-client n'est permise par défaut.
6. Un agent n'est jamais une preuve de paiement ou d'acceptation client.
7. Un état inconnu reste inconnu ; il ne devient pas succès.
8. Toute exécution locale est liée à un projet, un workspace et une tâche.
9. Une livraison référence un commit et des preuves de vérification.
10. Les données personnelles et secrets ne sont jamais copiés dans l'audit non protégé.
