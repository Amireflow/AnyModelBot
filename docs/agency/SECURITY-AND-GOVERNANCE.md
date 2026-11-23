# Agency OS — sécurité, permissions et gouvernance

## 1. Modèle de confiance

Le système traverse plusieurs domaines de confiance distincts :

1. **Propriétaire** : autorité humaine, accès aux décisions et approbations.
2. **Control Plane** : service métier et source de vérité CRM/projets.
3. **Local Execution Node** : machine autorisée, exécution de tâches locales.
4. **Agents IA** : processus non fiables par défaut, limités par des politiques.
5. **Sources externes** : sites web, e-mails, fichiers, documents et messages non fiables.
6. **Clients** : accès strictement limité à leur espace et aux documents qui leur sont destinés.
7. **Services tiers** : API, IDE, hébergement et fournisseurs de modèles.

Aucun texte retourné par une source externe ne peut modifier les politiques système, les permissions ou les règles d'approbation.

## 2. Portée d'une permission

Toute permission doit être définie par le tuple :

- sujet : agent, utilisateur ou service ;
- action : lecture, création, modification, suppression, envoi, déploiement ;
- ressource : entreprise, conversation, document, projet, dépôt, environnement ;
- portée : client, projet, workspace ou élément précis ;
- durée : une exécution, temporaire ou persistante ;
- conditions : budget, état, environnement et approbation ;
- révocation : mécanisme immédiat et audit.

Avoir accès à un workspace ne donne pas le droit de lire les autres projets, les secrets globaux ou la production.

## 3. Niveaux d'autonomie

| Niveau | Exemples | Règle |
|---|---|---|
| A0 — lecture | recherche, lecture de documents autorisés, analyse | automatique, avec limites |
| A1 — préparation | brouillons, notes CRM, spécifications et devis non transmis | automatique dans le périmètre |
| A2 — exécution locale | modifier un workspace, lancer des tests, créer des commits de travail | autorisé par politique bornée |
| A3 — action externe | envoyer un message, transmettre une offre, modifier un service externe | politique explicite et consentement vérifié ; validation humaine selon action |
| A4 — engagement critique | signer, payer, accepter une commande, supprimer des données, déployer en production | approbation humaine obligatoire ; certaines actions restent humaines de bout en bout |

Les actions externes ne doivent pas être regroupées dans une autorisation vague. Une autorisation d'envoyer un message approuvé n'autorise pas l'envoi d'un devis ou d'un contrat.

## 4. Approbations

Une demande d'approbation doit contenir :
- identifiant unique ;
- acteur demandeur ;
- client et projet concernés ;
- action et ressource exactes ;
- paramètres lisibles ;
- motif et contexte ;
- coût estimé ou plafond ;
- conséquences et risques ;
- date d'expiration ;
- statut et décideur ;
- empreinte du contenu ou des paramètres approuvés.

L'approbation doit être liée à l'empreinte de l'action. Si le contenu, le prix, le destinataire ou les paramètres changent, l'approbation devient invalide et une nouvelle décision est requise.

États minimum :
`pending`, `approved`, `rejected`, `expired`, `cancelled`, `executed`, `failed`.

Un redémarrage, un timeout ou un état inconnu ne doit jamais transformer une action en succès. Les actions critiques expirent en échec fermé.

## 5. WhatsApp et autres canaux externes

- Utiliser l'intégration officielle de la plateforme, jamais une automatisation de WhatsApp Web pour contourner les contrôles.
- Conserver la preuve du consentement : source, horodatage, texte ou version de l'avis, canal, périmètre et révocation.
- Bloquer l'envoi lorsque le consentement requis n'est pas démontré.
- Respecter les règles applicables aux modèles de messages, fenêtres de service et catégories de messages.
- Vérifier la signature et la fraîcheur des webhooks.
- Dédupliquer chaque événement entrant.
- Gérer les désinscriptions et listes de suppression avant toute nouvelle campagne.
- Séparer les messages entrants, les réponses de service, les relances et les messages commerciaux.
- Utiliser des limites de débit et un mécanisme de pause globale.
- Ne jamais acheter, importer ou exploiter des listes de numéros sans base légitime et autorisation appropriée.

La conformité finale doit être vérifiée dans la documentation officielle de la plateforme et auprès d'un conseil compétent avant exploitation.

## 6. Protection des données clients

- Isolation stricte par organisation/client/projet.
- Authentification et autorisation côté serveur sur chaque route.
- Stockage privé, liens temporaires et accès journalisés pour les fichiers.
- Secrets dans un coffre dédié ; jamais dans les prompts, logs ou documents.
- Chiffrement des communications et des sauvegardes.
- Rétention limitée et suppression contrôlée.
- Export et rectification selon les obligations applicables.
- Accès minimum nécessaire et révocation à la fin du projet.
- Tests automatisés démontrant qu'un client ne peut pas consulter les données d'un autre.

Le périmètre juridique et les obligations de protection des données au Sénégal et dans tout pays de traitement doivent être examinés avant le lancement commercial.

## 7. Sécurité des agents et du poste local

- Workspace isolé par projet.
- Allowlist des répertoires accessibles.
- Sandbox pour les commandes et processus.
- Blocage par défaut de l'accès aux fichiers de configuration et secrets.
- Blocage des commandes destructrices et opérations système non autorisées.
- Pas de privilèges administrateur par défaut.
- Pas de mode global qui ignore les permissions IDE.
- Limites de durée, CPU/mémoire si disponibles, taille de sortie et budget modèle.
- Interruption, pause et révocation testées.
- Protection SSRF pour les outils qui récupèrent des URL.
- Défense contre prompt injection et fichiers piégés.
- Vérification des binaires, téléchargements, dépendances et signatures lorsque pertinent.

Le code de sortie d'un CLI ou d'un agent ne constitue jamais une preuve suffisante de réussite.

## 8. Intégrité du développement

- Chaque tâche référence le projet, la version des spécifications et le commit de départ.
- Les changements sont limités au dépôt/workspace autorisé.
- Les agents ne peuvent pas modifier les protections Git, secrets CI ou permissions du compte sans approbation dédiée.
- Pas de force push.
- Les commits sont inspectés avant livraison.
- Les migrations disposent d'un plan de retour arrière ou d'une stratégie de restauration.
- Les tests sont exécutés dans un environnement reproductible.
- La QA est séparée de l'agent développeur.
- Les rapports contiennent commandes, résultats, versions et artefacts.

## 9. Journal d'audit

Le journal doit être append-only du point de vue applicatif et enregistrer :
- identifiant d'événement ;
- horodatage UTC ;
- acteur et rôle ;
- organisation/projet/ressource ;
- action ;
- résultat ;
- source ou demande d'origine ;
- identifiant d'approbation ;
- identifiant de tâche et session ;
- empreinte des paramètres non secrets ;
- corrélation avec les événements précédents.

Ne jamais y écrire les tokens, mots de passe, secrets, contenu privé non nécessaire ou données personnelles excessives. Une chaîne de hash peut rendre les altérations détectables, mais ne remplace ni des sauvegardes ni un stockage réellement protégé contre l'administrateur de la base.

## 10. Procédures d'urgence

Le système doit offrir :
- bouton d'arrêt global des agents ;
- arrêt des messages sortants ;
- révocation du Local Execution Node ;
- révocation d'une clé ou intégration ;
- gel d'un projet ;
- arrêt d'une session IDE ;
- gel des déploiements ;
- restauration depuis sauvegarde ;
- journal des actions d'urgence.

Chaque procédure doit être testée avant la mise en production.
