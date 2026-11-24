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

Le callback public \`GET/POST /webhooks/whatsapp/meta\` est raccordé au serveur local. GET vérifie le challenge par verify token ; POST vérifie HMAC-SHA256 sur le corps brut avant parsing, puis traite les événements dédupliqués et refuse les numéros non configurés.

### API locale

- \`GET/POST /amb/api/agency/:orgId/contacts/:contactId/consents\`
- \`POST /amb/api/agency/:orgId/approvals\`
- \`POST /amb/api/agency/:orgId/approvals/:approvalId/decision\`
- \`GET/PUT/DELETE /amb/api/agency/:orgId/whatsapp/config\`
- \`GET/POST /amb/api/agency/:orgId/whatsapp/outbox\`
- \`POST /amb/api/agency/:orgId/whatsapp/outbox/:messageId/send\`

Les changements sont protégés par le contrôle anti-cross-site déjà présent sur l'API locale.

### Limites ouvertes avant de fermer le Lot 4

1. Déployer ou exposer le callback sur un hôte HTTPS public avec certificat TLS valide, puis valider le challenge Meta réel.
2. Ajouter une interface de revue des preuves de consentement, demandes d'approbation, messages sortants et statuts de livraison. Le panneau de configuration des credentials est déjà disponible dans le CRM.
3. Ajouter les reçus Meta réels et tester sur un numéro de test, sans compte ou numéro de production.
4. Exécuter typecheck, tests, build et simulation complète avant de fermer le Lot 4. Ces commandes n'ont pas été exécutées pendant cette tranche.

## Références officielles Meta

- [WhatsApp Business Platform — aperçu et Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview/)
- [WhatsApp Business Account — lecture des modèles](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/)
- [Webhook Meta — signature X-Hub-Signature-256](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/)


## Variables complémentaires pour le callback

- `AGENCY_WHATSAPP_ORGANIZATION_ID` : organisation locale qui reçoit les événements du numéro configuré ;
- `AGENCY_WHATSAPP_APP_SECRET` : App Secret Meta utilisé pour la signature HMAC ;
- `AGENCY_WHATSAPP_VERIFY_TOKEN` : secret choisi par l'exploitant et configuré à l'identique dans Meta.

Le callback n'est pas exposé derrière l'authentification par cookie de la console, mais il exige séparément le verify token pour GET et l'App Secret pour POST. La protection contre les connexions de processus agents est conservée. Les secrets sont capturés en mémoire au démarrage, enregistrés pour la redaction des logs, puis retirés de `process.env` afin de ne pas être hérités directement par les sous-processus. Il faut publier le callback derrière HTTPS avant de l'enregistrer dans Meta. Une instance locale est associée à une organisation et à un numéro WhatsApp configurés ; une future plateforme multi-organisation devra remplacer cette correspondance par une configuration provider dédiée par tenant.


## Coffre sécurisé Electron — tranche d'intégration

L'application Electron peut maintenant stocker la configuration WhatsApp dans `whatsapp-secrets.json`. Le fichier contient uniquement le ciphertext d'Electron `safeStorage`, écrit de façon atomique avec permissions restreintes ; aucun token ou App Secret n'est écrit dans SQLite ou un fichier de configuration lisible. macOS s'appuie sur Keychain, Windows sur DPAPI et Linux exige un backend Secret Service reconnu. Le backend Linux `basic_text` ou inconnu est refusé ; aucun repli plaintext n'est accepté.

Le coffre utilise les méthodes asynchrones `isAsyncEncryptionAvailable`, `encryptStringAsync` et `decryptStringAsync` lorsqu'elles sont disponibles. Si Electron signale `shouldReEncrypt`, le code relit le ciphertext avec la nouvelle clé avant de réécrire le fichier chiffré. Le chargement est paresseux et une erreur de déverrouillage bloque l'envoi ; elle ne réactive pas silencieusement les variables d'environnement.

L'API locale de configuration est :
- `GET /amb/api/agency/:orgId/whatsapp/config` : état, backend, présence du coffre, numéro non secret ; aucun secret n'est retourné ;
- `PUT /amb/api/agency/:orgId/whatsapp/config` : remplace les credentials dans le coffre Electron ;
- `DELETE /amb/api/agency/:orgId/whatsapp/config` : efface explicitement le coffre local, même si la clé système est verrouillée.

Le panneau de configuration est intégré à l'écran CRM et traduit dans les huit langues disponibles. L'interface ne relit jamais les valeurs secrètes après sauvegarde ; le remplacement nécessite de saisir à nouveau les valeurs. Les credentials sont liés à une organisation précise et un seul jeu de credentials peut être conservé par nœud local. CLI/Docker utilisent les variables d'environnement, capturées au démarrage, enregistrées pour la redaction des logs puis retirées de `process.env` avant le lancement des sous-processus.

### Interface CRM — revue, consentement et envoi

Le CRM présente désormais :
- l'historique append-only des consentements WhatsApp par contact, avec source, référence de preuve et version du texte ;
- un formulaire explicite d'octroi ou de retrait, qui exige une vraie référence de preuve saisie par l'opérateur ;
- la préparation d'un modèle Meta approuvé et la soumission de son payload exact pour approbation ;
- la liste des demandes d'approbation et les boutons d'approbation/refus réservés au propriétaire ;
- la création explicite d'une entrée outbox à partir d'une approbation ;
- une confirmation distincte avant l'appel Cloud API, puis l'état local et les statuts Meta disponibles.

Une nouvelle route `GET /amb/api/agency/:orgId/approvals` expose les approbations de l'organisation, avec limite côté service et isolation par tenant. Le panneau actualise les listes périodiquement. Les règles de sécurité restent côté service : approbation owner-only, hash du payload, consentement toujours actif, numéro du contact inchangé et refus du retry en état ambigu.

**Limite :** l'exposition HTTPS publique du webhook, l'essai avec un numéro Meta de test et la validation d'intégration restent à faire. Aucun message réel n'a été envoyé pendant cette tranche.
