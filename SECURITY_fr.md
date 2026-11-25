# Politique de sécurité

[English](./SECURITY.md) | [简体中文](./SECURITY.md#简体中文) | Français | [日本語](./SECURITY_ja.md) | [한국어](./SECURITY_ko.md) | [Русский](./SECURITY_ru.md) | [Español](./SECURITY_es.md) | [Português (Brasil)](./SECURITY_pt.md) | [Türkçe](./SECURITY_tr.md)

## Signaler une vulnérabilité

Merci de **ne pas** ouvrir d'issue, de discussion ou de pull request publique pour un problème de sécurité.

Signalez-le en privé par l'un des moyens suivants :

1. **Signalement privé de vulnérabilité GitHub (recommandé) :** accédez à l'onglet **Security** du dépôt → **Report a vulnerability**.
2. **E-mail :** [support@anymodel.bot](mailto:support@anymodel.bot), avec « Security » dans l'objet.

Veuillez inclure :

- La version d'AnyModelBot (Paramètres → À propos), le système d'exploitation et l'architecture, ainsi que le mode d'exécution (desktop / ligne de commande / Docker)
- La nature du problème et son impact potentiel
- Les étapes pour reproduire le problème ou une preuve de concept
- Les journaux ou diagnostics utiles (Paramètres → Dépannage → « Copier le diagnostic » supprime clés et jetons)

## Suite du processus

1. Nous accusons réception de votre signalement.
2. Nous analysons le problème et vous tenons informé de notre évaluation.
3. Nous convenons avec vous d'un correctif et d'un calendrier de divulgation, puis publions une version corrigée.
4. Avec votre accord, nous vous créditons dans les notes de version.

## Versions prises en charge

Les correctifs de sécurité sont intégrés dans la dernière version publiée. Vérifiez que le problème existe toujours dans la [dernière version](https://github.com/modelflare-ai/AnyModelBot/releases) avant de le signaler.

## Périmètre

Inclus dans le périmètre : l'application AnyModelBot de ce dépôt (application desktop, ligne de commande, image Docker construite depuis ce dépôt) et sa console locale.

Hors périmètre ici : les services propres à Modelflare (à signaler via le [Modelflare Trust Center](https://modelflare.dev/trust?utm_source=anymodelbot&utm_campaign=amb_readme)), les plateformes WeChat et Feishu, ainsi que les projets amont tels que magpie, DeepSeek Harness et Cua — veuillez contacter leurs mainteneurs respectifs. En cas de doute, écrivez-nous et nous transmettrons.
