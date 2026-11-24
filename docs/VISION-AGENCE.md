# AnyModelBot --- Vision produit et cahier des charges de référence

> **Objectif :** construire un système d'intelligence artificielle
> capable d'agir comme une agence informatique commerciale et technique
> : trouver des prospects, les convertir en clients, contractualiser des
> prestations, puis piloter leur réalisation jusqu'à la livraison.

**Statut du document :** consolidation de la vision exprimée dans les
échanges.  
**Important :** ce document décrit la cible fonctionnelle. Il ne
certifie pas que les fonctionnalités sont déjà implémentées dans le
dépôt.

------------------------------------------------------------------------

## 1. Vision et mission

AnyModelBot ne doit pas être réduit à un outil de pilotage d'ordinateur,
d'exécution de commandes ou d'automatisation d'une application
particulière.

La vision est de créer une **agence informatique autonome assistée par
plusieurs agents IA**, capable de transformer :

1.  une entreprise identifiée en prospect qualifié ;
2.  un prospect en conversation commerciale ;
3.  une conversation en opportunité ;
4.  une opportunité en proposition, devis et contrat ;
5.  un contrat validé en projet de développement ;
6.  un projet en produit testé, livré et suivi.

Le système doit pouvoir vendre et réaliser notamment :

-   des sites vitrines ;
-   des boutiques e-commerce ;
-   des applications web ;
-   des applications mobiles ;
-   des plateformes métier ;
-   des logiciels et outils internes ;
-   des automatisations et intégrations ;
-   des prestations de maintenance et d'évolution.

La finalité est commerciale et opérationnelle : **acquérir des clients,
générer du chiffre d'affaires et livrer un travail de qualité.**

## 2. Périmètre fonctionnel global

Le système comporte trois grands moteurs complémentaires.

### 2.1 Business Engine --- moteur commercial

Responsable de la recherche de prospects, de leur qualification, de la
prospection, des conversations, de la vente, des devis, des négociations
et du suivi des contrats.

### 2.2 AI Orchestration Engine --- moteur d'orchestration IA

Responsable de la coordination des agents, de la distribution des
missions, de la mémoire, du choix des modèles IA, de la supervision, de
la gestion des erreurs et de la traçabilité.

### 2.3 Execution Engine --- moteur d'exécution

Responsable de l'utilisation des outils locaux, des IDE, des assistants
de programmation, des environnements de développement, des tests, du
contrôle qualité et de la livraison.

Ces trois moteurs doivent fonctionner ensemble. Le moteur commercial ne
doit pas être oublié au profit du seul contrôle informatique.

------------------------------------------------------------------------

## 3. Recherche et prospection de clients

### 3.1 Types de prospects

Le système doit rechercher des entreprises, commerçants, entrepreneurs,
associations et organisations susceptibles d'avoir besoin de services
numériques.

Exemples :

-   entreprises sans site Internet ;
-   entreprises disposant d'un site obsolète ou peu fonctionnel ;
-   commerçants souhaitant vendre en ligne ;
-   entrepreneurs ayant une idée de produit numérique ;
-   organisations ayant besoin d'une plateforme métier ;
-   entreprises souhaitant automatiser leurs opérations ;
-   entreprises ayant besoin de maintenance, de refonte ou d'évolution.

### 3.2 Capacités de recherche

Le système doit pouvoir :

-   effectuer des recherches sur Internet ;
-   rechercher des entreprises par secteur, zone géographique et type de
    besoin ;
-   consulter les sites web et les pages professionnelles accessibles ;
-   analyser leur présence numérique ;
-   repérer des problèmes et des opportunités commerciales ;
-   rechercher les coordonnées professionnelles publiquement disponibles ;
-   identifier, lorsque c'est possible, les décideurs ou interlocuteurs
    pertinents ;
-   détecter les besoins probables sans les présenter comme des
    certitudes ;
-   enregistrer les sources et les éléments justifiant chaque
    opportunité.

### 3.3 Qualification et scoring

Chaque prospect doit être évalué selon des critères configurables, par
exemple :

-   adéquation avec les services proposés ;
-   besoin numérique identifié ;
-   capacité ou potentiel budgétaire estimé ;
-   accessibilité du décideur ;
-   urgence apparente ;
-   qualité et fiabilité des coordonnées ;
-   probabilité de réponse ;
-   valeur commerciale potentielle.

Le système doit distinguer les faits observés, les hypothèses et les
informations inconnues.

### 3.4 Gestion des prospects

Le système doit conserver au minimum :

-   nom de l'entreprise ;
-   secteur d'activité ;
-   localisation ;
-   site et profils professionnels ;
-   coordonnées et source ;
-   interlocuteur identifié, si disponible ;
-   problème ou opportunité détecté ;
-   score et justification ;
-   historique des recherches ;
-   statut commercial ;
-   prochaine action ;
-   historique des interactions.

Il doit détecter les doublons et éviter les contacts répétés de manière
inappropriée.

**Résultat attendu :** une base de prospects qualifiés, documentés et
priorisés, avec une raison concrète de les contacter.

------------------------------------------------------------------------

## 4. Prise de contact et conversations commerciales

Le système ne doit pas se limiter à produire des listes de prospects. Il
doit pouvoir engager et suivre de véritables conversations commerciales
sur les canaux autorisés et techniquement intégrés.

Canaux possibles, selon les intégrations disponibles :

-   e-mail ;
-   formulaires de contact des sites ;
-   réseaux sociaux ;
-   messageries professionnelles ;
-   autres canaux compatibles.

Capacités attendues :

-   rédiger des messages personnalisés à partir des informations
    vérifiées ;
-   adapter le ton et l'argumentaire au secteur et au contexte ;
-   présenter les services de l'agence ;
-   envoyer un premier message lorsque l'autorisation et l'intégration
    le permettent ;
-   recevoir et comprendre les réponses ;
-   conserver le contexte des échanges ;
-   répondre aux questions ;
-   traiter les objections ;
-   relancer de manière pertinente et espacée ;
-   reconnaître un refus et arrêter les relances ;
-   détecter l'intérêt, l'urgence et les prochaines étapes ;
-   transférer une conversation à un humain lorsque nécessaire.

Le système doit respecter les règles applicables aux communications
commerciales, les conditions d'utilisation des plateformes, les
préférences des destinataires et les mécanismes de désinscription.

------------------------------------------------------------------------

## 5. Compréhension des besoins et qualification commerciale

Lorsqu'un prospect manifeste de l'intérêt, le système doit se comporter
comme un commercial et un consultant expérimenté.

Il doit :

1.  comprendre le problème métier du client ;
2.  poser des questions pertinentes ;
3.  identifier les utilisateurs concernés ;
4.  déterminer le type de solution nécessaire ;
5.  recueillir les fonctionnalités attendues ;
6.  distinguer les besoins indispensables des options ;
7.  comprendre les contraintes techniques et opérationnelles ;
8.  identifier les délais souhaités ;
9.  demander ou estimer le budget avec prudence ;
10. reformuler le besoin pour validation du client ;
11. proposer une solution adaptée.

Le système ne doit pas proposer la même offre à tous les prospects. La
solution doit découler du besoin réel.

Il doit produire une fiche de qualification structurée comprenant les
besoins, contraintes, hypothèses, inconnues, risques et prochaines
étapes.

------------------------------------------------------------------------

## 6. Tarification, devis et négociation

La tarification et la négociation constituent une fonction centrale.

### 6.1 Catalogue de prestations

Le système doit disposer d'un catalogue administrable comprenant :

-   prestations proposées ;
-   descriptions ;
-   périmètres habituels ;
-   options ;
-   délais indicatifs ;
-   fourchettes de prix ;
-   coûts estimés ;
-   conditions de paiement ;
-   éléments non inclus ;
-   conditions de maintenance.

### 6.2 Estimation

Pour chaque demande, le système doit :

-   décomposer le projet en fonctionnalités et lots ;
-   estimer la complexité ;
-   identifier les compétences et ressources nécessaires ;
-   estimer le temps de réalisation ;
-   estimer les coûts directs et indirects ;
-   calculer une marge prévisionnelle ;
-   tenir compte des risques et des incertitudes ;
-   présenter une fourchette lorsque le périmètre est encore incomplet.

### 6.3 Proposition commerciale

Le système peut préparer plusieurs niveaux d'offre, par exemple :

-   offre essentielle ;
-   offre standard ;
-   offre avancée.

Chaque proposition doit expliquer clairement le périmètre, les
livrables, les délais, les exclusions, les conditions et le prix.

### 6.4 Négociation encadrée

Le système doit pouvoir :

-   répondre aux demandes de réduction ;
-   expliquer la valeur de la prestation ;
-   proposer une réduction du périmètre plutôt qu'une remise excessive ;
-   proposer des options ou phases ;
-   discuter d'un échéancier ;
-   adapter l'offre au budget disponible ;
-   respecter un prix plancher et une marge minimale ;
-   demander une validation humaine lorsqu'une demande dépasse ses
    limites.

Les règles commerciales doivent être configurables : prix plancher,
marge minimale, remises maximales, modalités de paiement et conditions
exceptionnelles.

Le système ne doit jamais inventer un coût, promettre un délai non
vérifié ou accepter un engagement en dehors de ses autorisations.

------------------------------------------------------------------------

## 7. Devis, contrats et conclusion de vente

Le système doit accompagner la vente jusqu'à la conclusion
contractuelle.

Fonctions attendues :

-   génération de propositions commerciales ;
-   génération de devis ;
-   description du périmètre ;
-   définition des livrables ;
-   définition des délais et jalons ;
-   conditions de paiement ;
-   gestion des acomptes ;
-   préparation des contrats ;
-   suivi des versions et modifications ;
-   transmission au client ;
-   suivi de validation et de signature ;
-   suivi des paiements ;
-   passage du dossier commercial au dossier de production.

La signature juridiquement engageante, l'acceptation définitive d'un
contrat, l'encaissement et les opérations financières doivent respecter
les autorisations explicites définies par le propriétaire du système.

**Résultat attendu :** un client converti, un besoin validé, un
périmètre défini et un contrat conclu.

------------------------------------------------------------------------

## 8. Passage du commercial au projet

Après validation du client, le système doit transformer le dossier
commercial en dossier de production sans perdre les informations.

Il doit récupérer et organiser :

-   le besoin initial ;
-   les échanges utiles ;
-   le cahier des charges ;
-   les fonctionnalités validées ;
-   les utilisateurs et rôles ;
-   les parcours utilisateurs ;
-   les contenus fournis ;
-   l'identité visuelle ;
-   les références de design ;
-   les technologies et contraintes ;
-   les intégrations nécessaires ;
-   les accès fournis de manière sécurisée ;
-   les délais ;
-   le budget ;
-   les conditions contractuelles ;
-   les critères d'acceptation.

Les secrets, mots de passe, clés API et données sensibles doivent être
gérés dans un mécanisme sécurisé, et non copiés librement dans les
conversations ou les journaux.

Le système doit produire des spécifications exploitables par les agents
de projet et de développement. Les ambiguïtés importantes doivent être
clarifiées avant de commencer les travaux concernés.

------------------------------------------------------------------------

## 9. Gestion de projet

Un agent chef de projet doit transformer le contrat et les
spécifications en plan de réalisation.

Il doit :

-   découper le projet en lots ;
-   définir les dépendances ;
-   établir les critères d'acceptation ;
-   attribuer les tâches aux agents appropriés ;
-   suivre l'avancement ;
-   détecter les blocages ;
-   gérer les changements de périmètre ;
-   informer le client aux étapes convenues ;
-   conserver les décisions et validations ;
-   vérifier que le travail réalisé correspond au contrat.

Toute demande supplémentaire du client doit être évaluée comme un
changement de périmètre, avec estimation de son impact sur le prix et le
délai.

------------------------------------------------------------------------

## 10. Développement avec les outils disponibles sur l'ordinateur

L'objectif est de réutiliser les outils de développement déjà
disponibles plutôt que de recréer inutilement des moteurs de
programmation.

Le système doit pouvoir, selon les outils installés et les permissions
accordées :

-   ouvrir et gérer des projets ;
-   utiliser les IDE installés ;
-   lancer Claude Code et Codex via les interfaces prises en charge ;
-   créer et organiser des fichiers ;
-   lire, écrire et modifier du code ;
-   exécuter des commandes ;
-   installer des dépendances ;
-   lancer des serveurs de développement ;
-   exécuter des scripts ;
-   lancer les tests ;
-   analyser les erreurs ;
-   corriger les problèmes ;
-   vérifier les résultats ;
-   produire des livrables techniques.

Lorsque des interfaces CLI fiables et autorisées existent, elles sont
généralement préférables à une automatisation graphique fragile. Le
pilotage de l'interface reste utile pour les opérations qui nécessitent
réellement une interaction visuelle.

Le système doit travailler dans des espaces autorisés et isolés, avec
contrôle des accès et traçabilité des modifications.

------------------------------------------------------------------------

## 11. Contrôle qualité et validation

La génération de code ne constitue pas une preuve de réussite.

Le système doit vérifier les livrables à plusieurs niveaux :

### Fonctionnel

-   les fonctionnalités prévues sont présentes ;
-   les parcours utilisateurs fonctionnent ;
-   les règles métier sont respectées ;
-   les critères d'acceptation sont satisfaits.

### Technique

-   compilation et démarrage ;
-   tests automatisés ;
-   erreurs et journaux ;
-   dépendances ;
-   intégrations ;
-   compatibilité des environnements.

### Interface et expérience utilisateur

-   cohérence visuelle ;
-   responsive design ;
-   accessibilité pertinente ;
-   ergonomie ;
-   absence de défauts bloquants.

### Sécurité et fiabilité

-   gestion des permissions ;
-   protection des données ;
-   gestion des secrets ;
-   validation des entrées ;
-   contrôle des accès ;
-   vérifications de sécurité adaptées au projet.

Le système doit pouvoir corriger les problèmes, relancer les tests et
conserver les preuves de validation. Un projet ne doit pas être déclaré
terminé uniquement parce qu'un agent affirme avoir terminé son travail.

------------------------------------------------------------------------

## 12. Livraison et suivi client

Après validation, le système doit :

-   préparer la version finale ;
-   configurer l'environnement de déploiement ;
-   préparer le déploiement ;
-   demander l'autorisation nécessaire pour les opérations sensibles ;
-   déployer sur l'environnement prévu ;
-   vérifier le fonctionnement en production ;
-   préparer la documentation ;
-   transmettre les livrables et accès de manière sécurisée ;
-   accompagner la réception ;
-   suivre les éventuelles réserves ;
-   proposer la maintenance et les évolutions prévues.

La livraison doit être accompagnée d'une preuve : URL, résultat de
tests, documentation, version livrée et validation du client, selon le
type de projet.

------------------------------------------------------------------------

## 13. Fidélisation et développement commercial après livraison

La relation commerciale ne s'arrête pas à la livraison.

Le système doit pouvoir :

-   planifier les suivis ;
-   recueillir les retours ;
-   identifier les besoins de maintenance ;
-   proposer des améliorations pertinentes ;
-   détecter des opportunités de nouveaux projets ;
-   suivre les renouvellements et échéances ;
-   demander des témoignages ou recommandations lorsque cela est
    approprié ;
-   conserver l'historique de la relation client.

------------------------------------------------------------------------

## 14. Architecture multi-agents

La vision implique une organisation d'agents spécialisés coordonnés par
un orchestrateur central.

### 14.1 Orchestrateur central

Responsabilités :

-   recevoir les objectifs ;
-   planifier les missions ;
-   choisir les agents ;
-   distribuer les tâches ;
-   transmettre le contexte utile ;
-   contrôler les permissions ;
-   suivre les résultats ;
-   gérer les erreurs et reprises ;
-   conserver l'historique ;
-   vérifier les critères de réussite ;
-   demander une intervention humaine lorsque nécessaire.

### 14.2 Agents spécialisés envisagés

| Agent | Responsabilité principale |
| :--- | :--- |
| Agent Prospecteur | Recherche d'entreprises et identification d'opportunités |
| Agent Qualification | Analyse et scoring des prospects |
| Agent Commercial | Prise de contact, conversations et relances |
| Agent Consultant | Compréhension des besoins et définition de solutions |
| Agent Devis | Estimation, tarification et préparation des offres |
| Agent Négociation | Gestion des objections et négociation dans les limites fixées |
| Agent Contrats | Préparation et suivi des devis et contrats |
| Agent Chef de projet | Planification, coordination et suivi |
| Agent Architecte | Architecture technique et décisions structurantes |
| Agents Développeurs | Réalisation des sites, applications et intégrations |
| Agent QA | Tests, audits et validation |
| Agent Livraison | Déploiement, documentation et remise des livrables |
| Agent Relation client | Suivi, maintenance et fidélisation |

Cette liste est une proposition de découpage fonctionnel, pas la preuve
que chaque agent existe déjà dans le code.

Un agent peut être une configuration spécialisée d'un même moteur plutôt
qu'un service logiciel indépendant. Le nombre d'agents doit rester
justifié par les besoins réels.

Chaque agent doit avoir :

-   une mission explicite ;
-   des entrées et sorties structurées ;
-   des outils autorisés ;
-   des limites de permission ;
-   un contexte et une mémoire adaptés ;
-   des critères de réussite ;
-   une gestion des erreurs ;
-   une traçabilité des actions.

------------------------------------------------------------------------

## 15. Pilotage de l'ordinateur et Local Node

Une autre demande du projet concerne le pilotage de l'ordinateur
personnel.

Le système doit pouvoir utiliser les applications présentes sur la
machine pour effectuer les tâches autorisées.

Capacités envisagées :

-   naviguer dans les applications ;
-   utiliser Chrome ;
-   gérer des onglets et sites web ;
-   interagir avec les interfaces ;
-   sélectionner un compte lorsque cela est autorisé ;
-   manipuler des fichiers et dossiers ;
-   lancer des logiciels ;
-   exécuter des outils ;
-   surveiller des tâches ;
-   récupérer et transmettre les résultats.

Le pilotage de l'ordinateur est un **moyen d'exécution transversal**, et
non la finalité du produit.

### Séparation possible en deux parties

**Control Plane --- serveur ou application centrale**

-   gestion des agents et missions ;
-   orchestration ;
-   mémoire et historique ;
-   suivi commercial ;
-   gestion des clients et projets ;
-   permissions et validations ;
-   suivi des résultats.

**Local Node --- ordinateur personnel**

-   connexion aux outils locaux ;
-   contrôle de l'interface graphique ;
-   exécution de Claude Code et Codex lorsque possible ;
-   accès aux espaces de travail autorisés ;
-   exécution des tests ;
-   récupération des résultats.

Les deux parties doivent communiquer de manière sécurisée. Il faut
prévoir l'authentification, les permissions, les journaux, les
déconnexions, la reprise des tâches et la révocation d'accès.

Cette séparation est une architecture proposée à valider par l'analyse
du dépôt et des contraintes techniques.

------------------------------------------------------------------------

## 16. Autonomie, permissions et contrôle humain

L'autonomie recherchée ne signifie pas absence de limites.

Le système doit appliquer une politique de permissions explicite.

| Catégorie d'action | Politique souhaitée |
| :--- | :--- |
| Rechercher et analyser des prospects | Automatique |
| Qualifier et prioriser les prospects | Automatique, avec traçabilité |
| Préparer des messages et propositions | Automatique |
| Envoyer des communications | Selon canal, autorisation et règles configurées |
| Répondre et relancer | Automatique dans les limites définies |
| Négocier | Automatique dans les limites de prix et de marge |
| Dépasser les limites commerciales | Validation humaine |
| Accepter juridiquement un contrat | Validation humaine, sauf délégation explicite et juridiquement vérifiée |
| Encaisser, rembourser ou dépenser de l'argent | Autorisation explicite |
| Publier en production | Selon politique de validation |
| Supprimer des données ou ressources sensibles | Confirmation explicite |
| Accéder à des comptes ou secrets | Permissions minimales et gestion sécurisée |

Les actions doivent être classées selon leur risque. Le système doit
pouvoir fonctionner sans intervention permanente pour les tâches
ordinaires, tout en conservant un contrôle sur les engagements
importants.

------------------------------------------------------------------------

## 17. Architecture technique : principes à respecter

L'architecture exacte doit être confirmée par l'audit du dépôt. Les
principes suivants constituent la cible :

-   séparation des responsabilités commerciales, orchestration et
    exécution ;
-   composants modulaires ;
-   contrats d'interface explicites entre agents ;
-   tâches persistantes et reprenables ;
-   mémoire structurée et historique consultable ;
-   journalisation des actions ;
-   gestion des erreurs et des nouvelles tentatives ;
-   contrôle des permissions ;
-   isolation des projets clients ;
-   gestion sécurisée des secrets ;
-   observabilité des agents et des tâches ;
-   possibilité de remplacer un modèle IA ou un outil sans réécrire tout
    le système ;
-   validation des sorties avant les actions sensibles.

Les modèles IA et outils externes doivent être considérés comme des
dépendances remplaçables. Le système ne doit pas dépendre d'un seul
fournisseur lorsque des alternatives raisonnables sont possibles.

------------------------------------------------------------------------

## 18. Éléments explicitement exclus ou à protéger

Les contraintes exprimées dans les discussions doivent être respectées :

-   **PIO est exclu du périmètre actuel.**
-   **FlowAuto ne doit pas être modifié.**
-   AnyModelBot est le projet actif identifié dans les échanges.
-   Les dépôts et applications externes ne doivent pas être modifiés
    sans autorisation.
-   Le développement doit être réalisé dans les espaces de travail
    appropriés.
-   Les outils installés peuvent être utilisés, mais uniquement avec les
    permissions nécessaires.

Le fait qu'un outil puisse techniquement être piloté ne constitue pas
une autorisation de modifier ses données, son code ou ses comptes.

------------------------------------------------------------------------

## 19. Cycle opérationnel complet

Le parcours cible est le suivant :

1.  **Recherche :** trouver des entreprises susceptibles d'avoir besoin
    de services numériques.
2.  **Qualification :** analyser les besoins et identifier les
    opportunités.
3.  **Prospection :** contacter les interlocuteurs pertinents.
4.  **Conversation :** répondre, comprendre et entretenir l'échange.
5.  **Conversion :** traiter les objections et convaincre.
6.  **Commercialisation :** proposer une solution et un prix.
7.  **Négociation :** adapter l'offre dans les limites autorisées.
8.  **Contractualisation :** faire valider le périmètre et conclure le
    contrat.
9.  **Préparation :** collecter les informations et établir les
    spécifications.
10. **Planification :** organiser les lots, tâches et critères
    d'acceptation.
11. **Production :** développer avec les outils et agents disponibles.
12. **Vérification :** tester, corriger et valider.
13. **Livraison :** déployer et transmettre les livrables.
14. **Fidélisation :** suivre le client et identifier les besoins
    futurs.

------------------------------------------------------------------------

## 20. Indicateurs de réussite

Le projet doit être piloté par des résultats mesurables, pas seulement
par le nombre d'agents ou de fonctionnalités développées.

### Indicateurs commerciaux

-   prospects recherchés ;
-   prospects qualifiés ;
-   taux de qualification ;
-   contacts envoyés ;
-   taux de réponse ;
-   conversations engagées ;
-   rendez-vous obtenus ;
-   propositions envoyées ;
-   taux de conversion ;
-   contrats signés ;
-   chiffre d'affaires signé ;
-   encaissements réels ;
-   marge par projet ;
-   coût d'acquisition par client.

### Indicateurs de production

-   projets démarrés ;
-   lots terminés ;
-   taux de réussite des tests ;
-   défauts détectés ;
-   défauts résolus ;
-   respect des délais ;
-   respect du budget ;
-   livraisons acceptées ;
-   temps entre signature et livraison ;
-   marge réelle par projet.

### Indicateurs de fiabilité

-   tâches terminées sans intervention ;
-   tâches échouées ;
-   taux de reprise réussie ;
-   actions bloquées par les permissions ;
-   erreurs d'agents ;
-   interventions humaines nécessaires ;
-   incidents de sécurité.

Les métriques doivent être calculées à partir d'événements et de données
vérifiables. Une activité réalisée n'est pas automatiquement un résultat
commercial.

------------------------------------------------------------------------

## 21. Principes de développement

Le développement doit suivre les principes suivants :

1.  Partir de la vision commerciale complète.
2.  Auditer le dépôt actuel avant de décider quoi réécrire.
3.  Distinguer ce qui existe, ce qui fonctionne, ce qui est incomplet et
    ce qui manque.
4.  Identifier les développements hors cible et leurs conséquences.
5.  Définir une architecture cohérente sans sur-ingénierie.
6.  Construire par lots fonctionnels suffisamment importants pour éviter
    les modifications fragmentées.
7.  Tester chaque lot avec des critères d'acceptation vérifiables.
8.  Utiliser de vrais scénarios commerciaux dès que possible.
9.  Mesurer les résultats avec de vrais prospects et de vrais projets,
    dans un cadre autorisé.
10. Ne pas développer des fonctionnalités secondaires avant d'avoir
    validé le parcours prioritaire.

### Ordre de priorité recommandé

**Priorité 1 --- Boucle commerciale minimale réelle**

-   recherche et qualification de prospects ;
-   CRM et historique ;
-   préparation et gestion des contacts ;
-   conversation et suivi ;
-   qualification du besoin ;
-   devis et règles de tarification ;
-   suivi de conversion.

Objectif : démontrer qu'AnyModelBot peut identifier des prospects
pertinents et contribuer à convertir de vraies opportunités.

**Priorité 2 --- Passage du contrat à la production**

-   dossier projet ;
-   cahier des charges ;
-   planification ;
-   intégration aux outils de développement ;
-   suivi des tâches ;
-   tests et validation.

Objectif : démontrer qu'un projet vendu peut être transformé en livrable
vérifié.

**Priorité 3 --- Automatisation et montée en autonomie**

-   Local Node ;
-   pilotage avancé de l'ordinateur ;
-   orchestration multi-agents approfondie ;
-   reprise automatique ;
-   suivi client ;
-   maintenance et fidélisation.

Objectif : réduire les interventions manuelles sans sacrifier la
fiabilité ni le contrôle.

Cet ordre est une recommandation de pilotage à confronter à l'état réel
du dépôt.

------------------------------------------------------------------------

## 22. État de référence et limites de ce document

Le dépôt identifié dans les discussions comme étant le projet actif est
:

`github.com/Amireflow/AnyModelBot`

La vision décrite ici est une consolidation des objectifs et demandes
formulés dans les échanges. Elle ne constitue pas un audit du code et ne
prouve pas que les fonctionnalités sont implémentées.

Les points suivants restent à vérifier dans le dépôt :

-   architecture et modules réellement présents ;
-   fonctionnalités commerciales existantes ;
-   agents et outils réellement opérationnels ;
-   intégrations disponibles ;
-   état du contrôle local ;
-   sécurité et permissions ;
-   tests et validations ;
-   fonctionnalités hors périmètre ;
-   écarts entre l'implémentation actuelle et la vision cible.

Aucune modification de dépôt n'est autorisée par ce document à elle
seule.

------------------------------------------------------------------------

## 23. Décision de référence

La définition de référence d'AnyModelBot est la suivante :

> **AnyModelBot est une plateforme d'agence informatique autonome
> assistée par des agents IA. Elle recherche et qualifie des prospects,
> engage des conversations commerciales, comprend les besoins, propose
> et négocie des prestations, prépare les devis et contrats, puis
> transforme les projets validés en réalisations techniques testées et
> livrées en utilisant les outils de développement et les ressources
> informatiques autorisés. Elle suit ensuite les clients et recherche
> des opportunités de fidélisation.**

Toute décision d'architecture, tout développement et toute nouvelle
fonctionnalité doivent être évalués à partir de cette mission.

**Règle directrice :** ne pas confondre un moyen technique (contrôle
d'ordinateur, navigateur, IDE ou agent de code) avec le résultat
recherché (clients acquis, contrats conclus et projets livrés).
