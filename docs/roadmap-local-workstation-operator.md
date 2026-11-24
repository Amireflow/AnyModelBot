# Feuille de route — AnyModelBot, opérateur local de poste de travail

> Document de référence pour reprendre le développement. Dernière revue du dépôt : **24 novembre 2026**. Branche : `master`. Commit de référence : `333cabbcce4705378ae63b025edd1027bda8cf98`.

## 1. Mission du projet

Faire évoluer le fork AnyModelBot en un **agent local pilotable à distance**, capable d'exécuter des tâches sur le poste de l'utilisateur tout en conservant l'exécution, les données sensibles et les contrôles de sécurité sur ce poste.

Le premier cas d'usage à terminer est volontairement limité :

1. L'utilisateur envoie une tâche FlowAuto depuis le tableau de bord distant.
2. Le Control Plane transmet la tâche au poste AnyModelBot associé.
3. Le poste local exécute la tâche dans Chrome, via Computer Use et le profil Chrome déjà ouvert.
4. L'agent utilise Google Flow / FlowAuto pour produire une image ou une vidéo.
5. Le résultat est enregistré dans l'espace de travail dédié au bot.
6. L'agent vérifie le résultat dans l'interface, notamment en lisant l'image et en lisant la vidéo finale jusqu'à sa fin.
7. Le poste renvoie l'état, un compte rendu et les métadonnées des fichiers produits.

**MVP visé :** une tâche envoyée à distance peut aller jusqu'à une production média vérifiée localement et rendre un compte rendu fiable, sans intervention technique manuelle pendant le parcours nominal.

### Périmètre et limites à conserver

- Le cas d'usage initial est **FlowAuto / Google Flow**, pas le contrôle général de toutes les applications.
- FlowAuto est une application cible séparée. **Ne pas modifier son dépôt, son extension Chrome ou son code** dans le cadre de ce projet.
- Utiliser uniquement le profil Chrome déjà ouvert. Ne pas changer de compte, se connecter, consulter des identifiants ou contourner un écran d'authentification. En cas de demande de connexion ou de permission, arrêter et demander à l'utilisateur.
- Toutes les actions d'entrée Computer Use (clic, clavier, saisie) restent soumises à l'approbation locale prévue par AnyModelBot.
- Les publications, partages, envois externes, changements de paramètres, dépenses de crédits et suppressions exigent une approbation explicite pour l'action précise.
- Les fichiers produits restent dans l'espace de travail autorisé. Aucun chemin de fichier fourni à distance ne doit devenir une instruction d'accès au système.
- **PIO est hors périmètre** jusqu'à décision explicite de réouverture.
- Le module Agency est une piste distincte actuellement gelée. Ne pas ajouter de fonctionnalités Agency avant validation du MVP FlowAuto. Il faut néanmoins maintenir le dépôt compilable.

## 2. Architecture actuelle

Le système est organisé autour de deux côtés.

### Sur le poste de l'utilisateur

- **Application AnyModelBot / Electron** : application locale existante.
- **Agent DSH** : exécution des conversations et des tâches dans le runtime déjà intégré.
- **Computer Use / CUA Driver** : interaction avec l'interface graphique.
- **ApprovalCenter** : validation locale des actions Computer Use et des questions nécessitant l'utilisateur.
- **TaskService** : création, exécution, reprise et suivi durable des tâches.
- **SQLite local** : données et identifiant stable du poste.
- **LocalExecutionNode** — `src/execution-node/service.ts` : client WebSocket sortant qui relie le poste au Control Plane.

### Côté serveur

- **Control Plane** — `control-plane/server.mjs` : serveur HTTP/WebSocket, stockage SQLite et authentification.
- **Dashboard administrateur** — `control-plane/public/` : envoi des tâches, suivi des postes et tâches, décisions d'approbation, réponses aux questions, pause/reprise/annulation/révocation.
- **Déploiement** — `control-plane/Dockerfile` et `control-plane/docker-compose.yml` : base de déploiement autonome.

### Flux nominal

```text
Navigateur administrateur
        |
        | HTTPS + jeton administrateur
        v
Control Plane + SQLite
        |
        | WebSocket sortant du poste (WSS)
        v
LocalExecutionNode
        |
        v
TaskService -> agent DSH -> Computer Use -> Chrome -> Google Flow
        |                                  |
        |                                  v
        |                         fichiers dans workspace
        v
état / question / approbation / manifeste de fichiers
        |
        v
Control Plane -> compte rendu dans le dashboard
```

Le serveur distant orchestre et conserve les états. Il ne doit pas devenir un terminal distant : il ne reçoit ni cookies Chrome, ni profils navigateur, ni clés API locales, ni contenu arbitraire du système de fichiers.

## 3. État réel au commit de référence

Attention à la distinction suivante : **présent dans le code ne signifie pas validé sur un vrai poste**. Le dépôt contient beaucoup de tests automatisés, mais le dernier workflow CI est rouge et le parcours complet avec Chrome/Google Flow n'a pas encore été prouvé.

| Domaine | État dans le dépôt | Ce qui reste à prouver |
|---|---|---|
| Application AnyModelBot, UI locale, bots, espaces de travail, tâches et runtime agent | Socle existant hérité du projet amont | Installer et démarrer proprement le fork sur le poste cible |
| Computer Use et CUA Driver | Intégration existante dans l'application ; contrôles d'approbation documentés | Vérifier les permissions OS et les interactions réelles avec Chrome sur le poste cible |
| Client LocalExecutionNode | Implémenté : identité persistante, authentification sortante, heartbeat, reconnexion, pause/révocation et état du poste | Test réel sur le système d'exploitation cible et sous perte réseau/redémarrage |
| Tâches FlowAuto distantes | Implémentées : soumission limitée à `flowauto`, conversion vers TaskService, statut, annulation, reprise et rejet | Parcours complet réel, y compris erreurs et interruptions pendant une génération |
| Control Plane | Implémenté : HTTP/WebSocket, SQLite, jetons admin/nœud, dashboard, API nodes/tasks | Déploiement HTTPS/WSS persistant et tests de sécurité opérationnels |
| Approbations Computer Use | Transport distant et revalidation par l'ApprovalCenter local implémentés | Prouver qu'aucune entrée n'est appliquée sans décision locale valable |
| Questions FlowAuto | Transport, persistance hors ligne et rejeu après reconnexion implémentés | Vérifier en conditions réelles les questions, réponses tardives et questions expirées |
| Sécurité des tâches | Politique FlowAuto fixe, contrôle des paramètres du bot et restriction des outils des sessions distantes documentés | Audit adversarial et tests runtime contre injection de prompt, site hostile et contournements |
| Métadonnées des fichiers produits | Implémentées : chemins relatifs, fichiers non vides, limites de taille/nombre, vérification de l'espace de travail et exclusion des liens symboliques sortants | Vérifier les vrais téléchargements Chrome et la cohérence du manifeste |
| Transfert du contenu des fichiers au dashboard | **Absent** : seuls les chemins relatifs, types et tailles sont transmis | Concevoir un mécanisme authentifié de téléchargement/aperçu, si l'accès distant au média est requis |
| Flux vidéo en direct du bureau | **Absent** | À évaluer séparément ; ne pas le confondre avec le MVP de génération et de vérification locale |
| Génération et contrôle qualité de médias Google Flow | Consignes présentes dans la politique FlowAuto | **Non validé de bout en bout** sur un vrai compte et un vrai navigateur |
| Publication automatique | Non autorisée sans approbation explicite | À garder après le MVP, derrière une confirmation distincte |
| CI globale | **En échec au commit de référence** | Réparer les erreurs de syntaxe avant tout nouveau développement fonctionnel |

### Fonctionnalités spécifiques déjà ajoutées au fork

Les commits récents ajoutent notamment :

- `fc0bc541` : client local sortant pour le poste FlowAuto.
- `4ecd0c9` : Control Plane auto-hébergé et premier dashboard.
- `cb5c938` / `247ca41` / `7002207` : transport et rejeu des approbations Computer Use après reconnexion.
- `b6e8ae8` / `a25e537` / `01b084f` : transport des questions et réponses FlowAuto.
- `f32455b` / `c75133c` / `e421f10` : politique de sécurité FlowAuto, validation avant effets de bord et approbation exacte des actions externes.
- `7857f98` / `d471ddf` : manifeste des fichiers produits et confinement des chemins dans le workspace.
- `73fa7fc` : visibilité de la santé/connexion du poste sur les tâches.
- `5a0c623` / `333cabb` : identification des tâches rejetées et protection des états terminaux contre une annulation tardive.

Les suites de tests correspondantes existent dans `test/execution-node.unit.test.ts`, `test/execution-node-gate.unit.test.ts` et `control-plane/test/server.test.mjs`. Elles n'ont cependant pas toutes été exécutées dans le dernier workflow, car celui-ci s'est arrêté avant ces étapes.

## 4. Blocage immédiat — P0 : remettre la CI au vert

Le workflow GitHub Actions du commit de référence est en échec :

- Run : [CI #45494928790](https://github.com/Amireflow/AnyModelBot/actions/runs/45494928790).
- Le job `Typecheck, unit tests, build` échoue à `npm run typecheck`.
- Le job Windows E2E échoue également à `npm run build` pour les mêmes erreurs.
- Les étapes `npm test`, `npm run test:control-plane`, le build complet et les validations documentaires ont été ignorées après l'échec du typecheck.

Les erreurs de parsing visibles concernent notamment :

- `src/agency/store.ts` autour des lignes 706, 771, 779 et 809 ;
- `src/agency/whatsapp-cloud.ts` autour des lignes 77 et 169 ;
- `test/agency-company-research-import.unit.test.ts` autour de la ligne 107 ;
- `test/agency-whatsapp-http.unit.test.ts` autour des lignes 85, 100, 108, 129 et 169 ;
- `test/agency-whatsapp.unit.test.ts` autour des lignes 19 et 168.

Les extraits actuels montrent des caractères d'échappement littéraux devant des délimiteurs de template string et une séquence `\\n` littérale dans un fichier de test. Corriger la syntaxe réelle sans faire de remplacement global aveugle.

**Critère de sortie P0 :** le workflow CI complet du commit correctif réussit, notamment typecheck, tests unitaires, tests Control Plane, build, vérification du catalogue et contrôles de documentation/i18n. Les jobs Windows doivent au minimum passer leur étape de build avant de prétendre valider l'E2E.

## 5. Plan de développement par lots

### Lot 0 — Stabilisation et vérité de référence

**Priorité : P0 — obligatoire avant toute fonction nouvelle.**

1. Corriger les erreurs de parsing listées ci-dessus.
2. Examiner les fichiers Agency modifiés et déterminer si les caractères incorrects sont isolés ou présents dans d'autres fichiers.
3. Faire passer toutes les étapes CI ; ne pas se contenter d'un typecheck local.
4. Vérifier que les changements récents du Control Plane n'ont pas de régression.
5. Conserver Agency en gel fonctionnel ; ne pas supprimer ses modules ou ses données pour faire passer la compilation.

**Preuves attendues :** lien du run CI vert, sortie des commandes locales et commit du lot.

### Lot 1 — Démarrage local reproductible

**Priorité : P0.**

1. Cloner le dépôt avec ses sous-modules, puis vérifier `git status`, `git log -1` et les sous-modules.
2. Respecter les prérequis du dépôt : Node.js 22.13+ ; Go 1.26.8+ lorsque la compilation du gateway Magpie est nécessaire.
3. Installer les dépendances et lancer le setup du projet selon `docs/development.md`.
4. Démarrer AnyModelBot et confirmer que le runtime DSH est disponible.
5. Vérifier que le CUA Driver est présent pour le système et l'architecture visés.
6. Documenter la plateforme réellement testée (macOS, Windows ou Linux), les permissions OS accordées et les commandes de démarrage.

**Critère de sortie :** AnyModelBot démarre sans erreur, le bot dédié existe, Computer Use fonctionne localement et aucune donnée/secrète n'est ajoutée au dépôt.

### Lot 2 — Déploiement sécurisé du Control Plane

**Priorité : P0.**

1. Déployer `control-plane/` dans un environnement de test persistant.
2. Utiliser HTTPS/WSS derrière un reverse proxy ; ne pas exposer directement le port interne sans TLS.
3. Générer deux secrets indépendants : un jeton administrateur et un jeton de nœud.
4. Persister le fichier SQLite et définir une sauvegarde/restauration.
5. Vérifier `/healthz`, l'accès administrateur, l'authentification du nœud et le refus des jetons invalides.
6. Vérifier que les secrets ne sont jamais exposés dans le dashboard, les réponses API ou les logs.

Variables actuellement documentées : `AMB_CP_ADMIN_TOKEN`, `AMB_CP_NODE_TOKEN`, `AMB_CP_TRUST_PROXY=1`, `AMB_CP_DB`, `HOST` et `PORT`.

**Critère de sortie :** serveur joignable en HTTPS/WSS, base persistante après redémarrage, authentification séparée et tests de refus réussis.

### Lot 3 — Appairage et cycle de vie du poste

**Priorité : P0.**

1. Créer un bot dédié FlowAuto, appartenant à l'utilisateur.
2. Respecter les prérequis contrôlés par le code : permission Workspace, Computer Use activé avec approbation avant chaque entrée, mémoire désactivée, aucune application connectée sélectionnée et tâches de fond non suspendues.
3. Configurer les variables locales :
   - `AMB_EXECUTION_CONTROL_URL=wss://<domaine>/node`
   - `AMB_EXECUTION_CONTROL_TOKEN=<jeton du nœud>`
   - `AMB_EXECUTION_BOT_ID=<id du bot dédié>`
4. Vérifier la connexion, l'identifiant persistant du poste, le heartbeat et l'état dans le dashboard.
5. Tester la coupure réseau, la reconnexion avec backoff, le redémarrage de l'application, pause/reprise et révocation.
6. Vérifier le ré-appairage après révocation uniquement avec une intervention locale et un nouveau jeton.

**Critère de sortie :** un poste réel apparaît dans le dashboard, revient après une coupure et ne peut pas se reconnecter après révocation sans ré-appairage local.

### Lot 4 — Fiabilité du protocole et du cycle de tâche

**Priorité : P0.**

Valider chaque scénario avec un nœud connecté puis avec un nœud déconnecté :

- soumission valide, tâche acceptée, en cours, terminée ;
- tâche invalide ou rejetée avec conservation du bon identifiant distant ;
- doublon de soumission et rejeu après reconnexion sans double exécution ;
- pause qui bloque les nouvelles tâches sans interrompre celles déjà acceptées ;
- annulation avant acceptation, pendant l'exécution et après un état terminal ;
- erreur, timeout, redémarrage du poste et reprise ;
- conservation des états terminaux (`succeeded`, `failed`, `cancelled`, `rejected`, `interrupted`) face aux messages tardifs ;
- limite de taille UTF-8 des instructions et de taille des trames.

**Critère de sortie :** tests d'intégration reproductibles et états du dashboard cohérents avec le TaskService local, y compris après redémarrage et messages dupliqués.

### Lot 5 — Approbations et questions à distance

**Priorité : P0.**

1. Déclencher une action Computer Use qui nécessite une approbation.
2. Vérifier que le dashboard montre l'action précise, son contexte et son état.
3. Autoriser puis refuser des actions ; vérifier que seul l'ApprovalCenter local décide réellement.
4. Tester une décision lorsque le poste est déconnecté, puis la reconnexion et le rejeu.
5. Tester les décisions périmées, expirées, dupliquées et les tâches déjà terminées.
6. Vérifier séparément les questions non bloquantes `task_report(needs_you)` et leurs réponses textuelles.
7. S'assurer qu'une réponse à une question ne peut pas être interprétée comme une approbation d'un clic ou d'une action externe.

**Critère de sortie :** aucun clic, frappe ou saisie ne se produit sans approbation locale valide ; toute décision distante est revalidée localement.

### Lot 6 — Première vraie automatisation Google Flow

**Priorité : P0 — cœur du MVP.**

Commencer par un scénario simple, reproductible et sans publication :

1. L'utilisateur laisse Chrome ouvert sur le profil et le compte Google Flow autorisés.
2. Depuis le dashboard, envoyer une instruction courte de génération.
3. Le bot ouvre ou utilise Google Flow par l'interface graphique autorisée.
4. Il crée une image ou une vidéo avec les paramètres explicitement demandés.
5. Il traite les attentes, chargements et erreurs sans contourner le navigateur par script, shell, API privée ou extension.
6. Il enregistre le résultat dans le workspace dédié. Chrome doit être configuré pour demander où enregistrer les téléchargements, puis le dossier du bot doit être choisi.
7. Il vérifie l'existence du résultat dans l'interface et rapporte le chemin relatif.
8. Il s'arrête pour toute connexion, permission ou action sensible non prévue.

Ne pas commencer par plusieurs comptes, plusieurs profils Chrome, des publications ou des scénarios complexes.

**Critère de sortie :** au moins trois exécutions consécutives réussies sur le poste cible, avec les fichiers attendus dans le workspace et un compte rendu fidèle. Chaque échec doit produire un état explicite, pas un faux succès.

### Lot 7 — Contrôle qualité des images et vidéos

**Priorité : P1, immédiatement après le premier parcours de génération.**

Pour chaque livrable :

- image : ouvrir le fichier/résultat et vérifier visuellement qu'il correspond à la demande ;
- vidéo : ouvrir le résultat final et le lire dans l'interface jusqu'à sa fin ;
- vérifier que le fichier final est bien celui annoncé, que la lecture ne s'interrompt pas et que le rendu est exploitable ;
- distinguer clairement « généré », « téléchargé », « ouvert », « lu jusqu'au bout » et « qualité validée » ;
- signaler les limites : watermark, audio absent, coupure, mauvais format, export incomplet ou écart avec le brief.

Le manifeste déjà présent ne transporte que des métadonnées. Il ne prouve ni la qualité du média ni le succès de sa lecture.

**Critère de sortie :** le compte rendu ne marque « vérifié » que les contrôles réellement effectués ; les cas de rendu incomplet ou illisible sont signalés comme échec.

### Lot 8 — Accès distant aux livrables et observation

**Priorité : P1/P2 selon le besoin réel.**

Le Control Plane ne transfère actuellement pas le contenu des fichiers et ne diffuse pas l'écran en direct. Après validation locale du MVP, décider précisément ce dont l'utilisateur a besoin :

- **Accès aux fichiers** : téléchargement/aperçu de fichiers du workspace avec authentification, autorisation par tâche, liens temporaires ou transfert borné, limites de taille/type, protection contre traversal et liens symboliques, journalisation et suppression/rétention.
- **Observation en direct** : flux d'écran à faible latence, démarré explicitement, authentifié et visible par l'utilisateur ; contrôle d'accès et bouton d'arrêt local.
- Ne pas mélanger le transfert de fichiers et le streaming d'écran dans une seule autorisation permissive.
- Ne jamais exposer un chemin local brut ou un partage de fichiers du poste sur Internet.

**Critère de sortie :** l'utilisateur peut récupérer un livrable autorisé sans ouvrir un accès général au disque du poste. Le streaming n'est livré que si un besoin démontré le justifie.

### Lot 9 — Publication et actions externes

**Priorité : P2 — après génération, sauvegarde et QA.**

- Préparer une étape distincte de publication.
- Afficher exactement le compte, la destination, le contenu et les paramètres avant action.
- Exiger une approbation explicite propre à cette publication.
- Ne jamais réutiliser une approbation donnée pour une autre action, un autre compte ou une autre tâche.
- En cas de résultat ambigu après timeout, vérifier l'état externe avant toute nouvelle tentative.

**Critère de sortie :** publication impossible sans approbation dédiée et aucun doublon lors des reprises.

### Lot 10 — Extension à d'autres applications

**Priorité : P3 — ne pas démarrer avant la stabilité FlowAuto.**

Si le MVP est fiable, définir des adaptateurs de tâches explicites par application. Chaque adaptateur doit spécifier ses actions autorisées, ses données, ses confirmations, ses limites et ses tests. Le protocole ne doit pas accepter une commande shell, un script ou un chemin arbitraire pour devenir un contrôleur universel.

**Critère de sortie :** chaque nouveau type de tâche possède une allowlist, des tests de sécurité et un scénario E2E indépendant.

### Lot 11 — Préparation à la distribution

**Priorité : P2, lorsque l'usage réel est stable.**

- Revoir l'identité du fork : nom produit, identifiant d'application, URLs, pages d'aide, propriété des Releases et configuration de publication encore héritées de l'amont.
- Vérifier les installations macOS, Windows et Linux séparément ; ne pas annoncer une plateforme comme validée sur la seule base d'une compilation.
- Vérifier le CUA Driver, Magpie, les sous-modules, les droits OS et la persistance.
- Documenter les sauvegardes, rotation des secrets, mises à jour, logs, récupération après incident et suppression d'un poste appairé.
- Mettre à jour la documentation et les notes de version seulement après que la fonctionnalité existe et a été testée.

**Critère de sortie :** une version installable et reproductible, avec une matrice de plateformes et des preuves CI/E2E par plateforme.

## 6. Matrice minimale de validation

| Niveau | Contrôles | Preuve exigée |
|---|---|---|
| Typecheck/build | TypeScript, build catalogue, compilation | CI verte |
| Tests unitaires | politique du bot, URL WSS, taille d'instruction, idempotence, chemins de fichiers, états terminaux | rapport de tests |
| Tests Control Plane | auth, tâches, approvals, questions, rejeu, annulation, nœud offline, SQLite | `npm run test:control-plane` réussi |
| Tests Electron/OS | démarrage, permissions, CUA Driver, logs et reconnexion | logs et capture sur l'OS ciblé |
| E2E navigateur | Chrome existant, Google Flow, génération et téléchargement | vidéo/captures du test et fichiers dans le workspace |
| QA média | ouverture image, lecture vidéo complète, cohérence du rapport | livrable et checklist de QA |
| Sécurité | jetons invalides, absence de secrets, prompt injection, action refusée, révocation, traversal/symlink | tests négatifs réussis |
| Exploitation | TLS, sauvegarde DB, redémarrage serveur et poste, rotation secrets | preuve de restauration et runbook |

### Commandes racine déjà définies dans package.json

À utiliser selon le lot, après installation des dépendances :

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run test:control-plane
npm run build
npm run docs:check
npm run i18n:check
```

Le script `npm run setup` est nécessaire à la préparation du runtime intégré selon la procédure du dépôt. Ne pas prétendre qu'une commande est réussie sans l'avoir réellement exécutée. Pour un poste Windows, macOS ou Linux, compléter par les contrôles spécifiques décrits dans `docs/development.md`.

## 7. Règles de reprise pour le prochain développeur ou agent

1. Lire ce document, `AGENTS.md`, `docs/execution-node.md`, `docs/execution-node-security.md` et `docs/development.md` avant toute modification.
2. Rester sur `master` conformément à `AGENTS.md`.
3. Commencer par le P0 CI ; ne pas empiler de nouvelles fonctionnalités sur une compilation cassée.
4. Travailler par lots cohérents et vérifiables, avec peu de commits mais des commits suffisamment isolés pour être audités.
5. Pour chaque lot : objectif, fichiers modifiés, tests exécutés, résultats réels, limites restantes, commit.
6. Ne jamais transformer « code présent » en « fonctionnalité validée » sans test adéquat.
7. Ne jamais enregistrer de jeton, cookie, profil Chrome, capture sensible ou donnée privée dans Git.
8. Ne jamais contourner Computer Use, l'ApprovalCenter ou la politique de sécurité avec des scripts, CDP, API internes ou shell dans une tâche distante.
9. Ne pas toucher au dépôt FlowAuto ; c'est la cible pilotée, pas un sous-projet à modifier.
10. Garder PIO et les nouvelles intégrations hors périmètre tant que le MVP FlowAuto n'est pas validé.
11. Garder Agency en gel fonctionnel ; ne corriger son code que pour rétablir la compilation, la sécurité ou la stabilité du socle.
12. Mettre à jour cette feuille de route après chaque lot important, avec le commit et les preuves de validation.

## 8. Priorité immédiate — les trois prochaines tâches

1. **Réparer la syntaxe des fichiers Agency et remettre la CI au vert.** Résultat : typecheck, tests, Control Plane et build exécutés dans un workflow réussi.
2. **Valider le poste local.** Résultat : AnyModelBot démarre, le CUA Driver fonctionne et le bot FlowAuto respecte les contraintes de sécurité sur le système cible.
3. **Valider le trajet distant de bout en bout.** Résultat : une tâche envoyée depuis le dashboard est exécutée sur le poste, contrôlée via approbations locales et rapportée sans perte d'état.

Tant que ces trois tâches ne sont pas terminées, aucune nouvelle piste (PIO, autre application, nouvelle fonction Agency, publication automatique) ne doit devenir la priorité.
