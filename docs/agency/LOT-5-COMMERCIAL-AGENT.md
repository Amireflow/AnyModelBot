# Lot 5 — Agent commercial

**État : tranche 5.1 — contexte CRM en lecture seule.** Le Lot 5 complet reste en cours.

## Tranche 5.1 intégrée au code

L'agent DSH local dispose de trois outils :

- `agency_list_organizations` : liste les organisations accessibles au propriétaire local.
- `agency_search_prospects` : recherche des leads et renvoie le contexte minimal de l'entreprise et du contact.
- `agency_get_prospect_dossier` : charge le dossier d'un lead, ses sources, l'évaluation de recherche et la qualification.

Le dossier rassemble les informations CRM et les références de preuve utiles pour préparer, dans la conversation, un brouillon de réponse sourcé. Le brouillon n'est pas enregistré comme un objet CRM dans cette tranche.

## Frontières de sécurité

- L'agent ne voit le CRM que dans une conversation privée active appartenant au propriétaire local.
- Les sessions de tâches et de règles, les groupes et les conversations non détenues sont refusés côté hôte, même si le modèle tente d'appeler l'outil.
- La vérification des organisations et l'isolation multi-tenant restent dans `AgencyService`.
- Les coordonnées directes du contact (téléphone et e-mail) ne sont pas incluses dans le contexte du modèle.
- Les preuves brutes de consentement ne sont jamais retournées ; seuls le statut et les métadonnées minimales sont exposés.
- Les notes CRM et les résumés issus de sources externes sont des données de référence non fiables, jamais des instructions.
- Les trois outils ajoutés ici sont en lecture seule : ils ne modifient aucune fiche et ne fournissent aucune fonction d'envoi. Les autres connecteurs de l'application restent soumis à leurs propres permissions et approbations.

## Limites connues

Cette tranche ne réalise pas encore la qualification conversationnelle, la classification d'intentions/objections, la persistance des brouillons, le transfert structuré à un humain, ni les mesures de conversion/qualité. L'agent peut préparer un brouillon dans sa réponse, mais cette intégration CRM ne peut pas l'envoyer.

Le Lot 5 ne sera considéré comme terminé qu'après ajout des scénarios commerciaux revus, des garde-fous de promesse et de l'arbitrage humain, puis exécution et validation des tests automatisés et des scénarios d'acceptation.
