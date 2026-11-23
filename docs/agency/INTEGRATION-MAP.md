# Agency OS — carte d'intégration avec AnyModelBot

Cette carte décrit les points d'intégration observés dans le fork au moment de la préparation du blueprint. Chaque intégration devra être confirmée par inspection plus profonde et tests avant modification.

## 1. Composants existants

| Chemin | Rôle existant observé | Utilisation cible | Précaution |
|---|---|---|---|
| `src/agent/manager.ts` | gestion des agents et des outils | orchestrer les exécutions projet | ne pas y entasser la logique CRM |
| `src/agent/bridge.ts` | pont local vers le runtime DSH | adapter les actions du Local Node | valider chaque route et payload |
| `src/agent/approvals.ts` | validations d'outils/questions | lier les approbations aux demandes Agency | ne pas mélanger approvals métier et approvals d'outils sans contrat |
| `src/tasks/` | tâches, budgets, planification | moteur d'exécution local | garder les tâches métier séparées des tâches du runtime |
| `src/tools/search.ts` | recherche web | fournisseur de collecte | stockage métier des preuves dans Agency |
| `src/tools/computer-use/` | contrôle d'ordinateur | sessions de navigateur/IDE | permissions projet et workspace en plus des permissions OS |
| `src/tools/apps/` | outils d'applications connectées | connecteurs futurs | secrets gérés côté hôte |
| `src/core/access.ts` | admission des utilisateurs de canaux | conserver le contrôle d'accès AnyModelBot | ne pas confondre avec les rôles CRM |
| `src/store/db.ts` | SQLite local | état local et journal du node | ne pas transformer SQLite local en CRM central |
| `src/web/server.ts` | serveur de l'interface locale | intégrer le panneau d'état du node si nécessaire | ne pas exposer le Control Plane public sur cette interface |
| `src/web/routes/` | API locale | API locale node | API métier séparée et authentifiée |
| `ui/` | interface Preact | éléments de supervision locale | ne pas coupler toute l'UI locale au CRM central |

## 2. Sous-modules et dépendances

Le dépôt contient les sous-modules déclarés dans `.gitmodules` :

- `vendor/magpie` — https://github.com/yetone/magpie
- `vendor/deepseek-harness` — https://github.com/deepseek-ai/deepseek-harness
- `vendor/kimi-computer-use` — https://github.com/songkeys/kimi-computer-use

Le dépôt déclare également un packaging du CUA Driver dans ses scripts et ressources.

Ne pas re-cloner ces projets ni installer une autre plateforme d'agents sans constat de manque vérifié et ADR spécifique.

## 3. Nouvelles intégrations

### Antigravity

- Adaptateur isolé du domaine métier.
- Interface CLI structurée et événements.
- Détection de version et capacité.
- Statut explicite : réussi, échoué, refusé, timeout, interrompu ou inconnu.
- Workspace et commandes autorisés.
- Aucun raccourci de permissions dangereuses.
- Vérifier les diagnostics en plus du code de sortie.

L'adaptateur doit permettre d'ajouter un autre IDE sans réécrire l'orchestrateur métier.

### WhatsApp Business Platform

- Connecteur officiel côté Control Plane.
- Webhooks vérifiés, idempotence et signatures.
- Envoi soumis au registre de consentement et aux règles du provider.
- Clés gardées côté serveur, jamais transmises aux agents.
- Bac à sable / compte de test avant production.

### PostgreSQL et stockage documentaire

- Source de vérité centrale pour les données Agency.
- Migrations dédiées, sauvegardes et tests de restauration.
- Documents clients stockés dans un espace objet privé.
- SQLite reste le stockage local d'AnyModelBot.

### Playwright

- Dépendance de validation E2E si le projet le requiert.
- Browser contexts et secrets de test isolés.
- Captures et rapports liés au commit testé.

## 4. Limites à confirmer pendant le Lot 0

- Version exacte de Node et dépendances sur l'environnement cible.
- Commandes de test et durée complète des suites.
- Comment le Local Node pourra recevoir des tâches de façon durable.
- Adaptateur IDE réellement disponible sur la machine du propriétaire.
- Capacité d'annulation et récupération des sorties CLI.
- Gestion actuelle des sessions CUA et contrôle de plusieurs workspaces.
- Frontière exacte entre approbations DSH et approbations métier.
- Disponibilité et schéma des migrations SQLite existantes.
- Configuration de stockage central et hébergement.
- Conditions de déploiement et comptes fournisseurs.

## 5. Politique de non-régression

- AnyModelBot personnel doit continuer à démarrer et à fonctionner sans configuration Agency.
- Les fonctionnalités de chat, modèles, tâches, approbations, CUA et connexions existantes doivent rester intactes.
- Le module métier est désactivable indépendamment.
- Les tests architecture vérifient les frontières de dépendances.
- Les migrations Agency ne modifient pas les lignes de données personnelles existantes.
- Aucun changement de publication ne doit être introduit avant l'audit des workflows de release et des références d'origine encore présentes dans le packaging.
