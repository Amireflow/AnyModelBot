<p align="center">
  <a href="https://github.com/modelflare-ai/AnyModelBot/releases">
    <img src="docs/assets/brand/logo-eyes.webp" width="120" height="120" alt="AnyModelBot Eyes mark: two vertical pill-shaped eyes that glance left and right">
  </a>
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/wordmark-dark.svg">
    <img src="docs/assets/brand/wordmark-light.svg" height="40" alt="AnyModelBot">
  </picture>
</h1>

<p align="center"><b>Une équipe de bots IA sur votre propre ordinateur. N'importe quel modèle, facturé à l'usage.</b></p>

<p align="center">
  <a href="https://anymodel.bot/en/">Site web</a> |
  <a href="https://github.com/modelflare-ai/AnyModelBot/releases">Télécharger</a> |
  <a href="./README.md">简体中文</a> |
  <a href="./README_en.md">English</a> |
  Français |
  <a href="./README_ja.md">日本語</a> |
  <a href="./README_ko.md">한국어</a> |
  <a href="./README_ru.md">Русский</a> |
  <a href="./README_es.md">Español</a> |
  <a href="./README_pt.md">Português (Brasil)</a> |
  <a href="./README_tr.md">Türkçe</a> |
  <a href="https://modelflare.dev/?utm_source=anymodelbot&utm_campaign=amb_readme">Modelflare</a> |
  <a href="https://modelflare.dev/pricing?utm_source=anymodelbot&utm_campaign=amb_readme">Tarifs</a> |
  <a href="./docs/development_fr.md">Développement</a> |
  <a href="https://github.com/modelflare-ai/AnyModelBot/issues">Retours</a>
</p>

<div align="center">

[![Release][release-shield]][releases-link]
[![Downloads][downloads-shield]][releases-link]
[![Stars][stars-shield]][stars-link]
[![License][license-shield]][license-link]
[![CI][ci-shield]][ci-link]

[![Platform][platform-shield]][releases-link]
[![Pricing][pricing-shield]][pricing-link]
[![Modelflare][modelflare-shield]][modelflare-link]
[![X][x-shield]][x-link]

[![Discord][discord-shield]][discord-link]
[![Telegram][telegram-shield]][telegram-link]

</div>

<p align="center">
  <img src="docs/assets/hero/hero-demo.gif" alt="AnyModelBot en action : connexion à Modelflare, sélection d'un modèle, tri d'un dossier et approbation d'un déplacement de fichier" width="100%">
</p>

# 🤖 AnyModelBot

AnyModelBot est une équipe de bots IA pour Windows, macOS et Linux qui s'exécute sur votre ordinateur. Chaque bot possède sa propre persona, son modèle par défaut, son espace de travail et sa mémoire. Vous pouvez discuter directement dans l'application ou connecter WeChat, Feishu, Telegram, Slack, Discord et votre application **WhatsApp Desktop locale**. Les bots peuvent lire et écrire des fichiers, exécuter des commandes et piloter le bureau avec votre autorisation ; ils demandent confirmation avant toute écriture hors de leur espace de travail.

Les conversations, la mémoire, les fichiers et les clés API restent sur votre appareil. Les modèles peuvent provenir de [Modelflare](https://modelflare.dev/?utm_source=anymodelbot&utm_campaign=amb_readme) (connexion simple, paiement à l'usage) ou de vos propres clés API officielles, transmises directement au fournisseur. AnyModelBot lui-même ne comporte aucun abonnement.

La plateforme inclut également un **moteur d'agence logicielle autonome** (CRM B2B, prospection par recherche Web profonde / LLM, devis et négociation encadrée, contrats, suivi de projets locaux & pont IDE, QA visuelle headless, adaptateurs de déploiement et sauvegarde SQLite).

**0.1.47 :** lorsque vous êtes connecté à Modelflare, les images ajoutées à une conversation peuvent servir de références pour la génération d'images avec le modèle choisi en bas à droite. [Journal des modifications](./CHANGELOG_fr.md#0147---2026-11-23)

📥 [Télécharger et lancer](#-télécharger-et-lancer) · 🌠 [Captures d'écran](#-captures-décran) · 🌟 [Fonctionnalités clés](#-fonctionnalités-clés) · 🔐 [Confidentialité](#-fonctionnement--confidentialité)

---

# 📥 Télécharger et lancer

Téléchargez l'installateur correspondant à votre plateforme sur la [page des versions](https://github.com/modelflare-ai/AnyModelBot/releases) (accompagnée d'un fichier `SHA256SUMS`).

| Plateforme | Architecture | Installateur | |
| :--- | :--- | :--- | :--- |
| ![Windows][win-badge] | x64 | `anymodel-bot-<version>-win-x64.exe` | [Télécharger][releases-link] |
| ![Windows][win-badge] | arm64 | `anymodel-bot-<version>-win-arm64.exe` | [Télécharger][releases-link] |
| ![macOS][mac-badge] | Apple silicon | `anymodel-bot-<version>-mac-arm64.dmg` | [Télécharger][releases-link] |
| ![macOS][mac-badge] | Intel | `anymodel-bot-<version>-mac-x64.dmg` | [Télécharger][releases-link] |
| ![Linux][linux-badge] | x64 | `anymodel-bot-<version>-linux-x86_64.AppImage` | [Télécharger][releases-link] |
| ![Linux][linux-badge] | arm64 | `anymodel-bot-<version>-linux-arm64.AppImage` | [Télécharger][releases-link] |

**Exécution avec Docker :**

```bash
docker run -d --name amb -p 3600:3600 -v amb-data:/data ghcr.io/modelflare-ai/anymodel-bot
docker exec amb cat /data/ui-token   # puis ouvrez http://<host>:3600/?token=<token>
```

N'exposez pas directement le port 3600 sur Internet.

**Exécution depuis les sources :**

```bash
git clone https://github.com/modelflare-ai/AnyModelBot.git
cd AnyModelBot
npm install
npm run setup      # télécharge et compile la passerelle intégrée
npm start          # démarre la console locale sur http://127.0.0.1:3600/
```

Prérequis : Node.js 22.13+ et Go 1.26.8+. Consultez le [guide de développement](./docs/development_fr.md) pour plus de détails.

# 🌠 Captures d'écran

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/chat-dark.webp">
  <img src="docs/assets/screenshots/chat-light.webp" alt="Écran de discussion : réponse Markdown, sélection de modèle et liste des bots" width="100%">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/agent-dark.webp">
  <img src="docs/assets/screenshots/agent-light.webp" alt="Écran d'agent : liste des étapes et carte d'approbation" width="100%">
</picture>

# 🌟 Fonctionnalités clés

## 🤖 Des bots qui agissent réellement

- **Personnas, modèles et espaces séparés :** chaque bot dispose de sa mémoire Markdown, de son répertoire de travail et d'un préréglage de permissions (*Lecture seule*, *Espace de travail*, *Accès complet*).
- **Compétences (Skills) :** importez des archives `.zip` contenant `SKILL.md` dans Paramètres du bot → Compétences ([guide des compétences](./docs/skills_fr.md)).
- **Tâches en arrière-plan et règles planifiées :** confiez des tâches longues ou périodiques avec plafond de budget (1 dollar US par tâche, 0,10 dollar US par exécution de règle par défaut) et file d'approbation unifiée (*Needs you*).
- **Moteur d'agence logicielle autonome :**
  - **Prospection Web profonde (Deep Search) + LLM :** recherche multi-requêtes (Exa, Bing, DuckDuckGo, Tavily), lecture complète des pages web, qualification ICP et extraction structurée.
  - **CRM, devis, négociation et contrats :** gestion des entreprises, contacts avec traçabilité du consentement, propositions commerciales, devis, négociation bornée et jalons.
  - **Pont WhatsApp Desktop local :** ouverture directe de l'application WhatsApp installée sur votre machine via `whatsapp://send` avec message prérempli, vérification du consentement et journalisation dans le CRM (aucune API Cloud externe requise).
  - **Suivi de projets locaux & Pont IDE :** détection de dépôts Git, métriques de progression, synchronisation IDE (VS Code, Cursor, Windsurf, Antigravity, CLI Claude Code / Codex).
  - **QA visuelle E2E, déploiement et exploitation :** vérifications headless desktop/mobile avec captures PNG, vérifications HTTP `/health`, adaptateurs de déploiement, sauvegarde SQLite, export CSV sécurisé et registre de consommation LLM.

## 🌐 Modèles, canaux et confidentialité

- **Modelflare ou clés API officielles :** GPT, Claude, Gemini, Grok, DeepSeek, Kimi, GLM, Qwen, MiniMax et Mistral avec un sélecteur unifié.
- **Canaux partagés :** WeChat, Feishu, Telegram, Slack, Discord et pont WhatsApp Desktop local.
- **Local-first :** données stockées localement dans `anymodel-bot.sqlite` ; la console écoute uniquement sur `127.0.0.1` avec jeton d'accès.

# 🔐 Fonctionnement & confidentialité

| Reste sur votre appareil | Quitte votre appareil |
| :--- | :--- |
| Conversations, CRM, devis, contrats (SQLite local) | Prompts, fichiers et résultats d'outils transmis au fournisseur de modèles choisi |
| Mémoire (fichiers Markdown) et fichiers d'espace de travail | Captures d'écran lorsque le contrôle d'écran est explicitement utilisé |
| Clés API et jetons de session | Messages transitant par les plateformes externes connectées |

Consultez l'inventaire complet dans [docs/privacy_fr.md](./docs/privacy_fr.md).

# 🤝 Contribuer et sécurité

- Guide complet : [CONTRIBUTING_fr.md](./CONTRIBUTING_fr.md)
- Politique de sécurité : [SECURITY_fr.md](./SECURITY_fr.md)
- Mentions tierces : [THIRD_PARTY_NOTICES_fr.md](./THIRD_PARTY_NOTICES_fr.md)
- Journal des modifications : [CHANGELOG_fr.md](./CHANGELOG_fr.md)

# 💬 Communauté & Licence

- [GitHub Discussions](https://github.com/modelflare-ai/AnyModelBot/discussions) · [GitHub Issues](https://github.com/modelflare-ai/AnyModelBot/issues)
- [Discord](https://discord.gg/umBN6wX3zJ) · [Telegram](https://t.me/+Tx6Payfzxqk2ZGVl) · [support@anymodel.bot](mailto:support@anymodel.bot)
- Licence [MIT](./LICENSE) — voir aussi [`LICENSES/`](./LICENSES).

<!-- link & badge references -->
[release-shield]: https://img.shields.io/github/v/release/modelflare-ai/AnyModelBot?include_prereleases&label=release&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48cmVjdCB4PSIzIiB5PSI5IiB3aWR0aD0iOTQiIGhlaWdodD0iODIiIHJ4PSIzNiIgZmlsbD0iI2Q3ZmYwMCIvPjxyZWN0IHg9IjI5IiB5PSIzNiIgd2lkdGg9IjEzIiBoZWlnaHQ9IjI4IiByeD0iNi41IiBmaWxsPSIjMTYxYTAwIi8+PHJlY3QgeD0iNTgiIHk9IjM2IiB3aWR0aD0iMTMiIGhlaWdodD0iMjgiIHJ4PSI2LjUiIGZpbGw9IiMxNjFhMDAiLz48L3N2Zz4=&style=flat-square&labelColor=161a00&color=d7ff00
[downloads-shield]: https://img.shields.io/github/downloads/modelflare-ai/AnyModelBot/total?logo=github&logoColor=d7ff00&style=flat-square&labelColor=161a00&color=d7ff00
[stars-shield]: https://img.shields.io/github/stars/modelflare-ai/AnyModelBot?logo=github&logoColor=d7ff00&style=flat-square&labelColor=161a00&color=d7ff00
[license-shield]: https://img.shields.io/github/license/modelflare-ai/AnyModelBot?logo=opensourceinitiative&logoColor=d7ff00&style=flat-square&labelColor=161a00&color=d7ff00
[ci-shield]: https://img.shields.io/github/actions/workflow/status/modelflare-ai/AnyModelBot/ci.yml?branch=master&label=CI&logo=githubactions&logoColor=d7ff00&style=flat-square&labelColor=161a00&color=d7ff00
[platform-shield]: https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Docker-d7ff00?style=flat-square&labelColor=161a00
[pricing-shield]: https://img.shields.io/badge/pricing-pay--as--you--go-d7ff00?style=flat-square&labelColor=161a00
[modelflare-shield]: https://img.shields.io/badge/Modelflare-modelflare.dev-d7ff00?style=flat-square&labelColor=161a00
[x-shield]: https://img.shields.io/badge/X-@modelflare__dev-d7ff00?style=flat-square&labelColor=161a00&logo=x&logoColor=d7ff00
[telegram-shield]: https://img.shields.io/badge/Telegram-chat-d7ff00?style=flat-square&labelColor=161a00&logo=telegram&logoColor=d7ff00
[discord-shield]: https://img.shields.io/badge/Discord-chat-d7ff00?style=flat-square&labelColor=161a00&logo=discord&logoColor=d7ff00
[win-badge]: https://img.shields.io/badge/Windows-161a00?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2Q3ZmYwMCI+PHJlY3QgeD0iMiIgeT0iMyIgd2lkdGg9IjkuNSIgaGVpZ2h0PSI4LjUiLz48cmVjdCB4PSIxMi41IiB5PSIzIiB3aWR0aD0iOS41IiBoZWlnaHQ9IjguNSIvPjxyZWN0IHg9IjIiIHk9IjEyLjUiIHdpZHRoPSI5LjUiIGhlaWdodD0iOC41Ii8+PHJlY3QgeD0iMTIuNSIgeT0iMTIuNSIgd2lkdGg9IjkuNSIgaGVpZ2h0PSI4LjUiLz48L3N2Zz4=
[mac-badge]: https://img.shields.io/badge/macOS-161a00?style=for-the-badge&logo=apple&logoColor=d7ff00
[linux-badge]: https://img.shields.io/badge/Linux-161a00?style=for-the-badge&logo=linux&logoColor=d7ff00

[releases-link]: https://github.com/modelflare-ai/AnyModelBot/releases
[stars-link]: https://github.com/modelflare-ai/AnyModelBot/stargazers
[license-link]: https://github.com/modelflare-ai/AnyModelBot/blob/master/LICENSE
[ci-link]: https://github.com/modelflare-ai/AnyModelBot/actions/workflows/ci.yml
[pricing-link]: https://modelflare.dev/pricing?utm_source=anymodelbot&utm_campaign=amb_readme
[modelflare-link]: https://modelflare.dev/?utm_source=anymodelbot&utm_campaign=amb_readme
[x-link]: https://x.com/modelflare_dev
[telegram-link]: https://t.me/+Tx6Payfzxqk2ZGVl
[discord-link]: https://discord.gg/umBN6wX3zJ
