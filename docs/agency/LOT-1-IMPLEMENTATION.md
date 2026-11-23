# Lot 1 — Agency Core : compte rendu d'implémentation

## Portée de cette livraison

Le socle métier initial est ajouté sous `src/agency/`, sans modifier le runtime personnel, les conversations, les agents ou les tables SQLite existantes d'AnyModelBot.

### Capacités ajoutées

- organisation et rôles de membres ;
- stockage SQLite métier séparé, migrations versionnées de départ, clés étrangères et permissions de fichier restrictives ;
- entreprises, contacts et prospects ;
- transitions de pipeline contrôlées ;
- éléments de preuve avec URL source, date, empreinte et niveau de confiance ;
- registre de consentement par contact, canal et finalité ;
- demandes d'approbation liées à une empreinte de payload ;
- décision des actions critiques réservée au rôle propriétaire ;
- journal append-only avec chaîne SHA-256 et vérificateur d'intégrité ;
- tests unitaires couvrant les cas nominaux, les accès, les transitions, les consentements et les approbations.

## Limites explicitement conservées

- Ce lot ne connecte pas encore l'Agency Core à l'interface AnyModelBot ni à une API publique.
- Le stockage livré est un adaptateur SQLite local destiné au démarrage et aux tests du noyau. Il ne constitue pas encore le Control Plane PostgreSQL multi-utilisateur prévu dans l'architecture cible.
- Les rôles sont des contrôles métier au niveau service ; une future API devra toujours authentifier l'acteur et ne jamais accepter un rôle envoyé par le navigateur.
- Le registre de consentement conserve une preuve et une portée explicites, mais ne remplace pas la validation juridique ni les règles complètes du fournisseur WhatsApp.
- Les approbations enregistrent une décision ; aucun connecteur d'envoi, paiement, signature ou déploiement n'est exécuté par ce lot.
- Le journal cryptographique rend les modifications détectables dans le flux enregistré, mais ne protège pas contre un administrateur ayant accès au fichier, aux triggers SQLite et aux sauvegardes.

## Vérifications

Les tests du lot sont dans `test/agency-core.unit.test.ts`. Le résultat CI doit être consulté sur le commit de cette livraison avant de considérer le lot validé. Aucune exécution locale n'est revendiquée par ce document.

## Étape suivante

Lot 2 — CRM : enrichir les fonctions de recherche, filtres, doublons, historique commercial, pagination et API/interface utilisateur en s'appuyant sur les services métier déjà isolés.


## Correctifs de durcissement ajoutés dans la livraison CRM suivante

Le socle a reçu des protections complémentaires :

- contrôles SQLite empêchant de relier un contact, un prospect, une preuve ou un consentement à des entités d'une autre organisation ;
- validation runtime du statut de consentement, y compris lorsque les données viennent d'une requête HTTP ;
- validation des payloads d'approbation : JSON fini uniquement, sans cycles, avec limites de profondeur et de taille ;
- détection des doublons d'entreprises exécutée dans la transaction d'écriture afin d'éviter une course entre requêtes concurrentes.

La validation complète de ces protections dépend toujours d'une exécution du workflow CI sur GitHub Actions.
