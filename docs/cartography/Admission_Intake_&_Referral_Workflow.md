# Audit Codex — Admission & Intake / Referral Workflow

Date d'audit: 2026-08-27  
Source de verite: code execute du repository, pas les specs.  
Portee inspectee: M6 backend/domain/DB/frontend/tests, recherches globales `referral`, `intake`, `admission`, `election`, `CTI`, `notice of rights`, `referring`, `referral source/status`, `convert referral`, `create admission`, et wiring M5/M7/M9/M11/M22/M29.

## A. What exists today

### Backend M6 reel

M6 Admission existe comme module backend Drizzle/Fastify reel sous `apps/backend/src/modules/06-admission`. Les routes principales sont dans `routes/admission-routes.ts`, les schemas request/response dans `routes/admission-typebox.ts`, le service production dans `admission-route-service-db.ts`, les state machines dans `state-machines/*`, les gates d'activation dans `intake/activation-gate.ts`, et les evenements outbox dans `events-by-m6.ts`.

Fonctionnel aujourd'hui:

| Fonction | Etat reel |
|---|---|
| Creer un referral via API | Oui: `POST /api/v1/referrals` |
| Lister/lire les referrals via API | Oui: `GET /api/v1/referrals`, `GET /api/v1/referrals/:id` |
| Triage referral | Oui: `POST /api/v1/referrals/:id/triage` |
| Accepter referral et creer admission draft/pending | Oui: `POST /api/v1/referrals/:id/accept` |
| Decliner referral via API | Oui: `POST /api/v1/referrals/:id/decline` |
| Creer admission sans referral | Oui: `POST /api/v1/admissions` |
| Lire census/detail admission | Oui |
| NOR acknowledge | Oui |
| Election statement draft/sign | Oui via API |
| CTI draft/sign hospice MD/sign attending | Oui via API |
| F2F schedule/complete/attest/override | Oui via API, mais tres partiel sur les donnees |
| Activation admission | Oui, avec gate backend partiel |
| Hold/resume/discharge/transfer/revocation/LOC | Oui hors coeur intake |
| Compliance windows | Oui |

### Referral Inbox reel

Le concept "Referral Inbox" existe reellement cote frontend et backend:

- Frontend route: `/referrals`
- Screen: `apps/web/src/modules/06-admission/referral-inbox.tsx`
- Detail: `/referrals/:id`, `referral-detail.tsx`
- API consommee: `GET /api/v1/referrals`, `GET /api/v1/referrals/{id}`, `POST /api/v1/referrals/{id}/triage`, `POST /api/v1/referrals/{id}/accept`

Mais l'inbox actuelle est minimale: elle affiche surtout `id`, `state`, `version`; elle ne montre pas les donnees d'intake utiles meme quand la table les prevoit partiellement.

### Creation referral

Creation API disponible:

`POST /api/v1/referrals`

Le schema route accepte notamment:

- `source`
- `receivedAt`
- `receivingUserId`
- `patientNameAtReceipt`
- `patientDobAtReceipt`
- `referringDiagnosisText`
- `referrerName`
- `referrerOrganization`
- `referrerPhone`
- `externalReferralId`

Mais le service production `createReferral` ne persiste effectivement que:

- `organizationId`
- `patientNameAtReceipt`
- `sourceChannel` derive de `source`
- valeurs DB par defaut: `status='received'`, `receivedAt=now()`, timestamps/version

Les champs route `receivedAt`, `receivingUserId`, DOB, diagnosis, referrer, organisation, telephone, external id sont valides par l'API mais jetes par le service production.

### Admission directe

L'ecran `/admissions/new` existe et appelle:

`POST /api/v1/admissions`

Le flow direct intake demande:

- `patientId`
- `hospiceMedicalDirectorId`
- optional `referralId`
- optional `attendingPhysicianId`
- optional provider/location/transfer metadata selon schema

Il cree une admission `pending`, seed une election period sequence 1, et cree un draft CTI sauf cas `transfer_in`.

### Events M6 publies

M6 declare et publie des evenements outbox reels, dont:

- `m6.referral.received`
- `m6.referral.triaged`
- `m6.referral.accepted`
- `m6.referral.declined`
- `m6.referral.withdrawn`
- `m6.admission.draft_created`
- `m6.admission.activated`
- `m6.admission.on_hold`
- `m6.admission.resumed`
- `m6.admission.discharged`
- `m6.election.drafted`
- `m6.election.signed`
- `m6.election.period_started`
- `m6.election.period_ended`
- `m6.cti.drafted/signed/voided`
- `m6.f2f.scheduled/completed/attested/window_overridden`
- `m6.nor.acknowledged`
- `m6.compliance.window.*`

Le dispatcher outbox production est reel et enregistre notamment le consumer M6 pour les propositions M29 acceptees: `buildM6ProposalAcceptedConsumer`.

## B. What exists but is partially wired

### Referral data model vs service

Table `referral` contient des colonnes utiles, mais le service et le DTO expose frontend ne les utilisent presque pas.

Colonnes importantes:

- `patient_id`: lien logique vers M5, nullable.
- `referral_source_id`: lien logique vers M40, nullable.
- `referrer_name`, `referrer_phone`.
- `patient_name_at_receipt`, `patient_dob_at_receipt`.
- `referring_dx_text`, `icd10_terminal_primary`.
- `source_channel`.
- `status`.
- `rejection_reason`.
- `received_at`, `evaluated_at`, `evaluated_by`, `decided_at`.
- `external_message_ref` JSONB.
- `provider_entity_id`, `location_id`.

Partiellement cable:

| Donnee referral demandee | DB | API schema | Service prod | UI |
|---|---:|---:|---:|---:|
| referral source/channel | Partiel | Oui | `sourceChannel` seulement | Non visible utilement |
| referring physician | `referrer_name` generique | Oui | Non persiste | Non |
| facility | Non explicite, sauf source/referrer text | `referrerOrganization` | Non persiste | Non |
| contact | phone partiel | Oui | Non persiste | Non |
| patient demographics | nom/DOB partiel | Oui | nom seulement | Non detail utile |
| diagnosis/reason | Oui | Oui | Non persiste | Non |
| payer/coverage | Non | Non | Non | Non |
| documents | Non sur referral | Non | Non | Non |
| date/time received | Oui | Oui | DB `now()`, input ignore | Non |
| assigned coordinator | Non | Non | Non | Non |
| priority | Non | Non | Non | Non |
| notes | Non | triage UI envoie notes | Ignore | Champ UI non persiste |

### Referral lifecycle

Le lifecycle production reel est:

```text
received --triage eligible--> evaluated --accept--> accepted
received --triage ineligible--> rejected
received/evaluated --M29 cancel_admission applier--> withdrawn
any found referral --decline API--> rejected
```

L'enum DB contient aussi `admitted`, mais le code de conversion/acceptation ne l'utilise pas aujourd'hui. Il n'existe pas de `under_review`, `qualified`, `admission_started`, `converted`, `pending_information`, `duplicate`, `cancelled`.

Note importante: le service in-memory utilise encore dans certains tests un etat `triaged`, tandis que le service DB production utilise `evaluated`. Les tests notent eux-memes cet ecart.

### Referral Inbox UI

L'inbox est centralisee mais pauvre:

- Oui, elle affiche les referrals nouveaux et autres etats via `GET /api/v1/referrals`.
- Recherche/filtre client-side par `id` et `state`.
- Pas de creation manuelle depuis l'UI.
- Pas d'assignation/reassignation.
- Pas de mark "in progress".
- Pas de hold/pending information.
- Pas d'historique.
- Pas d'action decline/reject depuis l'UI detail, malgre endpoint backend.

### Referral -> Patient

Partiellement et dangereusement cable:

- L'UI `ReferralDetail` propose un `PatientLookupField` optionnel lors de l'acceptation.
- Si l'utilisateur selectionne un patient, `acceptReferral` utilise ce `patientId`.
- Si aucun patient n'est fourni et que le referral n'a pas de `patientId`, le service production genere un `randomUUID()` comme patientId.
- Ce UUID n'est pas cree via M5 et peut ne correspondre a aucun patient.
- M5 Patient Matching n'est pas appele.
- Aucun workflow de candidates exact/probable, confirmation utilisateur, merge/dedupe.

Conclusion: l'acceptation referral peut creer une admission liee a un patient logique inexistant, contournant M5.

### Referral -> Admission

Flow backend reel de `POST /api/v1/referrals/:id/accept`:

```text
HTTP route
  -> parse AcceptReferralSchema
  -> require permission referral.accept + referral.scope ABAC
  -> service.acceptReferral(...)
  -> withOrgContext transaction
  -> SELECT referral by id/org
  -> assert version
  -> require status == evaluated
  -> patientId = input.patientId ?? referral.patientId ?? randomUUID()
  -> check open admission for that patient
  -> INSERT admission(status=pending, referralId, patientId, diagnosis/md/provider fields)
  -> INSERT compliance windows
  -> publish m6.admission.draft_created
  -> INSERT election_period sequence=1 status=pending
  -> UPDATE referral status=accepted
  -> publish m6.referral.accepted
  -> return referral mutation + admissionId
```

Protections:

- Optimistic locking par `version`.
- Bloque accept si referral pas `evaluated`.
- Bloque si le patientId choisi a deja une admission ouverte.

Manques:

- Pas d'appel M5.
- Pas de contrainte unique `admission.referral_id`.
- Pas de protection globale "un referral -> une admission".
- Pas de passage `accepted -> admitted`.
- Direct `POST /api/v1/admissions` peut accepter un `referralId` sans mettre a jour le referral.

### Activation admission

Le gate backend production verifie:

| Gate | Etat |
|---|---|
| Notice of Rights | Implemented and enforced |
| Election Statement | Backend enforced, mais verification trop faible |
| CTI hospice MD signed | Implemented and enforced |
| CTI attending signed si attending present | Implemented and enforced |
| Signatures details/NPI/name | Backend route valide certains champs, service persiste peu |
| Attending physician | Partiel: requis seulement si present dans CTI/admission |
| M5 privacy flags | Scaffolded/not wired: state machine le prevoit, production force `privacyFlagBlock=false` |
| M9 initial assessment 48h | Scaffolded/not wired dans activation: production force `initialAssessment48hOverdue=false` |
| DON override | Scaffolded/not wired: param state machine, pas de flow production |
| Certification period dates | Partiel: schema DB existe, seed period sans vraies dates |
| F2F si applicable | Backend partiel, pas dans activation initiale |
| Care plan/assessment post-activation | Pas gate d'activation |

Point critique: `computeActivationGate` est utilise en production, mais les facts `electionSigned` sont derives de l'existence d'un row `election_statement`, pas strictement de `status='signed'`/`signedAt`. Cela peut rendre le gate election trop permissif si un draft existe.

## C. What is only scaffold/spec/mock

### In-memory workflows plus riches que production

Les suites in-memory prouvent un workflow receive -> triage -> accept -> election/NOR/CTI -> activate, mais elles ne refletent pas toujours le service Drizzle:

- `externalReferralId` idempotent en in-memory, mais non persiste par `createReferral` production.
- Etat `triaged` en in-memory vs `evaluated` en DB.
- Les champs intake/election/CTI/F2F sont souvent mieux conserves dans les objets in-memory que dans les tables production.

### UI Election/CTI/F2F

Le backend a des endpoints, mais le frontend ne fournit pas de workflow ecriture complet:

- `AdmissionDetail` permet seulement NOR et activation.
- `PatientElectionCert` est lecture seule.
- Pas d'ecran UI pour draft/sign election.
- Pas d'ecran UI pour draft/sign CTI.
- Pas d'ecran UI pour schedule/complete/attest F2F.

### M22 documents intake

M22 a des tables/ecrans DocLens/intake upload batch, mais ce n'est pas relie au referral M6:

- Pas de `referral_id` dans les documents M22.
- Les write paths M6 utilisent des `documentId` sur NOR/election/CTI/F2F/discharge mais ne rendent pas un vrai paquet documentaire d'intake.
- Les batches DocLens sont independants et peuvent etre desactives par feature flag.

### M7 care plan auto-bootstrap

M7 a un service `bootstrapCarePlan` et le catalogue M6 declare `m6.admission.activated` consommable par M7. Dans le dispatcher production inspecte, je n'ai pas trouve de consumer live qui bootstrap automatiquement M7 sur `m6.admission.activated`. Le route backend M7 existe, mais le wiring activation -> care plan automatique semble absent.

### M11 discharge cascade

M11 expose une subscription map pure pour `m6.admission.discharged`, mais dans le dispatcher production inspecte je n'ai trouve que les consumers M11 IDG et document backref. Je n'ai pas trouve de binding live pour `m11.admission-discharged-discontinue`.

## D. What is missing

Fonctions absentes pour un vrai workflow Admission & Intake:

- Creation manuelle de referral depuis UI.
- API/service complet de referral qui persiste toutes les donnees de reception.
- Referral source/facility/referring physician normalises.
- Payer/coverage au stade referral.
- Documents rattaches au referral.
- Assigned intake coordinator, priority, SLA, notes, history.
- Statuts `under_review`, `pending_information`, `qualified`, `duplicate`, `cancelled`, `converted`.
- Workflow M5 matching avant creation patient/admission.
- Confirmation utilisateur sur patient exact/probable.
- Creation M5 patient depuis referral via service/seam M5, pas UUID local.
- Contrainte DB "un referral ne peut produire qu'une admission".
- Marquage clair referral converted/admitted.
- Orchestration frontend pour election/NOR/CTI/F2F/certification.
- Activation gate complet avec M5 privacy, M9 48h, F2F/recert selon periode, DON override audite.
- Consumer M7 activation -> care plan live ou preuve equivalente.
- Consumer M11 discharge cascade live ou preuve equivalente.
- Scenario E2E complet create referral -> review -> patient match/create -> admission -> requirements -> activate.

## E. Current user journey

### Parcours referral actuel

```text
/referrals
  -> liste minimale id/state/version
  -> /referrals/:id
  -> bouton triage eligible/ineligible
  -> bouton accept
       - demande primaryDiagnosisIcd10
       - patient optional
       - attending optional
  -> backend cree admission pending
  -> navigation vers /admissions/:admissionId
  -> AdmissionDetail affiche gate
  -> user peut acknowledge NOR
  -> user tente activate
  -> bloque si election/CTI manquants
```

Le user ne peut pas finir le workflow de bout en bout depuis l'UI standard, car les actions election/CTI/F2F ne sont pas exposees comme ecriture.

### Parcours direct admission actuel

```text
/admissions
  -> /admissions/new
  -> selection/saisie patientId existant
  -> saisie hospiceMedicalDirectorId
  -> optional referralId texte
  -> POST /api/v1/admissions
  -> /admissions/:id
  -> acknowledge NOR
  -> activation bloquee tant que election/CTI ne sont pas faits via API/autre moyen
```

### Parcours API possible

Un client API peut accomplir davantage:

```text
POST /referrals
POST /referrals/:id/triage
POST /referrals/:id/accept
GET /admissions/:id/election-periods
POST /admissions/:id/election-statements
POST /election-statements/:id/sign
POST /election-periods/:id/cti
POST /cti/:id/sign-hospice-md
POST /cti/:id/sign-attending
POST /admissions/:id/nor
POST /admissions/:id/activate
```

Mais ce parcours API ne garantit pas M5 matching et ne correspond pas a une UX complete.

## F. Current data model

Diagramme texte simplifie:

```text
M5 patient
  ^ logical patient_id, no FK
  |
referral
  id PK
  organization_id
  patient_id nullable logical M5
  referral_source_id nullable logical M40
  provider_entity_id/location_id nullable
  source_channel, status
  patient_name_at_receipt, patient_dob_at_receipt
  referrer_name, referrer_phone
  referring_dx_text, icd10_terminal_primary
  received_at/evaluated_at/decided_at
  external_message_ref JSONB
  |
  | admission.referral_id nullable FK, on delete set null
  | no unique constraint on referral_id
  v
admission
  id PK
  organization_id
  patient_id logical M5
  referral_id nullable
  status
  admission_at, activated_at, held_at, discharged_at
  hospice_medical_director_id, attending_physician_id
  provider_entity_id/location_id
  transfer metadata
  |
  +-- election_period
  |     id, admission_id, sequence, status, period_kind,
  |     effective_at, scheduled_end_at, actual_end_at
  |
  +-- election_statement
  |     admission_id, election_period_id,
  |     signer_kind, status, signed_at, document_id
  |
  +-- certification_of_terminal_illness
  |     election_period_id, hospice_md_id, attending_md_id,
  |     status, hospice_md_signed_at, attending_signed_at,
  |     period_start/end, narrative, terminal_diagnosis, document_id
  |
  +-- notice_of_rights_acknowledgment
  |     admission_id unique, patient_id, signer_kind,
  |     acknowledged_at, acknowledgment_method, document_id
  |
  +-- face_to_face_encounter
  |     admission_id, election_period_id, status,
  |     scheduled/performed/attested fields, document_id
  |
  +-- compliance_window
  |     admission_id, patient_id, window_type, status,
  |     due_at, closed_at, payload
  |
  +-- level_of_care_period / discharge_event / revocation_event / transfer_event

M22 document
  patient_id/admission_id logical attachment
  no referral_id

M22 intake_upload_batch
  optional patient_id
  no referral_id/admission_id

M29 hl7_inbound_proposal
  matched_patient_id
  owner_module m5/m6
  accepted event can be consumed by M5/M6 appliers
```

Contraintes notables:

- Partial unique open admission par organization/patient pour les statuses non termines.
- Unique NOR acknowledgment par admission.
- Unique non-voided CTI par election period.
- Pas de unique `admission.referral_id`.
- RLS sur tables M6, live-testee.

## G. Current state machines

### Referral

Production DB/service:

```text
received
  --triage eligible--> evaluated
  --triage ineligible--> rejected

evaluated
  --accept--> accepted

received/evaluated
  --M29 cancel_admission accepted proposal--> withdrawn

received/evaluated/accepted?
  --decline API, depending only on existence/version--> rejected
```

Pas de `converted` reel, pas de `admission_started`, pas de `pending_information`, pas de duplicate handling.

### Admission

State machine code:

```text
referred
  --createAdmission--> pending

pending
  --acknowledgeNoticeOfRights--> notice_of_rights_acknowledged

notice_of_rights_acknowledged
  --activate--> active

active
  --placeOnHold--> on_hold

on_hold
  --releaseFromHold--> active

active/on_hold
  --executeDischarge death--> bereavement
  --executeDischarge non-death--> discharged

discharged/bereavement
  --closeAdmission--> closed
```

En production, les admissions creees par API sont inserees directement `pending`; le status DB default `referred` existe mais n'est pas le vrai point d'entree courant.

### Election / Certification / F2F

Election statement:

```text
drafted --sign--> signed
drafted/signed --void--> voided
```

Election period:

```text
pending --activate/start--> active
active --complete/end--> completed
```

Le seed period 1 est cree `pending` sans dates reelles fortes; l'activation admission le rend actif.

CTI:

```text
drafted
  --hospice MD signs first period with attending--> awaiting_attending
  --hospice MD signs recert/no attending--> signed

awaiting_attending
  --attending signs--> signed

drafted/awaiting_attending/signed
  --void--> voided
```

F2F:

```text
scheduled --complete--> completed --attest--> attested
scheduled/completed --override window--> status/effect with compliance event
```

Production F2F persiste une partie seulement des dates/contenus envoyes par l'API.

## H. Cross-module wiring

### M5 Patient

Ce qui existe:

- Patient lookup UI existe et peut fournir un patientId.
- M5 Patient Matching existe cote M5.
- M5 a un consumer M29 pour certaines propositions acceptees.

Ce qui manque dans M6 intake:

- `acceptReferral` n'appelle pas M5 matching.
- `createAdmission` n'appelle pas M5 matching.
- Aucun exact/probable match review.
- Aucun create patient M5 orchestre depuis referral.
- Risque fort: `acceptReferral` peut generer un patientId UUID local inexistant.

### M7 Care Plan

Ce qui existe:

- M7 a `bootstrapCarePlan`.
- M6 declare `m6.admission.activated` avec declared consumer `m7`.
- M7 documents internes disent que le bootstrap part de `m6.admission.activated`.

Ce que je n'ai pas trouve:

- Binding live dans le dispatcher qui consomme `m6.admission.activated` pour appeler M7 bootstrap.

Conclusion: attendu architecturalement, mais absent/incomplet dans le wiring inspecte.

### M9 Assessments

Ce qui existe:

- M9 enforce son propre admission-anchor gate a l'ecriture d'assessment: admission active et `capturedAt >= activatedAt`.

Ce qui manque dans M6 activation:

- M6 ne consulte pas M9 pour verifier l'initial assessment 48h.
- Le state machine event prevoit `initialAssessment48hOverdue`, mais production force `false`.

### M11 Orders

Ce qui existe:

- M11 a une decision pure pour discontinue orders sur `m6.admission.discharged`.
- M11 a une subscription map declarative.

Ce que je n'ai pas trouve:

- Consumer live enregistre dans le dispatcher pour discharge cascade M11. Les bindings M11 vus sont IDG et document backref.

### M22 Documents

Ce qui existe:

- M6 tables ont des `documentId` sur election/CTI/NOR/F2F/discharge.
- M6 events declares consumers M22 sur referral accepted, admission draft, election/CTI, activation/discharge.
- M22 render handshake live existe pour des document requests.
- M22 intake upload batch/DocLens existe.

Ce qui manque:

- Pas de documents attaches au referral.
- Pas de classification documentaire intake orchestree par M6.
- Pas de flow UI "documents recus pendant referral -> admission requirements".

### M29 External Interfaces

Ce qui existe:

- M29 inbound proposal review/accept existe.
- Accept publie `m29.hl7_inbound_proposal.accepted`.
- Dispatcher enregistre M5 et M6 proposal appliers.
- M6 applier traite `ownerModule=m6` pour `admission_event`, `discharge_event`, `cancel_admission`.

Limites:

- M6 applier n'auto-cree pas de referral/admission.
- `admission_event` ouvre plutot une compliance window si un patient/admission anchor existe.
- `cancel_admission` peut retirer un referral `received/evaluated`.
- M5 `new_patient` path est encore refuse/dead-letter selon le consumer inspecte; il ne fournit pas un vrai chemin new patient -> referral/admission.

## I. Main UX/business inconsistencies

- L'inbox existe mais n'affiche pas les donnees d'intake attendues.
- Il n'y a pas de bouton "Create referral".
- Le detail referral annonce implicitement un workflow, mais plusieurs champs envoyes ne persistent rien.
- Accept referral peut creer une admission avec un patient UUID inexistant.
- L'utilisateur peut ignorer M5 matching.
- L'ecran direct admission accepte un `referralId` texte sans orchestrer/valider le referral.
- Le status `admitted` existe en DB mais n'est pas utilise lors de la conversion.
- Une admission peut etre creee depuis un referral sans contrainte DB empechant un second lien.
- L'ecran admission detail montre un gate d'activation, mais ne fournit pas les actions pour completer election/CTI/F2F.
- Le gate election est trop permissif si un draft election existe.
- Le parcours UX force l'utilisateur a sortir de contexte ou utiliser l'API pour finir.
- Les events declarent beaucoup de consumers, mais certains consumers essentiels ne semblent pas bindes live.

## J. Recommended target workflow

Workflow cible coherent en respectant les frontieres de modules:

```text
Referral Inbox
  -> Create/import referral
  -> Persist full intake packet
  -> Attach M22 documents to referral/intake packet
  -> Run M5 patient matching through seam/API
  -> Show exact/probable/no-match decisions
  -> User confirms existing patient OR creates patient through M5
  -> Qualify/decline/pending-info referral
  -> Start admission from qualified referral
  -> Transaction:
       - lock referral
       - enforce one admission per referral
       - create admission pending
       - link patient/referral/admission
       - seed election period and requirement checklist
       - mark referral admission_started/converted
       - publish m6.referral.accepted + m6.admission.draft_created
  -> Admission Intake Workspace:
       - NOR
       - Election
       - CTI
       - F2F when applicable
       - documents
       - compliance windows
       - activation checklist
  -> Activate only when backend gate confirms:
       - signed election
       - acknowledged NOR
       - signed CTI
       - M5 privacy gate clear or authorized override
       - M9 48h initial assessment rule as applicable
       - F2F/recert rules as applicable
       - auditable DON/compliance override if used
  -> Outbox consumers:
       - M7 care plan bootstrap
       - M9/M10 schedules if applicable
       - M11/M12/M13 discharge/order cascades
       - M22 document bundle
       - M23/M26/M27 revenue/cap/cost seams
```

Key principle: M6 should orchestrate intake state, but should not directly import M5/M22/M29 internals. Use route APIs, seams, and outbox consumers.

## K. Implementation gap list

| Gap | Backend | Frontend | DB | Severity | Recommended change |
|---|---|---|---|---|---|
| Referral create UI absent | API exists | Missing | Existing partial | High | Add create referral screen/action wired to API |
| Referral fields dropped | `createReferral` ignores many inputs | UI cannot show them | Columns partial | Critical | Persist accepted schema fields or remove unsupported fields |
| External referral id not durable | In-memory only effectively | N/A | `external_message_ref` exists | High | Store idempotency key in `external_message_ref` or dedicated unique column |
| No assignment/priority/history | Missing | Missing | Missing | High | Add referral assignment/history tables and events |
| M5 matching bypass | Missing from M6 flows | Patient optional/free path | `patient_id` logical only | Critical | Require M5 match/create confirmation before admission |
| Placeholder patient UUID | Present in `acceptReferral` | UI permits blank patient | No FK | Critical | Remove UUID fallback; require confirmed patient or M5-created patient |
| One referral can link multiple admissions | Service partial only | UI not aware | No unique `referral_id` | Critical | Add unique active conversion guard/index |
| Referral converted status unused | Marks `accepted`, not `admitted` | Shows accepted only | Enum has `admitted` | Medium | Define and enforce real conversion lifecycle |
| Direct admission with referralId not validating referral | Missing | Free optional field | FK only | High | Validate referral/org/state and update lifecycle in transaction |
| Election gate too permissive | Uses row existence in places | Gate display may lie | Status exists | Critical | Require `status='signed'` and `signed_at` |
| Election UI write absent | Endpoints exist | Missing | Tables exist | High | Add intake workspace election actions |
| CTI UI write absent | Endpoints exist | Missing | Tables exist | High | Add CTI draft/sign workflow with signer identity |
| F2F data weakly persisted | Endpoints partial | Missing | Tables exist | Medium | Persist scheduled/performed/attestation fields faithfully |
| Activation ignores M5 privacy | Forced false | Not surfaced | M5 data external | High | Resolve via M5 seam/gate and override workflow |
| Activation ignores M9 48h | Forced false | Not surfaced | M9 external | High | Add M9 readiness/seam or compliance rule |
| M7 auto care plan not live-found | Service exists, binding not found | N/A | M7 tables | High | Bind `m6.admission.activated` consumer to M7 bootstrap |
| M11 discharge cascade not live-found | Pure consumer exists, binding not found | N/A | M11 tables | Medium | Register live dispatcher consumer |
| M22 referral docs absent | Render infra exists | Intake batch separate | No referral doc relation | High | Introduce referral/intake document attachment model |
| Full E2E referral journey absent | Partial tests | E2E direct admission only | N/A | High | Add Playwright scenario create referral -> activate |

## L. Files that will likely need modification

Backend M6:

- `apps/backend/src/modules/06-admission/routes/admission-typebox.ts`
- `apps/backend/src/modules/06-admission/routes/admission-routes.ts`
- `apps/backend/src/modules/06-admission/routes/service.ts`
- `apps/backend/src/modules/06-admission/admission-route-service-db.ts`
- `apps/backend/src/modules/06-admission/intake/activation-gate.ts`
- `apps/backend/src/modules/06-admission/state-machines/admission.ts`
- `apps/backend/src/modules/06-admission/events-by-m6.ts`
- `apps/backend/src/modules/06-admission/outbox-consumers/live-binding.ts`
- `apps/backend/src/modules/06-admission/consumers/admission-event-applier.ts`
- `apps/backend/src/modules/06-admission/seams/*`

DB/migrations:

- `packages/db/src/schema/admission/referrals.ts`
- `packages/db/src/schema/admission/admissions.ts`
- `packages/db/src/schema/admission/election-statements.ts`
- `packages/db/src/schema/admission/certifications.ts`
- `packages/db/src/schema/admission/face-to-face-encounters.ts`
- new migration under `packages/db/migrations/`

Frontend M6:

- `apps/web/src/modules/06-admission/screens.ts`
- `apps/web/src/modules/06-admission/referral-inbox.tsx`
- `apps/web/src/modules/06-admission/referral-detail.tsx`
- `apps/web/src/modules/06-admission/admission-create.tsx`
- `apps/web/src/modules/06-admission/admission-detail.tsx`
- `apps/web/src/modules/06-admission/patient-election-cert.tsx`
- likely new intake workspace components under `apps/web/src/modules/06-admission/`

M5 integration:

- `apps/backend/src/modules/05-patient/routes/patient-routes.ts`
- `apps/backend/src/modules/05-patient/routes/service.ts`
- `apps/backend/src/modules/05-patient/matching/matcher.ts`
- M5 seam/provider files if adding a formal patient-match/create contract for M6.

M7/M9/M11/M22/M29 wiring:

- `apps/backend/src/index.ts`
- `apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts`
- `apps/backend/src/modules/11-orders/consumers/admission-discharged-discontinue.ts`
- `apps/backend/src/modules/22-documents/*`
- `packages/db/src/schema/documents/*`
- `apps/backend/src/modules/29-external-interfaces/proposals/decision.ts`
- `apps/backend/src/modules/29-external-interfaces/routes/store-drizzle.ts`

Tests:

- `apps/backend/__tests__/admission-intake.test.ts`
- `apps/backend/__tests__/admission-workflow-acceptance.test.ts`
- `apps/backend/__tests__/m6-admission-write-lifecycle.live.test.ts`
- `apps/backend/__tests__/m6-election-cti-write.live.test.ts`
- `apps/backend/__tests__/m6-proposal-applier.test.ts`
- `apps/web/src/modules/06-admission/__tests__/*`
- `e2e/specs/admission.spec.ts`
- likely new `e2e/specs/referral-intake.spec.ts`

## Tests found

### Unit / in-memory / route injection

- `apps/backend/__tests__/admission-intake.test.ts`
- `apps/backend/__tests__/admission-workflow-acceptance.test.ts`
- `apps/backend/__tests__/admission-state-machines.test.ts`
- `apps/backend/__tests__/admission-certification.test.ts`
- `apps/backend/__tests__/admission-discharge.test.ts`
- `apps/backend/__tests__/admission-applier.test.ts`
- `apps/backend/__tests__/m6-proposal-applier.test.ts`
- `apps/backend/__tests__/admission-routes.test.ts`
- `apps/backend/__tests__/admission-seams.test.ts`
- `apps/backend/__tests__/admission-onset-reader.test.ts`
- `apps/backend/__tests__/admission-outbox-jobs.test.ts`
- `apps/backend/__tests__/admission-eraser.test.ts`

### Live DB

- `apps/backend/__tests__/m6-admission-write-lifecycle.live.test.ts`
- `apps/backend/__tests__/m6-election-cti-write.live.test.ts`
- `apps/backend/__tests__/m6-discharge-f2f-loc-write.live.test.ts`
- `apps/backend/__tests__/m6-compliance-window-write.live.test.ts`
- `apps/backend/__tests__/m6-admission-read-service.live.test.ts`
- `apps/backend/__tests__/m6-abac-scope-resolver.live.test.ts`
- `packages/db/migrations/__tests__/m6-rls-isolation.live.test.ts`

### Frontend unit

- `apps/web/src/modules/06-admission/__tests__/write-workflow.test.ts`

Ce test couvre seulement la redirection auth/step-up, pas le workflow metier.

### E2E

- `e2e/specs/admission.spec.ts`

Le test E2E couvre seulement le formulaire direct intake `/admissions/new` et verifie que la soumission atteint le serveur. Il ne couvre pas:

```text
Create referral
-> review referral
-> select/create patient
-> start admission
-> collect admission requirements
-> activate admission
```

Conclusion tests: les tests backend prouvent beaucoup de logique M6, surtout in-memory et live DB ciblee. Le parcours utilisateur complet referral -> activation n'est pas couvert E2E, et plusieurs tests in-memory masquent des ecarts production Drizzle.
