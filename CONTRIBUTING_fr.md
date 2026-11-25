# Guide de contribution

[简体中文](./CONTRIBUTING.md) | [English](./CONTRIBUTING_en.md) | Français | [日本語](./CONTRIBUTING_ja.md) | [한국어](./CONTRIBUTING_ko.md) | [Русский](./CONTRIBUTING_ru.md) | [Español](./CONTRIBUTING_es.md) | [Português (Brasil)](./CONTRIBUTING_pt.md) | [Türkçe](./CONTRIBUTING_tr.md)

Merci de votre intérêt pour AnyModelBot. Toute contribution est la bienvenue : signalements de bugs, correctifs, documentation et traductions.

## Avant de commencer

1. Consultez le [guide de développement](./docs/development_fr.md) pour installer les dépendances, compiler la passerelle intégrée et exécuter les tests.
2. Vérifiez les [issues](https://github.com/modelflare-ai/AnyModelBot/issues) et les [discussions](https://github.com/modelflare-ai/AnyModelBot/discussions) existantes. Pour une modification importante, ouvrez d'abord une issue afin de convenir de l'approche.
3. Les tickets étiquetés [`good first issue`](https://github.com/modelflare-ai/AnyModelBot/labels/good%20first%20issue) sont un bon point d'entrée.

## Lancer et vérifier en local

```bash
npm install
npm run setup          # télécharge et compile la passerelle intégrée (Node.js 22.13+ et Go 1.26.8+)
npm run electron:dev   # application desktop en mode développement
npm run typecheck
npm test
npm run docs:check
npm run i18n:check
```

## Règles de soumission

- Travaillez sur la branche `master` selon les conventions du dépôt ou ouvrez une pull request claire contre `master` (description du changement, raison et vérifications exécutées).
- Conservez les modifications ciblées : gardez la logique métier pure dans `src/domain/`, le stockage dans `src/store/`, et respectez les limites entre processus principal et interface.
- Si vous ajoutez des chaînes d'interface ou côté serveur, mettez à jour les dictionnaires linguistiques concernés et vérifiez avec `npm run i18n:check`.
- N'ajoutez ni secrets, ni clés API, ni fichiers locaux (`data/`, `.env`, jetons) dans un commit.

## Signaler une vulnérabilité

Ne publiez **jamais** de vulnérabilité de sécurité dans une issue ou pull request publique. Suivez la procédure privée décrite dans [SECURITY_fr.md](./SECURITY_fr.md).

## Licence

En contribuant à ce dépôt, vous acceptez que vos contributions soient publiées sous la licence [MIT](./LICENSE).
