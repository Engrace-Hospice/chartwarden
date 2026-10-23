# G.2-B — handoff vers WardenX Mobile G.2-C

Source : branche backend `fix/admission`, basée sur `ea9802b2ef80cbf60487566cab4b71dc0154ddb2`. Le SHA final du commit, l'image staging et l'OpenAPI servi sont **non disponibles** tant que ce travail n'est pas commité/déployé. Le backend public vu auparavant annonçait `2c73d8855893e0e0942d4dc54dcecac7b0d71685` ; ne pas supposer ces corrections déployées. Comparer `/version` et le SHA-256 de `docs/api/openapi.json` avec le build cible avant de synchroniser le contrat mobile.

| Capacité | Contrat additionnel | État de livraison |
|---|---|---|
| Readmission | `GET /api/v1/admissions/:id` contient `readmittedFromAdmissionId: string \| null`, projection de la colonne DB déjà persistée. POST inchangé. | verified-code, verified-test local ; staging unverified |
| For-cause cosign/decline | `GET /api/v1/discharges/:dischargeEventId/cosign-context` sous `discharge.cosign_for_cause` + signer ABAC ; réponse `dischargeEventId`, `admissionId`, `status:"pending_cosign"`, `dischargeEventVersion:number`, `dischargeDate`. Envoyer **cette** version comme `ifVersion` ; 409 exige relecture/revue. | verified-code, verified-test local ; staging unverified |
| Revocation, transfer, corrections | DTO POST OpenAPI enrichis sans changer les requêtes ni les réponses réelles. | verified-code ; staging unverified |
| Death | Pas de candidat certifier dont l'éligibilité à date/site soit prouvée, ni revalidation serveur des credentials. | BLOCKED_BACKEND |
| Sorties live avec ordre | Les champs legacy web sont conservés ; aucune référence à preuve de signature serveur liée à l'admission n'est validée pour mobile. | BLOCKED_BACKEND |

Exemple synthétique de lecture cosign :

```json
{"dischargeEventId":"synthetic-discharge-id","admissionId":"synthetic-admission-id","status":"pending_cosign","dischargeEventVersion":1,"dischargeDate":"2026-10-18"}
```

Exemple synthétique du nouveau champ d'admission : `"readmittedFromAdmissionId":"synthetic-prior-admission-id"` pour un lien enregistré ; `null` pour une admission historique, directe ou sans lien connu. Ne jamais remplacer `null` par l'épisode le plus récent. `id`, `state`, `version` conservent leur sens ancien. Le worklist `awaiting_cosign` n'expose toujours pas la version ; ouvrir le contexte par l'ID d'événement de cette ligne.

Pour une réponse perdue au POST admission, ne pas retenter automatiquement. Chercher les admissions accessibles du patient, relire le lien sur chaque candidate, et faire résoudre manuellement si la portée d'accès ne permet pas de conclure. Le mobile doit garder un gate **par capacité et par build vérifié** ; ce handoff ne justifie pas l'ouverture du gate global. Le protocole de preuve est dans `pr-g2b-staging-qa.md`.
