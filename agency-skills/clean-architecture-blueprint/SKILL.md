---
name: clean-architecture-blueprint
description: Conception modulaire, contrats d'interface explicites, confinement des données et anti-dette technique.
category: engineering
roles: architect
---

# Architecture Logicielle Propre

1. **Spécification avant code** : définir la structure des fichiers, les modèles de données, les contrats API et les frontières de sécurité avant toute implémentation massive.
2. **Modularité & DRY** : isoler la logique métier des couches HTTP/UI ; factoriser les helpers partagés sans sur-abstraction inutile.
3. **Sécurité dès la conception** : cloisonnement par organisation/tenant, validation stricte des entrées, aucun chemin de fichier non confiné ni secret en clair.
