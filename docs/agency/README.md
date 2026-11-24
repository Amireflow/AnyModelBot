# Agency OS — blueprint de référence

**Statut :** architecture de référence en cours d'implémentation ; Agency Core, CRM local, registre de preuves et démarrage/suivi/import des recherches Company Research sont intégrés sur master. La validation CI reste à effectuer.  
**Suivi des lots :** [Roadmap](./ROADMAP.md) · [Lot 2 — CRM](./LOT-2-CRM-API.md) · [Lot 3 — preuves et import de recherche](./LOT-3-RESEARCH-EVIDENCE.md)
**Dépôt :** fork Amireflow/AnyModelBot.  
**Branche de travail :** `master`, conformément à `AGENTS.md`.

## 1. Vision

Faire évoluer AnyModelBot en un système d'exploitation d'agence logicielle assistée par IA, capable de gérer le cycle complet d'une opportunité commerciale et d'un projet client :

1. découvrir et rechercher des entreprises ;
2. qualifier des opportunités avec preuves et sources ;
3. organiser les contacts et le pipeline dans un CRM ;
4. préparer des prises de contact conformes et gérer les conversations autorisées ;
5. comprendre le besoin et préparer une proposition ;
6. faire approuver les engagements commerciaux et juridiques ;
7. collecter les éléments du client et formaliser le périmètre ;
8. piloter un IDE sur la machine du propriétaire ;
9. développer, tester, auditer et corriger ;
10. préparer la livraison, déployer après validation et assurer la maintenance.

Le propriétaire reste dirigeant, responsable des décisions et autorité d'approbation. Le système automatise l'analyse et l'exécution dans les limites explicites d'une politique de permissions.

## 2. Décision d'architecture

Ne pas réécrire le moteur AnyModelBot et ne pas transformer ses tables conversationnelles en CRM.

Construire deux plans séparés :

- **Agency Control Plane** : données métier, CRM, prospects, conversations, clients, devis, contrats, projets, approbations, suivi financier, audit et interface de gestion.
- **Local Execution Node** : processus local qui réutilise AnyModelBot, ses agents, outils, tâches, capacités ordinateur et intégrations IDE pour exécuter les travaux sur la machine autorisée.

Le Control Plane ne doit pas exposer directement le poste personnel. Le Local Execution Node établit une connexion sortante authentifiée, récupère des tâches autorisées, transmet son état et peut être mis en pause ou révoqué.

### Responsabilités des plans

| Domaine | Control Plane | Local Execution Node |
|---|---|---|
| CRM et pipeline | Source de vérité | Lecture de contexte autorisée |
| Consentements et politiques de contact | Source de vérité | Respect et application des décisions |
| Conversations externes | Réception, historique, orchestration | Assistance et préparation |
| Devis et engagements | Règles, calculs, approbations | Préparation documentaire |
| Projet et exigences | Source de vérité | Lecture et exécution des tâches |
| IDE et fichiers de travail | Attribution des tâches | Exécution locale |
| Tests et preuves | Agrégation et validation de statut | Exécution et collecte |
| Production | Approbation et journalisation | Exécution du déploiement autorisé |

## 3. Principes structurants

1. **Réutiliser avant d'ajouter.** Auditer les capacités existantes avant d'installer un autre framework ou de cloner un autre projet.
2. **Séparer le métier de l'exécution.** Le CRM ne dépend pas du runtime d'un agent.
3. **Une source de vérité par domaine.** Les données métier sont centrales ; les données personnelles locales d'AnyModelBot restent dans son stockage local.
4. **Isolation par client et projet.** Un agent ou workspace n'accède qu'aux données explicitement attribuées.
5. **Actions typées et bornées.** Une permission porte sur une action, une ressource, une portée et une durée déterminées.
6. **Approbations humaines pour les engagements.** L'agent ne peut ni signer, ni payer, ni accepter un engagement en lieu et place du propriétaire.
7. **Preuves avant succès.** Une tâche n'est pas terminée sur la seule déclaration de l'agent.
8. **Traçabilité.** Chaque changement métier et action sensible produit un événement d'audit.
9. **Idempotence et reprise.** Les webhooks, tâches et opérations pouvant être répétées doivent être dédupliqués.
10. **Sécurité par défaut.** Les contenus web, documents et messages externes sont des données non fiables, jamais des instructions de sécurité.

## 4. Capacités AnyModelBot à réutiliser

L'audit du dépôt a identifié les composants suivants comme points d'intégration à confirmer par tests lors de l'implémentation :

- `src/agent/manager.ts`, `src/agent/bridge.ts` : cycle agent et pont vers les outils.
- `src/agent/approvals.ts` : centre d'approbation existant.
- `src/tasks/` : tâches en arrière-plan, étapes, budgets et planification.
- `src/tools/search.ts` : recherche web.
- `src/tools/computer-use/` : capacités de contrôle de l'ordinateur.
- `src/tools/apps/` et l'infrastructure MCP : connecteurs d'applications.
- `src/core/access.ts` : admission et contrôle d'accès des utilisateurs de canaux.
- `src/store/db.ts` : stockage SQLite local.
- `src/web/routes/` et `ui/` : interface et routes locales.
- Sous-modules `vendor/magpie`, `vendor/deepseek-harness`, `vendor/kimi-computer-use`.

Ces composants sont des dépendances internes à réutiliser, non des raisons de dupliquer leurs dépôts.

## 5. Nouveaux domaines métier

Le code métier de l'agence doit être organisé en modules indépendants :

- `agency/domain` : types, états, invariants et transitions pures.
- `agency/store` : persistance et migrations.
- `agency/companies` : entreprises, contacts, sources et preuves.
- `agency/prospecting` : recherche, déduplication, qualification et scoring.
- `agency/consent` : consentements, préférences, suppression et politiques de contact.
- `agency/conversations` : conversations, messages, modèles et statuts.
- `agency/sales` : opportunités, catalogue, prix, devis et négociations.
- `agency/contracts` : projets de contrats et validations.
- `agency/projects` : onboarding, exigences, documents et jalons.
- `agency/execution` : tâches, workers, connecteurs et sessions IDE.
- `agency/quality` : tests, audits, anomalies et preuves.
- `agency/delivery` : livraisons, déploiements et retours arrière.
- `agency/audit` : événements append-only et journal de décisions.
- `agency/api` et `agency/ui` : accès et interface métier.

Ces chemins sont des frontières logiques cibles. Le Lot 0 doit confirmer leur emplacement final et la règle de dépendances avant que des imports soient introduits dans le dépôt.

## 6. Parcours métier de bout en bout

```text
Entreprise découverte
  -> recherche sourcée
  -> prospect qualifié
  -> contrôle du canal et du consentement
  -> prise de contact autorisée
  -> conversation et découverte du besoin
  -> opportunité
  -> offre et devis
  -> approbation du propriétaire
  -> contrat validé et accord client
  -> acompte / condition de démarrage vérifié
  -> onboarding et documents
  -> cahier des charges accepté
  -> projet et workspace isolés
  -> plan technique accepté
  -> développement par lots
  -> tests et QA indépendante
  -> préproduction
  -> approbation de production
  -> livraison documentée
  -> maintenance et support
```

Les transitions sont explicites. Une étape n'est jamais considérée comme acquise uniquement parce qu'un agent le dit.

## 7. MVP commercial et technique

Le premier MVP doit démontrer une chaîne réelle, courte et mesurable :

- gérer les entreprises et prospects dans le CRM ;
- créer un dossier de recherche avec sources et date de collecte ;
- expliquer un score de qualification ;
- préparer un message de contact conforme au canal ;
- enregistrer les réponses et produire un résumé commercial ;
- préparer un devis depuis un catalogue de prix déterministe ;
- demander une approbation avant tout engagement ;
- transformer une opportunité acceptée en projet documenté ;
- faire exécuter au moins un petit projet de démonstration via l'IDE ;
- exécuter des tests indépendants et produire un dossier de preuves.

Ne pas attendre la construction de toute l'automatisation pour rechercher une première vente. Les KPI sont les échanges utiles, offres acceptées, encaissements, marge et livraisons acceptées — pas le nombre de tâches IA.

## 8. Hors périmètre initial

- Remplacer DeepSeek Harness ou AnyModelBot.
- Créer une plateforme multi-tenant SaaS publique pour plusieurs agences.
- Lancer des campagnes massives de messages automatisés.
- Automatiser signatures, paiements ou dépenses sans intervention.
- Autoriser les agents à pousser directement en production.
- Développer un système multi-agent complexe avant de démontrer la valeur d'un premier parcours.
- Mélanger les projets clients et les automatisations personnelles FlowAuto.

FlowAuto et les automatisations personnelles pourront réutiliser ultérieurement le Local Execution Node, dans un profil isolé avec comptes, politiques et workspaces propres.

## 9. Documents associés

- [Roadmap par lots](./ROADMAP.md)
- [Sécurité, permissions et approbations](./SECURITY-AND-GOVERNANCE.md)
- [Modèle de données métier](./DATA-MODEL.md)
- [Carte d'intégration AnyModelBot](./INTEGRATION-MAP.md)
