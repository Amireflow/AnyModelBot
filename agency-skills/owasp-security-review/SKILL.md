---
name: owasp-security-review
description: Revue AppSec stricte (OWASP Top 10) — zéro secret exposé, anti-XSS, anti-SSRF et confinement fichiers.
category: qa
roles: qa_security, developer, architect
---

# Revue Sécurité AppSec (OWASP Top 10)

1. **Zéro secret en dur** : proscrire toute clé API, mot de passe, token Bearer ou fichier `.env` dans le workspace livré.
2. **Anti-injection & XSS** : ne jamais injecter de HTML non échappé via `innerHTML` ou requêtes SQL concaténées ; privilégier `textContent` / échappement strict et requêtes paramétrées.
3. **Confinement & SSRF** : bloquer tout accès hors racine projet (`..`, liens symboliques) et toute requête vers des IP privées/loopback.
4. **Correctifs actionnables** : chaque vulnérabilité relevée doit préciser fichier, risque et remédiation exacte.
