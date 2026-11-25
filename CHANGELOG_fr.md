# Journal des modifications

[简体中文](./CHANGELOG.md) | [English](./CHANGELOG_en.md) | Français | [日本語](./CHANGELOG_ja.md) | [한국어](./CHANGELOG_ko.md) | [Русский](./CHANGELOG_ru.md) | [Español](./CHANGELOG_es.md) | [Português (Brasil)](./CHANGELOG_pt.md) | [Türkçe](./CHANGELOG_tr.md)

Ce journal récapitule les changements visibles dans l’application. Pour les versions antérieures, consultez les [publications GitHub](https://github.com/modelflare-ai/AnyModelBot/releases).

## 0.1.47 - 2026-11-23

### Nouveautés

- **Utiliser des images comme références pour la génération :** lorsque vous êtes connecté à Modelflare et ajoutez des images dans une conversation individuelle avec un bot, un interrupteur « Utiliser comme références pour la génération d’images » apparaît à côté du nombre de pièces jointes. Il est désactivé par défaut. Activez-le pour utiliser les images de ce message comme références, dans leur ordre d’affichage. Le modèle sélectionné en bas à droite génère alors l’image et renvoie le résultat dans la même conversation. Le simple ajout d’images ne déclenche jamais une génération payante. Si le modèle ne prend pas en charge cette fonction, si ses capacités ne peuvent pas encore être vérifiées ou si les images dépassent ses limites de nombre, de format ou de taille, un message au-dessus de la zone de saisie explique la situation et propose un lien « Changer de modèle » qui ouvre le sélecteur habituel. La confirmation du coût fonctionne comme avant (à chaque fois ou lorsque l’estimation dépasse 0,50 $), et un résultat non confirmé n’est jamais relancé automatiquement. Cette fonction nécessite les informations de capacité des modèles fournies par Modelflare ; aucune image n’est envoyée lorsque ces capacités ne peuvent pas être vérifiées. Les clés API personnalisées ne sont pas encore prises en charge.
- **Choisir les modèles de génération d’images dans le sélecteur :** lorsque vous êtes connecté, le sélecteur de modèles en bas à droite affiche également les modèles de génération d’images accessibles avec votre compte. Sélectionnez-en un, décrivez l’image souhaitée et lancez la génération sans passer par un modèle de conversation.

### Améliorations et corrections

- **La génération utilise uniquement le modèle sélectionné :** lorsque vous êtes connecté, une demande de génération d’image formulée en langage naturel utilise exclusivement le modèle choisi en bas à droite. Si celui-ci ne peut pas générer d’images ou si ses capacités ne peuvent pas être vérifiées, le bot l’indique et vous demande de changer de modèle, au lieu d’utiliser un autre modèle d’image par défaut. Le réglage « Modèle d’image par défaut » est masqué lorsque vous êtes connecté. Rien ne change lorsque vous utilisez uniquement une clé API personnalisée.
