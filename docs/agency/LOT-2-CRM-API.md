# Lot 2 — CRM API foundation

## Livré

La base CRM est séparée de la base conversationnelle AnyModelBot. Elle est ouverte au démarrage du serveur web et fermée avec lui. Les routes héritent de l'authentification par jeton déjà utilisée par la console.

Le noyau API couvre :

- création et liste des organisations pour l'opérateur local ;
- création, détail, recherche et filtres d'entreprises ;
- création et recherche de contacts ;
- création, recherche et transitions contrôlées des prospects ;
- filtres par entreprise, étape et texte, avec pagination ;
- indicateurs du pipeline et tableau de bord ;
- historique d'audit par organisation ou entité.

## Routes

Toutes les routes sont sous `/amb/api/agency`.

| Méthode | Chemin | Fonction |
|---|---|---|
| GET, POST | `/organizations` | Lister ou créer une organisation |
| GET | `/:orgId/dashboard` | Compteurs et répartition du pipeline |
| GET, POST | `/:orgId/companies` | Rechercher ou créer des entreprises |
| GET | `/:orgId/companies/:companyId` | Détail d'une entreprise |
| GET, POST | `/:orgId/companies/:companyId/contacts` | Rechercher ou créer des contacts |
| GET | `/:orgId/contacts` | Rechercher les contacts d'une organisation |
| GET, POST | `/:orgId/leads` | Rechercher ou créer des prospects |
| PATCH | `/:orgId/leads/:leadId/stage` | Déplacer un prospect dans le pipeline |
| GET | `/:orgId/timeline` | Historique d'audit |

Les recherches acceptent `q`, `limit` et `offset`. Les entreprises acceptent aussi `industry`, `countryCode`, `city`, `status`. Les contacts acceptent `status`. Les prospects acceptent `companyId` et `stage`.

## Sécurité et limites

- Toutes les routes sont protégées par le jeton de la console AnyModelBot.
- Les requêtes cross-site sont rejetées lorsque les métadonnées du navigateur indiquent une origine différente.
- Les services vérifient l'appartenance à l'organisation et le rôle.
- Des triggers SQLite imposent la cohérence d'organisation pour les relations entreprise/contact/prospect/preuve/consentement, même si un futur appelant contourne les services.
- Les paramètres SQL sont liés ; la pagination est plafonnée à 100 éléments et l'historique à 200 événements.
- Cette première intégration utilise l'identité locale stable `local-owner`. C'est un **MVP mono-opérateur local**, pas un système de comptes SaaS multi-utilisateurs. Ne pas exposer cette API comme un service public multi-tenant avant l'authentification réelle, la gestion des adhésions et l'adaptateur de base centralisée.
- Aucun message de prospection WhatsApp, devis, signature, paiement ou déploiement n'est déclenché par cette API.

## Validation

Les tests couvrent l'isolation entre organisations, les relations inter-tenant, les filtres, la pagination, les compteurs, l'historique, les statuts de consentement et les payloads d'approbation.

Le workflow CI prend désormais en charge `workflow_dispatch`, pour permettre un lancement manuel après activation de GitHub Actions sur le fork. Les modifications sont regroupées dans un seul commit. Le lot ne sera pas déclaré validé tant qu'une exécution CI ne sera pas terminée avec succès.

## Hors périmètre de ce lot

L'interface CRM visuelle, les comptes multi-utilisateurs, PostgreSQL centralisé, la recherche web de prospects et les workflows de recherche/qualification restent à implémenter. La prospection automatique demeure désactivée jusqu'à validation du consentement et intégration officielle du fournisseur de messagerie.
