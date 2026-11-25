# Guide de développement

[简体中文](./development.md) | [English](./development_en.md) | Français | [日本語](./development_ja.md) | [한국어](./development_ko.md) | [Русский](./development_ru.md) | [Español](./development_es.md) | [Português (Brasil)](./development_pt.md) | [Türkçe](./development_tr.md)

Ce guide s'adresse aux développeurs souhaitant exécuter AnyModelBot depuis les sources, le packager ou contribuer au projet. Pour utiliser simplement l'application, téléchargez un installateur depuis [Releases](https://github.com/modelflare-ai/AnyModelBot/releases) ou consultez le [README_fr.md](../README_fr.md).

- Trois modes d'exécution pour une même base de code : **application desktop (Electron)**, **ligne de commande (`npm start`)** et **Docker**.
- Stockage local unifié dans `./data` (modifiable via `AMB_DATA_DIR`) s'appuyant sur `node:sqlite`.

## Structure du dépôt

```text
src/
  agency/        moteur d'agence autonome : prospection Deep Search + LLM, CRM, devis/contrats, projets & pont IDE, pont WhatsApp Desktop local, QA visuelle headless, déploiement, sauvegardes et registre d'usage
  core/          types de messages partagés, file d'attente de session, boîte d'envoi persistante, contrôles d'accès
  agent/         runtime DSH, approbations, mémoire à long terme, gestionnaire de contexte
  tools/         recherche Web, génération média, Computer Use, PowerShell, connecteurs MCP
  channels/      WeChat (iLink), Feishu, Telegram, Slack, Discord
  tasks/         tâches en arrière-plan, règles planifiées, budgets et rétention
  store/         couche SQLite (node:sqlite)
  domain/        types et règles métier purs sans E/S
  web/           serveur console locale (`127.0.0.1:3600`), routes API et SSE (`routes/agency.ts`, `routes/agency-ops.ts`, ...)
  i18n/          internationalisation côté serveur (fr, zh-CN, en, ja, ko, ru, es, pt, tr)
ui/
  design/        système de design exclusif (tokens/, base/, components/)
  locales/       dictionnaires UI par langue et espace de noms
  screens/       écrans Preact + htm sans étape de compilation (`agency.js`, `agency/operations.js`, `sidebar.js`, ...)
control-plane/   plan de contrôle d'exécution local et adaptateurs d'outils
site/            site statique Astro et catalogues localisés
docs/            guides techniques, confidentialité, feuille de route et documentation d'agence
```

## Démarrer depuis les sources

Prérequis : **Node.js 22.13+** et **Go 1.26.8+** (pour compiler la passerelle `magpie`).

```bash
npm install
npm run setup        # compile vendor/magpie dans build/bin/
npm start            # démarre la passerelle + les bots + la console sur http://127.0.0.1:3600/
```

L'accès à la console locale requiert un jeton généré automatiquement dans `data/ui-token` lorsque `AMB_UI_TOKEN` n'est pas défini.

## Application desktop (Electron)

```bash
npm run electron:dev     # exécution en développement
npm run electron:smoke   # test de fumée Electron
npm run dist             # génération du paquet pour la plateforme courante
```

## Localisation et vérifications qualité

- `npm run i18n:status` : affiche la progression par langue sur les surfaces application, serveur et documentation.
- `npm run i18n:check` : vérifie la cohérence des clés, paramètres, pluriels, catalogues (`channels`, `announcements`) et documents localisés.
- `npm run docs:check` : vérifie les liens relatifs, ancres et règles éditoriales des fichiers README et documents liés.
- `npm run typecheck` : vérification TypeScript stricte (`tsc --noEmit`).
- `npm test` et `npm run test:control-plane` : suites unitaires, E2E et plan de contrôle.

Pour les détails d'architecture sur le moteur d'agence et le nœud d'exécution local, voir [docs/agency/ROADMAP.md](./agency/ROADMAP.md), [docs/execution-node.md](./execution-node.md) et [docs/execution-node-security.md](./execution-node-security.md).
