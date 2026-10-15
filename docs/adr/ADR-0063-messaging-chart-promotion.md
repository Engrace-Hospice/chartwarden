# ADR-0063 — Chart promotion is a thin M36 request that points at a message (ids and a hash, no text), decided only by the owning module (M8 addendum, M14 agenda item), and never reaches orders

- **Status:** **Accepted** (2026-10-14; the decisions are closed in the WP 3.7 blueprint. All wording is provisional pending clinical-lead sign-off, which is not recorded.)
- **Date:** 2026-10-14
- **Phase:** Messaging Hub Phase 3 (WP 3.7, Chart promotion).
- **Extends:** [ADR-0059](ADR-0059-messaging-clinical-links-read-through.md) (ids only, nothing copied, text re-read at display time), [ADR-0060](ADR-0060-messaging-sbar-structured-messages.md) (per-tenant ops flag default off), [ADR-0061](ADR-0061-messaging-communication-tasks.md) (the thin-row, audit and migration pattern, and the message-to-patient derivation), [ADR-0062](ADR-0062-messaging-clinical-handoffs.md) (the Part 2 gate on every read, uniform 404, per-patient read-audit on POST replies), [ADR-0010](ADR-0010-tenancy-rls-invariants.md) (tenancy rule for the new table), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md) (no cross-module table access).
- **Related:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (table ownership lives in the manifest; seam and outbox use need no import edge).
- **Amends the data model in** `docs/messaging-hub/02-architecture-and-domain.md` (see "Deviations from the architecture note" below). That note is a plan, and this ADR records where the built design differs from it and why.

## Context

The hub plan (`03-phases-0-to-3.md`, WP 3.7) lets a clinician "promote" something said in a care-team message into the chart. The architecture note (doc 02) models a `chart_promotion_request` with per-target contracts and says never to an order. The workflow note (doc 05) says a promotion is a partial, authorised-clinical-role action, that aides and compliance cannot do it, and that no order may come out of chat (42 CFR 418.104 sets the content and authentication rules for the clinical record). The release checklist (doc 07) names a promotion attribution check, which is the Phase 3 gate `chart-promotion-attribution`.

Six facts shape the design:

- None of M7, M8 or M14 has an intake seam. Their seams are read-only (care-plan reader; IDG packet, decision and schedule providers; the M8 readers). A message cannot write into any of them, and M36 must not write their tables (ADR-0011).
- A message is chat. Moving its text into a legal record without a reviewer would let anyone's words become chart content under another person's name. Content may enter the chart only through a clinician who reads it, owns it and signs it.
- The existing precedent (M22 diagnosis write-back to M7) creates a pending proposal that a clinician accepts. It works because the event carries the text, which the no-PHI-in-events rule forbids here. So the text cannot travel in an event.
- M8 only allows an addendum on a signed or co-signed encounter, authored by the caller, signed with a fresh step-up. That is a real, existing, attributable path. M8 has no standalone "note" encounter type, and none of the fixed types fits.
- M14 agenda items are pointers in the read model (no text), and M7 reaches a plan-of-care change only through an IDG `care_plan_update` decision and M7's own governed proposal. That matches Workflow C and is the only legitimate road to M7 from chat.
- Nothing about a message is stable: it can be edited (append-only `message_revision`) or erased (envelope version 0). A snapshot taken at request time must be checkable at review time.

## Decision

1. **D1. A promotion is a thin M36 request that holds a pointer and a hash, and no text.** One table, `chart_promotion_request`. It stores ids (message, channel, patient), the target, the status, and the attribution facts: the message author, the time it was sent, and the SHA-256 of the body at request time. There is no text column and no event table (the M4 audit trigger is the history). At review the text is re-read: the live message if its hash still matches, otherwise the one `message_revision` that has that hash (append-only). A missing, erased or mismatching source gives `null`, and the reviewer sees nothing (fail closed).
2. **D2. Exactly two targets.** `m8` / `encounter_addendum` and `m14` / `idg_agenda_item`. The set is a database CHECK, a TypeBox enum and a shared constant (`CHART_PROMOTION_TARGETS`) that must agree. No M11 or M12 target exists anywhere.
3. **D3. The M14 item is a pointer plus attribution, with no copied text.** The IDG screen shows "From a secure message by <author>, <time>". There is no link back to the message: the agenda item carries no channel id (see Known limits), so the coordinator opens the conversation from the messaging hub, where `canViewChannel` is checked as for any message. Nothing from the message body is stored in M14.
4. **D4. The reviewer acts and authenticates in the owning module; M36 never decides.** For M8, the reviewer creates their own draft addendum from the request (author is the reviewer; the attribution columns are copied), edits, finalises and signs with the existing step-up. Only the sign transaction publishes `m8.chart_promotion.decided` with outcome `accepted` and the addendum id as the result. For M14, a user holding `idg.coordinate` adds an `other` agenda item from the request, and the same transaction publishes `m14.chart_promotion.decided` with the agenda item id. A reject is a small route in each owner that publishes the same event with outcome `rejected` and a reason code, and writes nothing else. M8 reject needs `encounter.addendum_sign` (declining decides what enters the chart, the same permission as signing); M14 reject needs `idg.coordinate` plus the caller's IDG scope. An owner refuses a reject (409) while a non-voided addendum or an agenda item already exists for the request. **Rejected is final:** there is no re-propose path for the same request. After a rejection the requester proposes the message again from the messaging hub (a new request, allowed because a rejected row does not block one), and only after re-sending it if the content changed. `result_ref`, `decided_by_user_id` and `decided_at` are set only by the M36 consumer of those events.
5. **D5. Never an unreviewed copy.** Nothing exists in a target until the reviewer acts there. M8 content enters the chart only as the reviewer's own signed addendum text (they may edit the quoted snapshot), and the record carries the attribution columns. A partial unique index on the promotion request id (excluding voided) allows one live addendum per request; M14 has a unique index per request.
6. **D6. Statuses.** `proposed`, `accepted`, `rejected`, `superseded`, `withdrawn`. `withdrawn` means the requester took the request back while it was `proposed` (reason `requester`). `superseded` means the same message and target was requested again after the message was edited (a different hash): the old row becomes `superseded` and the new one `proposed` in one transaction. `accepted` and `rejected` are final. An owner outcome of `accepted` may still move a `withdrawn` or `superseded` row to `accepted`, because a signed record then exists and the truth beats the intent; in the same transaction every other `proposed` row for the same message and target is closed as `superseded` (reason `superseded`), so the replacement of a stale proposal does not stay open beside the record that was signed. A database trigger allows only these moves. A `rejected` outcome on a closed request is a no-op; an `accepted` outcome for a `rejected` request changes nothing and is logged as a conflict (ids only).

   **Races between a draft and a decision (code review M1).** The database, not the service, decides. (a) The M8 and M14 insert guards take `SELECT ... FOR SHARE` on the proposal row they check, so a reject (which updates that row) waits for a draft that is being written, and a draft cannot be attributed to a row that is being closed. (b) The M8 and M14 reject routes refuse (409) while a non-voided addendum or an agenda item exists for the request. (c) The M8 addendum guard re-checks, under a share lock, at the moment the status becomes `signed`, that the request is still `proposed`, `withdrawn` or `superseded`; a request that was rejected (or already accepted) in between refuses the signature (422 `PROMOTION_NOT_AVAILABLE`, nothing signed). (d) Accepting a superseded or withdrawn row closes its proposed siblings (above). **Residual window:** the outcome events are asynchronous. A reject event that is already published but not yet applied by the M36 consumer can still be followed by a draft and a signature; the consumer then applies whichever event it reads first, and an `accepted` that arrives for a `rejected` request is logged as a conflict, not applied. Closing that window needs a synchronous M36 write from M8, which ADR-0011 forbids; it is accepted and visible in the log.
7. **D7. Idempotency per message and target.** A partial unique index on (organisation, message, target module, target kind) where the status is `proposed`. A repeat returns the existing proposed request, or the latest accepted one (`200`, `created:false`). A different hash while one is proposed supersedes it. After a rejection or a withdrawal a new request is allowed. A replay returns only what the caller could already read.
8. **D8. Source rules.** The caller can view the channel. The message is live and the channel is patient-linked (derived as for tasks), otherwise `422 PROMOTION_SOURCE_NOT_PATIENT_LINKED`. The caller passes the Part 2 gate for that patient (deny or throw gives the uniform 404). An optional `suggested_target_ref` is allowed for `m14` only and is checked as an IDG meeting in the caller's organisation through the WP 3.2 link summary. WP 3.6 uses it.
9. **D9. Reads.** The requester, or anyone who can view the channel and passes Part 2 for the patient. Everyone else gets the uniform `NotFoundError("chart_promotion_request")`. Only the requester can withdraw.
10. **D10. New permission `messaging.promote`** (category clinical, no ABAC), granted by the migration to the clinical role templates and not to aides, compliance or admin-only roles. A request needs `messaging.send`, `messaging.promote` and `patient.read`; reads need `messaging.read`; a withdraw needs the same three as a request. A tenant's control is to remove the grant (tighten-only). The exact role keys were read from the role seeds at build time and are listed in the migration. **The migration grants only to roles that exist when it runs.** A tenant created after 1102 gets `messaging.promote` only if its role template is updated (follow-up: add the permission to the clinical role templates); until then its clinicians cannot propose. **Self-review is intended:** a user who holds `messaging.promote`, `encounter.addendum_author` and `encounter.addendum_sign` can propose a message and then author and sign the addendum alone, because the record carries the signer's own attribution and step-up like any addendum.
11. **D11. The feature is an ops flag, `messaging.promotions`, default off, per tenant.** There is no policy table. With the flag off, single and write routes answer the uniform 404 and `GET /chart-promotions` answers `200 {enabled:false, promotions:[]}`. The seam answers `enabled(org)` false, an empty pending list and `null` for review. The outcome consumer runs regardless of the flag, so a signed addendum still closes its request. The web reads the route's `enabled` field and never the shell feature-flag hook.
12. **D12. Part 2, permissions and the text at review.** `forReview` and `pendingForPatients` apply the Part 2 gate again for the reviewer and the patient, and require the reviewer to hold `patient.read` and, for the `m8` target, `encounter.addendum_sign` (a permission lookup that throws holds nothing). A deny, a throw or a missing permission returns `null` or leaves the row out. The text is structurally unavailable by default: `forReview` returns `snapshotText` only when the caller passes `withText: true`, the target is `m8` and the message is unchanged since the request; only the M8 owner-side module passes `withText`, and M14 never does. For an edited message the reviewer gets `sourceState: "edited_since"` and `snapshotText: null` (the superseded text is not served); a caller that does not ask for text never causes a body decrypt. The M8 list decrypts at most 10 bodies per GET, and the M8 list route is read-audited with the encounter as the resource id.
13. **D13. Events, alerts and audit carry no PHI.** Ids, enums and times only. No patient id and no hash in an outbox payload. The audit trigger removes `patient_id` and `source_body_sha256`.
14. **D14. There is no path to orders (M11).** (a) The TypeBox enum, the CHECK and the constant equal exactly the two pairs. (b) A static test requires that no file under the M11 or M12 trees, the orders package or the medications package mentions chart promotion, that promotion files contain no m11 or m12 target literal, and that the migration CHECK text excludes `m11`, `order` and `medication`. (c) A route test sends `target_module:'m11'` and expects 422. (d) The seam refuses any target module other than `m8` or `m14`.
15. **D15. Retention and erasure.** No foreign key to a message or a patient, as for `clinical_link`. `wardenx_app` has no DELETE; `wardenx_destruction` holds SELECT and DELETE under an organisation policy. An erased or tombstoned message makes a proposed request read as unavailable to reviewers, who reject it. There is no sweep (a known limit).
16. **D16. Offboarding changes nothing.** A request is not owned work, so there is nothing to reassign and the access-revocation closure is untouched. A leaving requester's proposed requests stay proposed and cannot be withdrawn; alerts to inactive users are dropped; a later outcome event still lands.

## Deviations from the architecture note

Doc 02 describes `chart_promotion_request` with statuses `proposed`, `accepted`, `rejected`, `superseded`, the route `POST /messages/:id/chart-promotions`, per-target contracts for the chart, and the event `m36.promotion.requested.v1`. The built design differs on purpose:

| Architecture note | Built | Why |
|---|---|---|
| Route `POST /messages/:id/chart-promotions` | `POST /api/v1/messaging/channels/:id/messages/:messageId/chart-promotions`, plus `GET` of the same path, `GET /api/v1/messaging/chart-promotions`, `GET /chart-promotions/:promotionId` and `POST /chart-promotions/:promotionId/withdraw`. | Messages are addressed under their channel, as for communication tasks, so the channel check and the patient derivation come from the path. |
| Statuses `proposed`, `accepted`, `rejected`, `superseded` | Adds `withdrawn`. | A requester must be able to take back a mistaken request that a reviewer has not acted on. |
| M7 (care plan) as a promotion target | No M7 target. M7 is reached only through an M14 agenda item, then an IDG `care_plan_update` decision, then M7's own governed proposal and quorum. | M7 has no intake seam, and a plan-of-care change must go through the IDG decision (Workflow C). A direct intake would let a message bypass the meeting. |
| A standalone M8 "note" kind | Not built. Only `encounter_addendum`. | The M8 encounter types are fixed and none fits a free-standing note; an addendum on a signed encounter is the one existing authored, signed path. A note kind is deferred. |
| A snapshot of the message kept with the request | No stored text. The row keeps the message id and a SHA-256, and the text is re-read at review time (live message, or the matching revision) and checked against the hash. | A second copy of the text would be another PHI store to seal, scrub and erase. The hash proves the reviewer sees what was requested. |

## Cross-module changes

This is the first M36 work package that changes two other modules. The changes are small, additive and owned by those modules; M36 imports nothing from them.

- **M8 (`encounter_addendum`):** five nullable columns (`promotion_request_id`, `source_message_id`, `source_author_user_id`, `source_sent_at`, `source_body_sha256`) with an all-or-none CHECK and a partial unique index on the request id (excluding voided). Route 22 (create addendum) accepts an optional `promotionRequestId`. The sign transaction publishes `m8.chart_promotion.decided`. The existing `m8.encounter.addendum_signed` payload is not changed. New reviewer routes: list pending promotions for an encounter's patient, and reject.
- **M14 (`idg_agenda_item`):** the same five columns with an all-or-none CHECK, a requirement that the patient is set, and a unique index on the request id. New routes: list pending promotions for a meeting, `POST /agenda/from-promotion` (creates an `other` item and publishes `m14.chart_promotion.decided`), and reject. The agenda item view gains an optional `promotion` attribution block (no text).
- **Owner-published outcome events:** `m8.chart_promotion.decided` and `m14.chart_promotion.decided`, each declared by its owner with `["m36"]` as the consumer. M36 checks that the event owner equals the request's target module before applying it, so one owner cannot decide the other's request.
- **New permission `messaging.promote`** (migration 1092 pattern, with the contributed-permission list and its test).
- **New seam `ChartPromotionSourceReader`** (owner M36, PHI): `enabled(org)`, `pendingForPatients(org, query)` and `forReview(org, requestId, query)`. It is read-only, takes the organisation explicitly, and fails closed. M8 and M14 reach it through `getSeam`, with no import edge. `forReview` returns `null` for a missing request, a request that is not proposed, a wrong target, the flag off, a Part 2 deny or throw, an erased source, or a hash that cannot be found. The snapshot text is returned only to a caller that passes `withText` (the M8 owner), for `m8` only, and only while the message is unchanged; for `m14` it is never returned. The reviewer must hold `patient.read` and (`m8`) `encounter.addendum_sign`. A deny stub that throws is registered for tests and boot checks.

## Data model

Migration `1102_m36_m8_m14_chart_promotion.sql` (check `arch:migration-numbering` against `main` first; `main` ends at 1101 and WP 3.6 adds no migration).

- **`chart_promotion_request`:** `id`, `organization_id`, `message_id`, `channel_id`, `patient_id` (logical pointers, no foreign key), `target_module`, `target_kind`, `suggested_target_ref` (m14 only), `status`, `requested_by_user_id`, `requested_at`, `source_author_user_id`, `source_sent_at`, `source_body_sha256`, `result_ref`, `decided_by_user_id`, `decided_at`, `reason_code`, `closed_at`, `version`, timestamps. CHECKs hold the target pairs, the status set, the hash shape (64 lowercase hex), the reason set, "accepted exactly when a result is set", "accepted or rejected exactly when decider and time are set" and "closed_at is null exactly when proposed". The partial unique index in D7 is the idempotency arbiter. Plain indexes lead with `organization_id` for message, patient and requester lookups.
- **Guard trigger:** a `BEFORE UPDATE` trigger refuses any change to an `accepted` or `rejected` row, lets a `superseded` or `withdrawn` row move only to `accepted`, and refuses a change to the message, channel, patient, target, source columns or requester. The CHECKs and the trigger were checked together for the `withdrawn` or `superseded` to `accepted` move (the decider, time and result are set in that update, and `closed_at` stays set).
- **Tenancy and grants:** organisation-keyed, FORCEd row-level security on `app.org_id`. `wardenx_app` holds SELECT, INSERT and a column-level UPDATE on `status`, `result_ref`, `decided_by_user_id`, `decided_at`, `reason_code`, `closed_at`, `version` and `updated_at`. No DELETE. `wardenx_destruction` holds SELECT and DELETE under an organisation policy.
- **Audit:** a bespoke write-audit trigger that scrubs `patient_id` and `source_body_sha256` and records the actor as `system` when no user is set.
- **Permission:** `messaging.promote` inserted and granted as in D10.
- **M8 and M14 columns:** as under "Cross-module changes".
- **Code mirrors:** closed unions in `packages/types`, the Drizzle schema, `ownedTables` in the manifest (`.ts` and `.cjs`), and a pin test that compares unions with the CHECK text, checks the trigger, the missing DELETE grant, the UPDATE column list and the M8 and M14 partial unique indexes.

## Events and the outbox

- `m36.promotion.requested` (outbox-only, owned by M36, published on a new insert only; payload: organisation, request id, target module and kind, requester, time).
- `m8.chart_promotion.decided` and `m14.chart_promotion.decided` (owned by M8 and M14; payload: organisation, request id, outcome `accepted` or `rejected`, result reference or null, decider, reason code or null, time).
- **Consumers (M36).** `m36.chart-promotion-outcomes` binds both decided events, takes the tenant from the envelope only, applies the outcome, and alerts the requester. `m36.chart-promotion-notifications` binds the requested event and, only if the request is still proposed, alerts reviewers: for `m8`, care-team members other than the requester who hold `encounter.addendum_sign` (at most 20); for `m14`, holders of `idg.coordinate`. If an alert reaches nobody, the requester gets a "no reviewer" alert.
- **Alert rules** (in-app only, platform defaults): `m36.promotion.decided`, `m36.promotion.review_requested`, `m36.promotion.idg_review_requested` and `m36.promotion.no_reviewer`. Correlation ids include the event id. Texts are fixed, generic, contain no name, patient or message text, and are provisional.

## Routes

M36 routes, all under `/api/v1/messaging`; the organisation and actor come from the request context only; static paths are registered before `/chart-promotions/:promotionId`.

| Route | Guard | Behaviour |
|---|---|---|
| `POST /channels/:id/messages/:messageId/chart-promotions` | `messaging.send` + `messaging.promote` + `patient.read` | Body `{target_module, target_kind, suggested_target_ref?}`, no extra keys. `201 {promotion, created:true}`, replay `200 {created:false}` |
| `GET /channels/:id/messages/:messageId/chart-promotions` | `messaging.read` | Requests on that message (D9) |
| `GET /chart-promotions` | `messaging.read` | The caller's own, `status=active\|closed\|all`; flag off answers `200 {enabled:false}` |
| `GET /chart-promotions/:promotionId` | `messaging.read` + `patient.read` | D9; read-audited with a resource id and the patient |
| `POST /chart-promotions/:promotionId/withdraw` | `messaging.send` + `messaging.promote` + `patient.read` | Requester only, while proposed |

Owner routes (each with the owner's own guards): M8 `GET /api/v1/encounters/:encounterId/chart-promotions` (`encounter.addendum_author`; the seam additionally requires `encounter.addendum_sign` and `patient.read` to return anything) and `POST .../chart-promotions/:requestId/reject` (`encounter.addendum_sign`), plus the optional `promotionRequestId` on route 22 (a malformed `encounterId` on the two promotion routes is 422); M14 `GET /api/v1/idg/meetings/:id/chart-promotions` (metadata only, no message or channel ids; at most 100 patients checked per GET), `POST /api/v1/idg/meetings/:id/agenda/from-promotion` (idempotency key required) and `POST .../chart-promotions/:requestId/reject`.

Errors: the uniform `404`; `422` `PROMOTION_SOURCE_NOT_PATIENT_LINKED`, `PROMOTION_TARGET_INVALID`, `PROMOTION_SUGGESTED_REF_INVALID`, and `PROMOTION_NOT_AVAILABLE` on the owner routes when the seam returns `null`, the patient does not match, or the proposal is no longer open at signing; `409` `PROMOTION_STATE_CONFLICT` (and `409` on an owner route when a draft or item already exists for the request). Responses carry a server-computed `allowed_actions` list. The DTO has no text and no hash. Messages never echo ids or names.

## Alternatives considered

- **A sealed snapshot column in M36.** A second copy of the message text, needing sealing, scrubbing and erasure. Rejected for the hash plus the re-read.
- **Copy the text into the M14 agenda item.** It would put chat words into a meeting record with no author. Rejected for a pointer and attribution.
- **A direct M7 intake.** It would let a message change a plan of care outside an IDG decision. Rejected; M7 is reached through M14 only.
- **M36 decides accepted or rejected.** It would make a non-clinical module the authority on chart content and would need write access to M8 and M14. Rejected; the owner decides and M36 records the outcome.
- **An order target, even as a draft.** Chat must never create orders (doc 05). Rejected, and enforced four ways (D14).
- **A standalone M8 note.** No fitting encounter type. Deferred.
- **A per-target tenant policy table.** The permission grant and the flag already give a tenant its controls. Rejected for now.

## Consequences

- **New flag `messaging.promotions`, default off.** It gates the M36 routes, the web, and the seam. The outcome consumer ignores the flag.
- **Rollback is safe.** The flag hides routes, UI and the seam; rows and the added M8 and M14 columns stay and are harmless.
- **Migration `1102`**, one new permission, one new seam (a required seam, so `check:boot:platform` covers it), three catalog events (one M36, one M8, one M14), four seeded alert rules, two consumers.
- **OpenAPI and client** are regenerated for the new routes.
- **Not built (non-goals).** A direct M7 intake; a standalone M8 note; any M11 or M12 target; expiry or reminders for a proposed request; a sweep when a message is erased; attribution on the M8 PDF; copying text into M14; M22 attachments; a per-target tenant policy; analytics.
- **Known limits (accepted).**
  - The M14 reviewer alert goes to every holder of `idg.coordinate` in the organisation, not scoped by meeting.
  - The M8 reviewer audience is the care team intersected with `encounter.addendum_sign`, capped at 20.
  - An org-wide M14 reviewer sees proposals on the meeting list only for patients on that meeting's agenda or packets plus their own caseload; a proposal for another patient stays invisible to them until the patient is on the agenda.
  - An accepted M14 agenda item carries no channel id, so there is no "Open message" link from the agenda, and the M14 proposal list no longer returns the source message or channel ids.
  - A reject event that is published but not yet applied can still be followed by a draft and a signature (see D6, residual window); the conflict is logged, not applied.
  - Rejected is final. To reconsider, the requester proposes the message again (a new request).
  - A tenant created after migration 1102 does not receive `messaging.promote` from the migration (role template follow-up).
  - The requester may review their own proposal (nothing forbids it; self-review is intended, see D10), and a requester who also holds `idg.coordinate` is alerted about their own proposal.
  - Withdraw needs `messaging.promote` and `patient.read` as well as `messaging.send`, so a requester who loses either cannot withdraw.
  - The M8 and M14 screens show "A care-team member" for the proposer (no user-id resolver yet).
  - An accepted M14 agenda item that is later deleted leaves `result_ref` dangling.
  - A replay ignores a changed `suggested_target_ref`.
  - An erased source leaves the request proposed until a reviewer rejects it.
  - A leaving requester's proposed requests stay proposed.
  - A reviewer's fetched snapshot cannot be recalled if a Part 2 release is revoked afterwards.
  - Role keys that receive `messaging.promote`, every alert text and every screen wording are provisional.
  - **Wording is provisional pending clinical-lead sign-off.** The request notice, the reviewer labels, the reason codes and the alert texts have not been reviewed by a clinical lead.

## Migration / rollout

**Rollout order.** (a) Deploy this build to every instance with `messaging.promotions` off. (b) Enable the flag for one pilot tenant. (c) Ask the clinical lead to review the roles holding `messaging.promote`, the reviewer audiences and the wording before wider use.

**Rollback.** Turn the flag off. The server stops accepting the routes within a few seconds (5-second flag cache) and the web hides the tab and the actions at the next page load. Rows stay, and a signed addendum still closes its request.

## Verification

- Pure rules: every status move, supersede on a hash change, an `accepted` outcome overriding `withdrawn` and `superseded`, `rejected` on a closed request as a no-op, allowed actions per role and state.
- Service on the in-memory store: a replay returns the existing request with no event; a channel that is not patient-linked gives 422; a Part 2 deny or throw gives 404 and writes nothing; a deleted message gives 404; an invalid suggested reference gives 422; only the requester can withdraw.
- Seam: every `null` cause; a snapshot found through a revision after an edit shows `edited_since`; a hash mismatch gives `null`; no snapshot text for `m14`.
- Static tests: the migration pin test, the no-foreign-writes test (the only seam reads are `canViewChannel` and the Part 2 allowed-user lookup), and the no-order-path test (D14).
- Routes and events: the flag off per route, byte-identical 404s, `201` versus `200`, `target_module:'m11'` gives 422, the read-audit has a resource id, no patient id in any payload, a decided event from the wrong owner is ignored, redelivery converges, the care-team filter, and "no reviewer".
- Owner routes: guards, `PROMOTION_NOT_AVAILABLE`, patient mismatch, and a decided event published only on sign or on add.
- Live suites as the real `wardenx_app` role over the real catalog-validating publisher, on a private container: `test:m36:promotions:live` (cross-tenant isolation, concurrent identical requests giving one row and one outbox row, immutable columns and closed rows refused, no DELETE, no patient id or hash in the audit row, the read event with a resource id) and `test:m36:promotion-targets:live` (the Phase 3 gate `chart-promotion-attribution`: M8 draft carries attribution, signing with step-up accepts the request with the addendum id, a second draft for the same request gives 409, reject, M14 from-promotion, and no M11 rows created).
- Fitness: `arch:tenancy`, `arch:manifest-mirror`, `arch:migration-numbering`, `arch:outbox-bindings`, `arch:queue-names`, `arch:route-reachability`, `arch:error-envelope`, `arch:live-suites`, `arch:openapi-coverage`, `arch:adr-docs`, `arch:fitness`.

## Open questions

None gating. To confirm with the product owner and the clinical lead: which roles should hold `messaging.promote`; whether the M8 reviewer audience (care team with `encounter.addendum_sign`) and the M14 audience (every `idg.coordinate` holder) are right; the reason-code list; and all wording. Left for later: a standalone M8 note, expiry and reminders, a sweep on message erasure, and the WP 3.6 link from an IDG outcome to a promotion request (it calls the same service with `suggested_target_ref`, and needs no new WP 3.7 code).
