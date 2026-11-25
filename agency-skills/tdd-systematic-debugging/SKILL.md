---
name: tdd-systematic-debugging
description: Protocole d'ingénierie strict inspiré d'obra/superpowers — patchs ciblés, cause racine et validation par tests avant fin.
category: engineering
roles: developer, qa_technical
---

# Discipline TDD & Débogage Systématique

1. **Inspecter d'abord** : dans le Studio, toujours utiliser `list_files`, `search_files` et `read_file` avant de modifier un fichier existant.
2. **Patchs chirurgicaux** : préférer `patch_file` pour modifier un fichier existant sans réécrire le reste ni casser la syntaxe ; réserver `write_file` aux nouveaux fichiers ou créations initiales.
3. **Cause racine en 4 phases** : reproduire l'échec → isoler la cause exacte → appliquer la correction minimale propre → vérifier par exécution réelle.
4. **Preuve obligatoire** : ne jamais conclure avec `finish` avant d'avoir exécuté `run_check` (`npm_test` ou `npm_typecheck`) ou vérifié l'absence d'erreurs après le dernier changement.
