# AnyModelBot — Présentation générale du projet

> Document de référence produit et technique.  
> Dépôt : [Amireflow/AnyModelBot](https://github.com/Amireflow/AnyModelBot)  
> Branche de développement : `master`  
> Statut : architecture de base présente ; la généralisation du pilotage distant à plusieurs applications reste à construire et à valider.

## 1. Résumé exécutif

**AnyModelBot est conçu comme un agent informatique autonome qui peut comprendre une consigne, utiliser les applications accessibles sur un ordinateur autorisé, effectuer une suite d'actions, observer les résultats et rendre compte du travail réalisé.**

L'objectif n'est pas de créer un simple chatbot, un macro-enregistreur ou un outil limité à un site web. L'objectif est de fournir un opérateur logiciel généraliste, capable d'interagir avec un poste de travail réel : navigateur, applications graphiques et outils de productivité, dans les limites des permissions accordées par le propriétaire.

Le système doit pouvoir fonctionner localement, tout en offrant la possibilité de le piloter depuis une interface distante. Le poste de l'utilisateur reste le lieu d'exécution : les applications, les sessions ouvertes, les fichiers et les décisions de sécurité restent sous le contrôle de la machine locale.

### Principe directeur

- **Généraliste dans sa mission :** le produit n'est pas défini par une application cible.
- **Local dans son exécution :** les interactions avec l'ordinateur sont réalisées par le logiciel installé sur le poste.
- **Pilotable à distance :** un Control Plane peut transmettre des tâches et afficher leur état.
- **Contrôlé par l'utilisateur :** les opérations sensibles doivent être soumises à des règles et validations explicites.
- **Vérifiable :** une tâche n'est pas considérée comme réussie uniquement parce que l'agent affirme l'avoir terminée ; le résultat doit être observé et documenté.

## 2. Vision, objectifs et non-objectifs

### Objectifs

1. Recevoir une instruction en langage naturel.
2. Comprendre l'objectif et le transformer en étapes exécutables.
3. Choisir les capacités autorisées nécessaires à la tâche.
4. Interagir avec les interfaces graphiques via Computer Use.
5. Observer les changements d'écran et adapter la suite des actions.
6. Gérer les attentes, erreurs, interruptions et demandes d'information.
7. Produire un résultat concret : fichier, modification, opération effectuée ou rapport.
8. Vérifier autant que possible le résultat avant de déclarer la tâche terminée.
9. Conserver un historique compréhensible des tâches et de leurs décisions.
10. Permettre le pilotage depuis le poste local et, lorsque le Control Plane est configuré, depuis une interface distante.

### Ce que le projet ne doit pas devenir

- Un produit dépendant d'un seul site, navigateur ou service.
- Un système qui exécute aveuglément des commandes distantes sur l'ordinateur.
- Un mécanisme de contournement des protections, authentifications ou permissions des applications.
- Un outil qui change de compte, lit des secrets ou réalise des paiements/publications sans autorisation.
- Un agent qui annonce un succès sans preuve observable.
- Un projet qui développe simultanément des fonctionnalités périphériques avant d'avoir stabilisé le cœur du pilotage informatique.

## 3. Périmètre fonctionnel

Le produit doit être organisé en deux niveaux distincts.

### A. Le moteur généraliste

Il fournit les capacités communes à toutes les applications :

- recevoir et suivre une tâche ;
- maintenir le contexte d'exécution ;
- observer l'interface et les fenêtres accessibles ;
- cliquer, saisir du texte, utiliser le clavier, faire défiler ou manipuler les éléments d'interface ;
- attendre et vérifier l'évolution de l'interface ;
- demander une précision ou une approbation ;
- gérer les erreurs et les reprises ;
- conserver les résultats et produire un rapport ;
- appliquer les règles de sécurité et les limites de la tâche.

Ces capacités ne doivent pas contenir de logique métier propre à un service particulier.

### B. Les adaptateurs et workflows propres aux applications

Un adaptateur décrit comment accomplir une famille de tâches dans une application donnée. Il utilise le moteur généraliste sans le remplacer.

Exemples futurs possibles : navigateur web, outil de gestion, logiciel bureautique, application de création graphique, environnement de développement ou outil de production média.

Un adaptateur peut préciser les écrans attendus, les étapes métier, les éléments à vérifier et les erreurs connues. Il ne doit pas obtenir de privilèges qui lui permettraient de contourner les validations du moteur.

**Une application particulière constitue donc un scénario de test ou une intégration, jamais la définition du produit.**

## 4. Architecture générale

L'architecture existante comporte un côté local et un côté distant facultatif.

```text
                 UTILISATEUR
                     |
          +----------+-----------+
          |                      |
    Interface locale       Dashboard distant
          |                      |
          v                      v
   Application AnyModelBot   Control Plane
          |                  HTTP / WebSocket
          |                      ^
          v                      |
   Runtime agent / DSH           | WSS sortant
          |                      |
          +--> TaskService       |
          |                      |
          +--> Computer Use      |
          |                      |
          +--> ApprovalCenter    |
          |                      |
          v                      |
   Applications du poste         |
   (navigateur, logiciels...)    |
          |                      |
          v                      |
   Résultats / workspace         |
          |                      |
          +--> rapport + état ---+
```

Le Control Plane est facultatif pour un usage uniquement local. Lorsqu'il est utilisé, le poste établit une connexion WebSocket sortante vers le serveur. Le serveur orchestre les tâches et conserve leur état ; il ne devient pas un terminal distant généraliste.

### 4.1 Application AnyModelBot / Electron

C'est le logiciel installé sur l'ordinateur. Il fournit l'interface locale, la gestion des bots, les paramètres, les conversations, les espaces de travail et le démarrage des services nécessaires.

Le projet amont propose également des modes CLI et Docker. Le pilotage d'un véritable bureau graphique dépend toutefois d'une session utilisateur interactive et des capacités disponibles sur le système.

### 4.2 Runtime agent / DSH

Le runtime agent reçoit les instructions et utilise le modèle configuré pour raisonner sur la tâche et sélectionner les outils autorisés.

Il gère le contexte de conversation, les appels d'outils et les échanges avec l'utilisateur. Le modèle est le composant de raisonnement ; il ne doit pas être confondu avec le mécanisme qui effectue réellement les clics et saisies.

### 4.3 Computer Use / CUA Driver

Computer Use est la couche d'interaction avec l'interface graphique. Dans le dépôt, le CUA Driver est intégré comme backend de pilotage. Il expose des opérations de lecture de fenêtre et d'écran, ainsi que des actions d'interface telles que cliquer, saisir, appuyer sur des touches, faire défiler ou déplacer.

Le backend et les permissions disponibles dépendent du système d'exploitation. Sur macOS, par exemple, l'application peut nécessiter les autorisations d'accessibilité et d'enregistrement de l'écran. Sur Windows, le pilotage doit se dérouler dans une session de bureau interactive. Sur Linux, les possibilités dépendent notamment de X11, Wayland et des composants d'accessibilité.

Computer Use agit sur l'interface visible. Il ne doit pas être remplacé par des appels privés, du débogage navigateur, des scripts injectés ou des API non prévues pour contourner les contrôles.

### 4.4 ApprovalCenter

ApprovalCenter est le point de contrôle local des décisions nécessitant l'utilisateur. Il doit être l'autorité finale pour les actions soumises à approbation.

Le Control Plane peut présenter une demande et transmettre une décision, mais cette décision doit être revalidée par le composant local. Une réponse à une question de clarification ne vaut pas approbation d'une action sensible.

### 4.5 TaskService

TaskService gère l'exécution durable des tâches en arrière-plan : création, états, progression, reprise et résultats. Le nœud distant transforme une demande reçue en tâche locale plutôt que d'exécuter lui-même une commande arbitraire.

Les états de tâche comprennent notamment les états d'attente, d'exécution, de besoin d'intervention et les états terminaux : réussite, échec, annulation, rejet ou interruption.

### 4.6 Local Execution Node

Le service `src/execution-node/service.ts` joue le rôle de client local entre l'application installée et le Control Plane.

Il utilise une identité locale persistante, s'authentifie auprès du serveur, envoie des heartbeats, reçoit les tâches prises en charge et relaie les changements d'état, les demandes d'approbation, les questions et les métadonnées des livrables.

La connexion est initiée depuis le poste vers le serveur. Le nœud ne doit pas accepter de commandes shell arbitraires ni de chemins de fichiers fournis à distance.

### 4.7 Control Plane et dashboard

Le serveur `control-plane/server.mjs` expose les endpoints HTTP et WebSocket, authentifie les administrateurs et les nœuds, stocke les informations dans SQLite et distribue les tâches.

Le dashboard de `control-plane/public/` sert à :

- consulter les postes connectés et leur état ;
- envoyer et suivre les tâches prises en charge ;
- consulter les comptes rendus et les métadonnées de fichiers ;
- traiter les demandes d'approbation et les questions ;
- mettre un poste en pause, le reprendre ou le révoquer ;
- consulter l'historique utile au diagnostic.

Le serveur ne doit pas recevoir les cookies du navigateur, les profils complets, les clés locales ou un accès général au système de fichiers.

### 4.8 Stockage local et résultats

AnyModelBot utilise SQLite pour ses données applicatives. Le nœud conserve notamment son identité et les associations entre tâches distantes et tâches locales.

Les résultats de tâche doivent être enregistrés dans un espace de travail autorisé. Le manifeste distant actuel peut transmettre des métadonnées telles que le chemin relatif, la taille et le type du fichier. **Ces métadonnées ne signifient pas que le contenu du fichier est transféré au dashboard.**

## 5. Déroulement d'une tâche

Voici le cycle cible d'une tâche générique.

1. **Réception :** l'utilisateur formule un objectif depuis l'interface locale ou le dashboard distant.
2. **Validation :** le système vérifie que la tâche est prise en charge, que le poste est disponible et que le bot possède la configuration requise.
3. **Planification :** le runtime transforme l'objectif en étapes adaptées aux capacités autorisées.
4. **Exécution locale :** TaskService crée ou reprend une tâche sur le poste. L'agent utilise Computer Use pour interagir avec l'application.
5. **Observation :** après une action importante, l'agent observe l'interface pour confirmer l'effet attendu.
6. **Décision :** si une information manque, il pose une question ; si une opération exige une validation, il suspend le flux et demande l'approbation correspondante.
7. **Gestion d'erreur :** si l'écran, l'application ou le réseau ne se comporte pas comme prévu, il tente uniquement les reprises sûres prévues ; sinon il s'arrête et explique le blocage.
8. **Vérification :** il contrôle les éléments réellement observables du résultat : état de l'interface, existence d'un fichier, ouverture ou lecture du livrable, selon la tâche.
9. **Rapport :** il transmet le statut, le résumé, les éventuelles limites et les métadonnées des livrables.
10. **Clôture :** la tâche devient terminale. Une annulation tardive ou un message dupliqué ne doit pas écraser un résultat terminal déjà confirmé.

### Schéma simplifié

```text
Instruction
    |
    v
Validation des règles et capacités
    |
    v
Création de la tâche locale
    |
    v
Planifier -> Observer -> Agir
                 ^        |
                 |        v
                 +---- Vérifier
                          |
              +-----------+-----------+
              |                       |
          Résultat attendu       Blocage / risque
              |                       |
              v                       v
       Vérification finale      Question / approbation
              |                       |
              v                       v
           Rapport             Reprise autorisée ou arrêt
```

## 6. Sécurité et contrôle utilisateur

La sécurité est une propriété de l'architecture, pas seulement une consigne écrite dans le prompt.

### Principes obligatoires

- **Moindre privilège :** le bot utilise le niveau de permission minimal nécessaire.
- **Exécution locale :** les actions de bureau sont réalisées sur le poste appairé.
- **Connexion sécurisée :** WSS est exigé pour les connexions distantes hors boucle locale.
- **Authentification distincte :** les jetons administrateur et nœud sont séparés.
- **Pas de terminal distant générique :** une tâche distante ne doit pas devenir une commande shell.
- **Pas de chemins arbitraires :** les chemins des livrables sont vérifiés et limités à l'espace de travail.
- **Décisions locales :** les approbations sont revalidées sur le poste.
- **Idempotence :** la redélivrance d'une tâche ne doit pas provoquer une seconde exécution involontaire.
- **États terminaux protégés :** les événements tardifs ne doivent pas transformer une tâche terminée.
- **Révocation :** un poste révoqué doit cesser d'accepter les tâches distantes et ne pas se reconnecter sans nouvel appairage local.

### Actions qui doivent demander une décision explicite

Selon la tâche et la politique configurée, les opérations externes ou à conséquence importante doivent faire l'objet d'une validation précise : publication, partage, envoi, achat, dépense de crédits, changement de compte ou de paramètres, suppression et opérations irréversibles.

L'approbation doit décrire l'action exacte. Une approbation générale donnée au début d'une tâche ne doit pas être interprétée comme une autorisation illimitée.

### Limite importante de l'implémentation actuelle

Le transport distant existe, mais son contrat de tâche et sa politique sont encore spécifiques à un seul type de tâche. Le protocole documenté accepte actuellement `kind: "flowauto"`, et le garde-fou de session est adapté à ce scénario.

Cela signifie que **le pilotage distant multi-applications n'est pas encore implémenté**. La présence de Computer Use dans l'application locale ne prouve pas que le Control Plane peut déjà lancer n'importe quel workflow sur n'importe quelle application.

## 7. État du projet : existant et à construire

Cette section évite de confondre code présent, tests automatisés et validation sur un ordinateur réel.

| Domaine | État connu dans le dépôt | Travail restant |
|---|---|---|
| Application AnyModelBot et runtime agent | Socle applicatif existant | Maintenir la stabilité et documenter les prérequis du poste cible |
| Computer Use local | Intégration existante avec CUA Driver | Valider les permissions et les interactions réelles sur chaque OS cible |
| TaskService | Gestion durable des tâches existante | Définir le contrat générique de tâche et ses états pour les workflows multi-applications |
| Local Execution Node | Client WSS sortant, heartbeat, reconnexion et cycle de vie existants | Découpler le nœud des règles propres au workflow actuel |
| Control Plane | Serveur, SQLite, authentification, dashboard et transport de tâches existants | Étendre le modèle de tâche sans créer un accès distant arbitraire |
| Approbations et questions | Relais distant et revalidation locale existants pour le parcours pris en charge | Généraliser les types de demandes et prouver les cas limites |
| Métadonnées des livrables | Manifeste avec chemins relatifs, taille et type | Concevoir un transfert/aperçu authentifié si nécessaire |
| Observation visuelle distante | Capture utilisée localement par Computer Use | Le streaming d'écran vers le dashboard n'est pas présent |
| Adaptateurs multi-applications | Non généralisés dans le protocole distant actuel | Définir une interface d'adaptateur et ajouter des scénarios génériques |
| Validation réelle de bout en bout | Non démontrée par les seuls tests du protocole | Réaliser des tests sur un poste physique et conserver les preuves |
| CI globale | Le dernier état de référence documenté signalait un échec de typecheck/build | Corriger puis obtenir un workflow complet vert |

### À propos des tests

Un test unitaire ou un test de protocole peut prouver qu'un message est validé, stocké ou relayé correctement. Il ne prouve pas qu'un agent sait accomplir une tâche réelle dans une application graphique.

Les validations doivent donc être séparées :

- tests unitaires et d'intégration ;
- typecheck et build ;
- tests du Control Plane et du protocole ;
- tests sur le système d'exploitation cible ;
- tests de workflows réels dans les applications ;
- vérification indépendante des résultats produits.

## 8. Architecture cible à faire évoluer

La généralisation doit se faire par séparation des responsabilités, pas par ajout d'exceptions dans le code existant.

### 8.1 Contrat de tâche générique

Remplacer progressivement le type de tâche unique par un contrat explicite comprenant, au minimum :

- identifiant de tâche et identifiant de corrélation ;
- objectif utilisateur et paramètres structurés ;
- catégorie de workflow ou adaptateur demandé ;
- capacités autorisées pour cette tâche ;
- limites de durée, de coût et de ressources ;
- espace de travail attribué ;
- politique d'approbation ;
- état, progression, questions, erreurs et résultats ;
- références aux livrables vérifiés.

Le serveur doit valider ce contrat et rejeter les champs inconnus ou dangereux. Le poste doit refaire ses propres validations avant l'exécution.

### 8.2 Registre de capacités

Le runtime ne doit pas disposer implicitement de tous les pouvoirs de l'ordinateur. Il doit recevoir une liste explicite de capacités disponibles pour la tâche : observation d'écran, interaction graphique, navigation dans une application autorisée, accès limité à un workspace ou autres capacités validées.

Chaque capacité doit avoir :
- un identifiant stable ;
- une description ;
- des préconditions ;
- un niveau de risque ;
- une règle d'approbation ;
- des limites et des tests dédiés.

### 8.3 Adaptateurs d'applications

Un adaptateur doit fournir des workflows et des vérifications spécifiques à une application, en s'appuyant sur le même moteur Computer Use et le même système de sécurité.

L'absence d'adaptateur ne doit pas empêcher le moteur de rester utilisable pour des interactions graphiques génériques autorisées. En revanche, le système doit annoncer clairement les limites lorsqu'il ne dispose pas d'une procédure fiable pour une tâche métier.

### 8.4 Résultats et preuve

Un rapport de tâche devrait distinguer :
- action tentée ;
- action confirmée par l'interface ;
- fichier créé ou modifié ;
- livrable ouvert ou inspecté ;
- contrôle qualité réellement effectué ;
- point non vérifié ou intervention humaine requise.

Le mot « terminé » doit correspondre à un critère de réussite défini, pas à une simple fin de génération du modèle.

## 9. Feuille de route priorisée

L'ordre ci-dessous protège le projet contre la dispersion.

### P0 — Stabiliser la base

1. Réparer les erreurs de syntaxe/typecheck/build signalées par la CI.
2. Faire passer les tests unitaires, tests Control Plane, build et vérifications documentaires.
3. Vérifier qu'aucune correction de stabilité ne dégrade le nœud local, les approbations ou les états de tâche.

**Preuve :** lien du workflow CI complet réussi et commit associé.

### P0 — Prouver le fonctionnement local

1. Installer et démarrer l'application sur le système d'exploitation réellement utilisé.
2. Vérifier Computer Use avec les permissions OS nécessaires.
3. Exécuter un scénario graphique simple et non sensible.
4. Vérifier que l'agent observe correctement le résultat et sait s'arrêter en cas d'incertitude.

**Preuve :** rapport de test reproductible avec OS, version, permissions, étapes et résultat observé.

### P0 — Généraliser le moteur de tâches distantes

1. Séparer le protocole générique du type de tâche actuellement spécialisé.
2. Introduire un contrat de tâche versionné et validé côté serveur et côté poste.
3. Définir le registre de capacités et les politiques de risque.
4. Conserver l'exécution locale, les validations et les limites de workspace.
5. Ajouter des tests de tâches invalides, rejouées, interrompues, révoquées et concurrentes.

**Preuve :** tests d'intégration démontrant au moins deux types de workflows distincts sans introduire de shell distant arbitraire.

### P0 — Fiabiliser le cycle distant

1. Valider appairage, heartbeat, reconnexion et révocation.
2. Valider soumission, acceptation, progression, annulation et états terminaux.
3. Valider questions et approbations, y compris hors ligne, expirées ou dupliquées.
4. Vérifier la cohérence entre TaskService local et dashboard.

**Preuve :** tests automatisés et scénarios de panne documentés.

### P1 — Premier workflow générique multi-applications

1. Définir l'interface des adaptateurs.
2. Construire un premier workflow dans une application de test non sensible.
3. Construire un second workflow distinct pour prouver que le moteur n'est pas lié au premier.
4. Mesurer les taux de réussite, les erreurs, les reprises et les interventions humaines.

**Preuve :** deux workflows reproductibles, avec résultats observés et compte rendu fidèle.

### P1 — Améliorer l'observation et les livrables

1. Déterminer si les captures ponctuelles suffisent ou si un aperçu/streaming est réellement nécessaire.
2. Concevoir le transfert des livrables avec authentification, limites de taille et contrôle d'accès.
3. Vérifier les fichiers sans sortir du workspace.
4. Séparer métadonnées, contenu transféré et preuve de contrôle qualité.

**Preuve :** téléchargement/aperçu sûr testé et traçabilité de chaque livrable.

### P2 — Ajouter des intégrations applicatives

Ajouter les applications selon la valeur réelle et la fiabilité démontrée. Chaque intégration doit rester un adaptateur du moteur commun, avec tests et validations propres.

Les outils de production média, dont FlowAuto si ce besoin est retenu, peuvent être ajoutés comme intégrations parmi d'autres. Une intégration ne doit pas modifier la mission générale du produit.

### P2 — Publication et opérations externes

La publication, l'envoi ou toute action publique ne doit être envisagée qu'après la fiabilité de la génération et de la vérification. Chaque action externe doit demander une approbation explicite portant sur le contenu, la destination et le compte concernés.

### P3 — Packaging et exploitation avancée

Améliorer l'installation, la mise à jour, les diagnostics, la supervision, les sauvegardes, la documentation et le support multi-OS après stabilisation du cœur fonctionnel.

## 10. Règles de développement

Tout contributeur ou agent de développement doit respecter les règles suivantes :

1. Lire ce document et les documents techniques liés avant de modifier l'architecture.
2. Travailler sur `master`, conformément aux consignes du dépôt.
3. Ne pas développer de fonctionnalités PIO tant que cette piste reste explicitement exclue.
4. Garder le module Agency gelé fonctionnellement ; seules les corrections nécessaires à la stabilité et à la CI sont autorisées.
5. Ne pas modifier le dépôt, le code ou l'extension d'une application externe utilisée comme scénario de test.
6. Ne pas contourner Computer Use avec shell, scripts, CDP, API privées, extension ou appels réseau non autorisés.
7. Ne jamais présenter une fonctionnalité comme terminée sur la seule base de son implémentation.
8. Regrouper les changements en lots cohérents plutôt qu'en une succession de micro-commits.
9. Après chaque lot, indiquer les fichiers modifiés, les commandes de test exécutées, les résultats exacts et le commit.
10. Si un test n'a pas été exécuté, le dire explicitement.

## 11. Critères de réussite du produit

AnyModelBot pourra être considéré comme un opérateur informatique généraliste validé lorsque les preuves suivantes seront réunies :

- l'application s'installe et fonctionne sur les systèmes officiellement ciblés ;
- l'agent contrôle localement plusieurs applications graphiques autorisées ;
- les workflows ne dépendent pas d'un adaptateur unique ;
- le pilotage distant transmet des tâches génériques validées et non des commandes arbitraires ;
- le poste local conserve l'autorité sur les permissions et approbations ;
- les tâches survivent correctement aux pertes réseau et redémarrages prévus ;
- les erreurs, refus et interventions nécessaires sont visibles ;
- les résultats sont vérifiés selon des critères explicites ;
- les livrables sont accessibles sans ouvrir un accès général au système de fichiers ;
- la CI et les tests de sécurité sont verts ;
- les démonstrations sur machine réelle sont reproductibles et documentées.

## 12. Glossaire

| Terme | Définition |
|---|---|
| Agent | Composant qui interprète l'objectif, raisonne et choisit les outils autorisés |
| Runtime / DSH | Environnement qui exécute les tours de l'agent et orchestre les outils |
| Computer Use | Capacité d'observer et de manipuler une interface graphique |
| CUA Driver | Backend technique de pilotage de l'ordinateur |
| TaskService | Service local qui gère le cycle de vie durable des tâches |
| ApprovalCenter | Composant local qui gère les validations et demandes d'intervention |
| Execution Node | Client installé sur le poste, relié au Control Plane |
| Control Plane | Serveur qui orchestre les postes et les tâches distantes |
| Dashboard | Interface distante de supervision et de pilotage |
| Adaptateur | Couche spécifique à une application ou à un workflow métier |
| Workspace | Espace de fichiers attribué et autorisé pour une tâche |
| Livrable | Fichier ou résultat concret produit par une tâche |
| Preuve | Observation ou test qui justifie l'état annoncé d'une tâche |

## 13. Documents techniques complémentaires

- [Feuille de route de développement](./roadmap-local-workstation-operator.md)
- [Documentation du Local Execution Node](./execution-node.md)
- [Limites de sécurité du nœud](./execution-node-security.md)
- [Guide de développement du dépôt](./development.md)
- [Code du Local Execution Node](../src/execution-node/service.ts)
- [Serveur Control Plane](../control-plane/server.mjs)

---

**Règle de référence :** AnyModelBot est le moteur généraliste de pilotage informatique. Les applications qu'il contrôle sont des environnements d'exécution ou des intégrations interchangeables, pas la raison d'être du produit.
