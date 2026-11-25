# Confidentialité et données

[简体中文](./privacy.md) | [English](./privacy_en.md) | Français | [日本語](./privacy_ja.md) | [한국어](./privacy_ko.md) | [Русский](./privacy_ru.md) | [Español](./privacy_es.md) | [Português (Brasil)](./privacy_pt.md) | [Türkçe](./privacy_tr.md)

AnyModelBot fonctionne principalement en local sur votre machine : les conversations, la mémoire, les fichiers d'espace de travail et la configuration restent sur votre appareil. Les requêtes envoyées aux modèles, la messagerie instantanée et les services externes connectés quittent toutefois votre appareil dès lors que vous les utilisez. Cette page recense précisément ce qui reste local et ce qui est transmis à l'extérieur.

## Ce qui reste sur votre appareil

Répertoire des données : `./data` en ligne de commande (modifiable via `AMB_DATA_DIR`), `<userData>/data` dans l'application desktop, `/data` dans Docker.

| Élément | Emplacement | Remarque |
| :--- | :--- | :--- |
| Messages, sessions, tâches, boîte d'envoi et journal d'utilisation | `anymodel-bot.sqlite` | Enregistré localement avec SQLite ; incluant le CRM d'agence, devis, contrats et livrables. |
| Mémoire à long terme | `memory/` et `about-me.json` | Fichiers Markdown par bot/groupe + préférences partagées. |
| Espace de travail des bots et pièces jointes | `workspaces/<bot>/` | Les fichiers lus, créés ou exportés par les bots. |
| Configuration et jetons | `config.json`, `modelflare-account.json`, `app-secrets.json`, `channels/` | Protégés par les permissions de fichiers locales (`mode 600` lorsque applicable). |
| Passerelle locale et runtime d'agent | `magpie/`, `dsh/` | Exécutés localement sans télémétrie activée. |

## Ce qui quitte votre appareil

1. **Requêtes aux modèles d'IA :** les prompts, fichiers joints, résultats d'outils et captures d'écran (si le contrôle d'écran est activé) sont transmis au fournisseur de modèles que vous sélectionnez (directement avec vos clés API officielles, ou via Modelflare).
2. **Modelflare (si connecté) :** connexion OIDC + PKCE sur `modelflare.dev`, lecture du solde, catalogue de modèles et journaux de requêtes décrits dans le [Modelflare Trust Center](https://modelflare.dev/trust?utm_source=anymodelbot&utm_campaign=amb_readme).
3. **Canaux de messagerie :** les messages échangés via WeChat, Feishu, Telegram, Slack ou Discord transitent par leurs plateformes respectives. Le pont **WhatsApp Desktop local** ouvre uniquement l'application WhatsApp installée sur votre poste via `whatsapp://send` après consentement explicite, sans envoi silencieux côté serveur.
4. **Applications connectées et recherche Web :** lorsque vous connectez Notion, GitHub, Feishu, un serveur MCP personnalisé ou lancez une prospection/recherche Web, le contenu consulté ou écrit transite vers ces services puis vers le modèle actif.

## Contrôles et suppression

- Vous pouvez supprimer une conversation, modifier ou verrouiller des entrées dans Paramètres → À propos de moi, ou révoquer un appareil connecté depuis votre profil Modelflare.
- La fonction « Copier le diagnostic » (Paramètres → Dépannage) retire les clés API, jetons et identifiants sensibles avant copie.
- Vous pouvez exporter une sauvegarde chiffrable / locale ou supprimer le répertoire `data` pour effacer l'ensemble des données locales.
