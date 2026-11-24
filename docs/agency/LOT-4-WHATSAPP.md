# Lot 4 — Consentement et WhatsApp Business Cloud API officiel

## Périmètre de cette tranche

Cette livraison implémente le contrôle local du premier parcours de prospection sortante. Elle n'active pas encore une intégration de production : aucun identifiant Meta n'est fourni dans le dépôt et aucun message réel n'a été envoyé pendant le développement.

### Consentement

- Le consentement reste un historique append-only : l'accord et le retrait sont deux enregistrements distincts.
- Une autorisation est liée à un contact, un canal et une finalité exacte.
- Un nouvel accord exige une version de texte explicite ; une référence de preuve d'au moins 8 caractères et une source structurée sont exigées.
- Un retrait devient l'événement le plus récent et bloque la finalité concernée.
- L'autorisation est revérifiée immédiatement avant la soumission ; elle doit encore être le même enregistrement que celui lié au message en file.
- Le numéro du destinataire doit correspondre exactement au numéro E.164 du contact CRM.
- La référence de preuve est conservée et auditée, mais son authenticité reste à vérifier par une personne. Le code ne prétend pas vérifier un formulaire externe ou un enregistrement audio.

### Approbation et file sortante

Le parcours comporte trois étapes distinctes :

1. Un membre enregistre le consentement et demande une approbation \`send_message\` pour la ressource \`whatsapp_template\`.
2. Le propriétaire approuve le hash du payload exact. Le payload couvre canal, finalité, contact, destinataire, type, nom du modèle, langue et paramètres.
3. Un membre peut créer l'entrée de file avec cette approbation ; seul le propriétaire peut déclencher la soumission au fournisseur.

La table \`agency_whatsapp_outbox\` est isolée par organisation et référence le contact, l'approbation et le consentement. L'identifiant d'idempotence est unique par organisation. Le serveur recontrôle approbation, expiration, consentement, numéro et hash avant la soumission.

Statuts locaux :

- \`queued\` : contrôles réussis, en attente d'une action explicite du propriétaire ;
- \`sending\` : appel fournisseur en cours ;
- \`accepted\` : Meta a accepté la requête et retourné un identifiant de message ;
- \`failed\` : le fournisseur a retourné un rejet certain ;
- \`submission_unknown\` : la connexion ou le timeout ne permet pas de savoir si Meta a accepté la requête ; aucun retry automatique n'est autorisé ;
- \`cancelled\` : réservé à une annulation explicite future.

**accepted ne signifie pas sent, delivered ou read.** La réception et les statuts finaux exigent encore l'intégration des webhooks.

### Adaptateur officiel

L'adaptateur utilise uniquement l'API officielle WhatsApp Business Platform Cloud API :

- vérification du modèle auprès de \`/{WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates\` et exigence du statut \`APPROVED\` pour la langue demandée ;
- soumission de modèles à \`/{WHATSAPP_BUSINESS_PHONE_NUMBER_ID}/messages\` ;
- token transmis par l'environnement du processus, jamais écrit dans le CRM ou les événements d'audit ;
- version Graph configurable, actuellement par défaut \`v27.0\`.

Variables attendues :

- \`AGENCY_WHATSAPP_ACCESS_TOKEN\`
- \`AGENCY_WHATSAPP_PHONE_NUMBER_ID\`
- \`AGENCY_WHATSAPP_BUSINESS_ACCOUNT_ID\`
- \`AGENCY_WHATSAPP_GRAPH_VERSION\`

Le compte/token doit disposer des permissions Meta nécessaires pour lire les modèles et envoyer des messages. Le dépôt ne contient aucun secret de compte.

L'utilitaire \`verifyMetaWebhookSignature\` vérifie la signature HMAC-SHA256 de Meta sur les octets bruts du corps. Il n'est pas encore raccordé à une route webhook publique.

### API locale

- \`GET/POST /amb/api/agency/:orgId/contacts/:contactId/consents\`
- \`POST /amb/api/agency/:orgId/approvals\`
- \`POST /amb/api/agency/:orgId/approvals/:approvalId/decision\`
- \`GET/POST /amb/api/agency/:orgId/whatsapp/outbox\`
- \`POST /amb/api/agency/:orgId/whatsapp/outbox/:messageId/send\`

Les changements sont protégés par le contrôle anti-cross-site déjà présent sur l'API locale.

### Limites ouvertes avant de fermer le Lot 4

1. Route callback HTTPS publiquement accessible pour le challenge Meta et les webhooks WhatsApp.
2. Validation HMAC sur le corps brut dans la route, puis déduplication persistante des événements et mise à jour des statuts message.
3. Tests de simulation des webhooks entrants, doublons, statuts et retraits reçus via WhatsApp.
4. Stockage du token dans le trousseau sécurisé du système plutôt que dans l'environnement du processus.
5. Interface utilisateur pour revoir les preuves, préparer les demandes d'approbation et examiner les messages en file.
6. Simulation réelle avec un numéro de test Meta, sans utiliser un compte ou numéro de production.
7. Exécution du typecheck, des tests et du build. Ces commandes n'ont pas été exécutées pendant cette tranche.

## Références officielles Meta

- [WhatsApp Business Platform — aperçu et Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview/)
- [WhatsApp Business Account — lecture des modèles](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/)
- [Webhook Meta — signature X-Hub-Signature-256](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/)
