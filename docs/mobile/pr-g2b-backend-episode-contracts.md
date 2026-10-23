# G.2-B — audit des contrats de fin d'épisode

Point de départ : branche `fix/admission`, HEAD `ea9802b2ef80cbf60487566cab4b71dc0154ddb2`, arbre propre. Le build vu par mobile annonçait `2c73d8855893e0e0942d4dc54dcecac7b0d71685` ; aucune équivalence de déploiement n'est supposée. `apps/web` consomme les mêmes routes M6 et ses requêtes restent la contrainte de compatibilité.

| Route / surface web | Permission et garde | Requête, DTO et persistance avant correction | Relecture / écart | État initial |
|---|---|---|---|---|
| `POST /admissions`, Readmission web | `admission.create`, `admission.scope` ou intake/site scope | `readmittedFromAdmissionId` optionnel, validé même org/patient et épisode non décédé ; colonne `admission.readmitted_from_admission_id` créée par migration 0373, nullable et indexée | `GET /admissions/:id` ne projetait pas la colonne | verified-code ; staging unverified |
| `GET /admissions/:id`, Admission Detail web | `admission.read` + `admission.scope` | `id/state/version` et détails historiques | Ajouter un champ nullable de la même ligne DB ; anciens épisodes restent `null` | verified-code ; staging unverified |
| `GET /discharges/worklist?bucket=awaiting_cosign`, hub web | `admission.read`, `discharge.cosign_for_cause`, portée de liste | `dischargeEventId` mais pas `DE.version` ; le bucket ne prouve pas à lui seul la capacité individuelle du signataire | Une lecture spécifique protégée doit donner la version courante | verified-code ; staging unverified |
| `POST /discharges/:id/cosign-for-cause` et `/decline-for-cause`, web cosign | `discharge.cosign_for_cause` + `discharge.is_order_signer` ; service vérifie `ifVersion`, séparation filer/cosigner | `discharge_event.version` existe ; pending préserve admission active ; seule cosign valide achève | GET versionné manquant | verified-code ; staging unverified |
| `POST /admissions/:id/discharge` reason death, Death web | `discharge.death` + admission scope | M40 ID choisi par lookup web ; le service vérifie sa présence, pas des credentials à date | Aucun moteur d'éligibilité certificateur prouvé ; ne pas qualifier une liste de certifiée | blocked-dependency |
| `POST /admissions/:id/discharge` raisons live, web workflow | Permission dérivée du motif + admission scope | `dischargeOrder` accepte des champs signataire/date fournis par client puis vérifie capacité M6 ; pas de preuve de signature M11/M22 liée vérifiée | Référence de preuve serveur et cérémonie manquantes pour mobile | blocked-dependency |
| Transfer-in/out, revocation, death, discharge-details | Permissions M6 spécifiques + scope ; RLS org | Colonnes/événements existants ; DTO POST OpenAPI partiels | Tests de persistance et staging nécessaires ; conserver les contrats web | verified-code ; staging unverified |

Source des faits : `admission-route-service-db.ts`, `readmission-service-db.ts`, `discharge-worklist-service-db.ts`, `routes/*typebox.ts`, `physician-signer-checks.ts`, `physician-authority.ts`, migration 0373, consumers `apps/web/src/modules/06-admission`. La présente matrice sépare lecture de code, test automatisé et preuve de staging ; un HTTP 401 sans session ne prouve aucune écriture.

## Corrections de cette branche

- `GET /api/v1/admissions/:id` restitue `readmittedFromAdmissionId: string | null` depuis `admission.readmitted_from_admission_id`. La création et ses gardes n'ont pas changé. `null` signifie qu'aucun lien n'a été enregistré, y compris sur une admission historique ; il ne signifie pas qu'aucune élection antérieure n'a existé. Migration 0373 couvre déjà colonne, FK nullable et index : **aucune nouvelle migration** ni backfill.
- `GET /api/v1/discharges/:id/cosign-context` est une lecture additive. Elle reprend `discharge.cosign_for_cause` et `discharge.is_order_signer` des deux mutations ; le service lit sous RLS et vérifie l'organisation, l'état `pending_cosign` et la séparation filer/cosigner. Réponse : `dischargeEventId`, `admissionId`, `status`, `dischargeEventVersion` (source : **discharge_event.version**), `dischargeDate`. Elle répond 404 pour un événement absent, d'un autre tenant, achevé ou pour le filer. Une version périmée reste refusée par le POST avec 409. Le worklist et `GET /discharge-order` ne divulguent pas cette version à leur audience plus large.
- Le test live a révélé que `decline-for-cause` écrivait `medical_director_membership_id` sans `cosigned_at`, en violation de `discharge_event_cosign_pair_chk` : le refus échouait avant persistance. La mutation n'écrit plus d'identité de cosignataire lors d'un refus. L'auteur reste capturé par l'audit M4 et le motif par la ligne auditée. La relecture DB vérifie `voided`, les deux champs de cosignature à `null` et l'admission toujours active.
- OpenAPI décrit maintenant les réponses réelles de revocation, transfer-out, transfer-in, discharge, cosign et decline. Les champs historiques `id/state/version` et les bodies web restent identiques. `discharge` ajoute `requiresMedicalDirectorCosign` et `reason` ; `transfer-in` ajoute `currentElectionPeriodSequence`. Le client TypeScript web est régénéré.

Exemples synthétiques, sans PHI :

```json
{"id":"new-admission-id","state":"pending","version":0,"patientId":"test-patient-id","readmittedFromAdmissionId":"prior-admission-id","activationGate":{"ready":false,"missing":["election_signed"]}}
```

```json
{"dischargeEventId":"test-discharge-id","admissionId":"test-admission-id","status":"pending_cosign","dischargeEventVersion":1,"dischargeDate":"2026-10-18"}
```

Les exemples montrent les champs pertinents, pas un dossier réel ni tous les détails facultatifs du GET admission. Le premier lien est `null` pour les anciens dossiers sans source enregistrée. La version du second exemple est illustrative ; le mobile doit lire la valeur courante avant chaque décision.

## Dépendances non levées

- **Death : blocked-dependency.** Le web choisit un ID via le lookup M40, mais M6 n'établit aujourd'hui que la présence de `deathCertifierId`. Le booléen interne `deathCertifierCredentialed` est dérivé de cette présence. Le lookup M40 et `physician-signers` ne prouvent pas la capacité légale de prononcer/certifier à la date et sur le site. Il faut définir des faits et règles autoritatifs, puis revalider au POST avant de publier une liste `eligible`. Cette PR ne qualifie aucune personne par déduction.
- **Sorties live avec ordre : blocked-dependency.** M6 accepte toujours le body historique web `dischargeOrder` et vérifie date/capacité, mais `signedByUserId`/`signedAt` viennent du client ; M22 rend ensuite un PDF à partir de ces faits. M11 possède des signatures d'ordres, sans liaison M6 validée ici entre un ordre signé précis, l'admission et le motif de discharge. Une référence à une preuve serveur vérifiée et sa cérémonie de signature restent nécessaires pour le mobile. Aucune règle de date, raison ou permission n'a été relâchée.
- **Résultat inconnu du POST admission :** conserver la création non idempotente. Après timeout, ne pas rejouer ; rechercher les admissions accessibles du patient, lire chacune pour le lien exact, puis demander une résolution opérateur si aucune lecture fiable n'est possible. Un GET non accessible ne prouve pas l'absence de création.

Les anciennes requêtes web restent valides. Aucun changement arbitraire de transition clinique, d'outbox, de RBAC/ABAC/RLS, de schéma ou de période de bénéfice n'a été introduit ; la transition `decline → voided` existante peut maintenant aboutir en DB. Déploiement/rollback : changements de code et d'OpenAPI seulement ; retour au code précédent retire les nouveaux champs/route et réintroduit le défaut du refus, sans rollback DB. Les clients mobiles doivent garder la capacité fermée tant que la version cible ne fournit pas ces réponses et qu'une preuve staging n'existe pas.

Preuve locale après correction : `verified-test` pour le lien de réadmission (relecture DB, ancien épisode, autre tenant) et le contexte de cosignature (version DB de l'événement, filer refusé, autre tenant refusé, stale → 409, decline → voided relu). `verified-staging` : **aucune capacité**. Les tests web et les limites des gates sont détaillés dans `pr-g2b-web-regression-report.md`.
