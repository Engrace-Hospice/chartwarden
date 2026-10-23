# G.2-B — protocole staging (aucune écriture production)

**Statut actuel : NOT RUN sur staging.** Le `/version` observé côté mobile annonçait `2c73d8855893e0e0942d4dc54dcecac7b0d71685`, différent du HEAD de cette branche. Ne pas attribuer le code local à cette instance. Les tests live locaux utilisent un conteneur PostgreSQL privé et des patients synthétiques ; ils ne remplacent pas les essais HTTP autorisés d'un déploiement.

## Préparation

1. Déployer le commit final sur une instance staging isolée, appliquer les migrations existantes dont 0373 (aucune nouvelle migration G.2-B), relever `/version`, commit/image et OpenAPI servi. Comparer SHA-256 du document servi à `docs/api/openapi.json` du même commit. Si l'instance ne sert pas son OpenAPI, exporter celui du commit image par le script normal et consigner cette limite.
2. Créer uniquement des dossiers synthétiques dans deux organisations, avec admissions active/on-hold, terminée live, terminée death, pending for-cause et transfer-in pending ; disposer d'un signataire autorisé distinct du filer, d'un filer, d'un intake clinician, d'un médecin au mauvais rôle et d'un utilisateur hors organisation. Ne stocker aucun mot de passe/jeton ici.
3. Utiliser le client d'authentification/CSRF réel et les permissions effectives ; enregistrer status, correlation ID expurgé, ID opaque de scénario et version d'API. Ne pas enregistrer noms, narratifs, cookies, tokens ou PHI dans les captures.

| Scénario | Lecture → écriture → relecture attendue | État |
|---|---|---|
| Réadmission | plan admissible → POST avec `readmittedFromAdmissionId` → GET nouveau ID avec lien exact, GET ancien inchangé, périodes/NOE cohérentes | NOT RUN |
| Admission historique/directe | GET rend `readmittedFromAdmissionId:null` ; aucune valeur inventée | NOT RUN |
| Refus readmission | décès, autre patient/org, admission ouverte ou plus récente, 404 non révélateur | NOT RUN |
| For-cause | POST → admission active et événement pending → GET `/discharges/:id/cosign-context` ID/version exacts → cosign avec version → événement terminé et admission relue | NOT RUN |
| Decline | événement pending → contexte versionné → decline → événement voided et admission toujours active | NOT RUN |
| Filer / rôles / scope | filer-self, mauvais rôle, hors org et hors portée refusés ; version du contexte non divulguée | NOT RUN |
| Concurrence | `ifVersion` périmée → 409 ; relire puis décision explicite ; pas de retry automatique | NOT RUN |
| Revocation, transfer-out/in, correction détail | POST autorisé → GET événement/admission/périodes/worklist ; refus 403/404/409/422 | NOT RUN |
| Death | NE PAS activer sur mobile sans moteur d'éligibilité certificateur ; vérifier seulement la non-régression web autorisée avec une preuve clinique synthétique approuvée | BLOCKED_BACKEND |
| Sortie live avec ordre | NE PAS activer sur mobile sans référence vérifiée d'un ordre signé serveur lié au patient/admission/date | BLOCKED_BACKEND |
| Timeout / réponse perdue | interrompre après envoi, lire les données accessibles avant toute nouvelle écriture ; aucune double admission/discharge | NOT RUN |
| Effets aval | inspecter outbox puis M16 bereavement, M22 document, M23 NOE/NOTR/claim selon l'événement ; ne pas assimiler un enregistrement à une livraison aval | NOT RUN |

Une ligne passe à `READY_FOR_MOBILE_QA` seulement après preuve GET protégé + POST autorisé + relecture DB/HTTP + effets et refus d'accès sur le **même build staging**. Une lecture de code ou un 401 anonyme reste `UNVERIFIED`. Le GO production mobile requiert encore la QA iOS/Android et un gate par capacité dans G.2-C.
