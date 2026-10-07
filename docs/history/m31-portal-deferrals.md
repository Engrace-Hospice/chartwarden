# M31 portal — the three user-decided deferred pairs (F-220, F-221, F-222) + F-225 (F-221 resolved)

> #248 outbox arc. The `m31` group of `scripts/outbox-deferred-consumers.ts` held three declared-but-unbound
> pairs; the triage decisions were user-approved and each cited fact was re-verified against code before acting.

## F-220 — `m31 <- m17.visit.published`: lazy room mint on join (built; `m31` -> `seamConsumers`)

**Premises verified.** `VisitSetting` is `patient_home|facility|inpatient_unit|telephonic` (`packages/types/src/scheduling.ts`),
no "video requested" flag exists; M17's spec (~line 109) says "telephonic AND a video session is requested" but models no
request; `31-portal/` had no Queue/Worker/cron file and emits no `m31.*` event.

**Decision implemented.** No flag, no `m31.telehealth-room-mint` tier. The room is minted LAZILY on the first clinician
JOIN of a `telephonic` visit: `31-portal/telehealth/room-mint.ts` (`ensureTelehealthRoomForVisit`) pulls the visit through
M17's published `VisitReader.visitForEncounter(orgId, visitId)` (composed at the composition root; tenant-verified again by
the pure `isRoomEligible`), mints through the vendor adapter, seals `vendor_room_id_cipher`/`vendor_room_url_cipher` with the
per-tenant DEK (`createPortalRoomCipher`, `dekForOrg`, AAD = module/table/column/tenant, encrypt-only like the reason cipher)
and inserts `telehealth_visit` (`ON CONFLICT (m17_visit_id) DO NOTHING`, loser re-reads the winner). The staff join route
(`POST /api/v1/telehealth/visits/:visitId/join`) treats an id that is not yet a `telehealth_visit` id as an M17 visit id; with
the deps unbound it is byte-for-byte the old behaviour. Catalog: `m31` removed from `declaredConsumers` of
`m17.visit.published` (F-139's ADD reversed), added to `seamConsumers`; `m17.visit.published` dropped from
`M31_SUBSCRIBED_EVENT_NAMES`; deferral deleted.

**What is NOT built, and why.**
- **Production cannot mint a room yet.** `mountM31Routes` leaves the vendor adapter UNBOUND (no per-tenant Daily.co key vault
  exists), so `mintRoom` is absent and the lazy mint fails CLOSED with `TELEHEALTH_VENDOR_UNAVAILABLE` (503, new code) — no
  row without a real room. Binding the adapter is the single remaining step.
- **Patient-side lazy mint.** The patient join is ABAC-gated by `telehealth_consent_active`, which resolves the patient from an
  EXISTING `telehealth_visit` row; a patient can join only after a clinician join minted the room. A patient-first mint needs
  that predicate to resolve by M17 visit id.
- `m31.telehealth.room_created` (M17 back-ref `visit.telehealth_room_id`) is not emitted: M31 still emits ZERO `m31.*` events
  (F-160's reasoning stands) and M17's back-ref consumer does not exist.
- A losing concurrent mint leaves an orphan vendor room (reaped by the vendor TTL; `mintRoom` is idempotent on the id it is
  given).

## F-221 — `m31 <- m22.document.rendered`: STOPPED, premise false (declaration NOT dropped) — RESOLVED by F-225 below

The approved decision was "drop the declaration, because M4 audit + the M22 mint audit cover accounting of disclosures". That
premise is **false** on the current code, so per the brief no change was made and the pair stays deferred:

1. **`document_access_log` has no production writer.** Its only references are the schema, the eraser's retention note and a
   migration RLS test; M22's lifecycle only emits a pure `{kind:'access_log'}` effect descriptor that nothing executes. The
   §164.528 ledger is empty for EVERY M22 access, portal or staff.
2. **The portal mint writes no audit.** `createPortalDocumentReader.mintPortalDownloadUrl` does `void portalSessionId`
   ("the audit anchor") and presigns; no `auditRead`/ledger append happens inside the seam.
3. **What M4 does record** is the route-level `config.auditRead` on `GET /api/v1/portal/documents/:documentId/download-url`
   (`resourceKind: 'portal_document'`, patient-level): one `audit_log` read row per successful HTTP response, without the
   document id (`resourceIdParam` is unset) and regardless of whether a URL was actually minted.
4. **The download route is itself broken:** `31-portal/routes/read.routes.ts` calls `mintPortalDownloadUrl({organizationId,
   patientId, documentId})` but the published contract is `{documentVersionId, portalSessionId, patientId, organizationId}`, so
   the M22 reader resolves no owning version (denied / a thrown lookup caught as fail-closed) and the route never returns a
   usable url. No portal document is actually disclosed today, which is the only reason the gap has not bitten.

Dropping `m31 <- m22.document.rendered` remains right on its own terms (a push on render cannot record a VIEW, and a
`portal_document_share` table is a schema decision), but it should not be justified by an accounting-of-disclosures coverage
that does not exist. Recommended follow-up (not done): fix the route/seam argument shape, append a `document_access_log` row
(`accessKind:'portal_view'`, purpose `patient_access`) inside `mintPortalDownloadUrl`, and set `resourceIdParam` on the route.

## F-222 — `m31 <- m6.admission.discharged`: daily post-discharge-grace sweep (built; `m31` -> `seamConsumers`)

**Premises verified.** The spec contradicts itself (§4.8 daily `m31.post-discharge-grace.cron` vs §7.6 delayed job cancelled
on re-admission); no cron tier existed in `31-portal/`; the death branch is redundant with `m6.bereavement.eligible` -> M16
`plan_opened`/`contact_active`. The provisioning routes (`POST /api/v1/admin/portal-invitations`, `.../invite-bereaved`) are
still stubs returning canned 202s with no DB write (`admin.routes.ts`) — **production has no care-time portal grants until
provisioning is built**, so this sweep is live-tested against rows the test inserts and is a no-op in production today.

**Design.** Sweep over M6's CURRENT discharge state, so a re-admission needs no cancel logic.
- New org-explicit M6 published read `portalDischargedPastGraceForOrg` (`06-admission/seams/portal-discharge-grace-for-org.ts`):
  of a patient batch, the patients whose LATEST completed discharge is non-death, strictly older than the cutoff date, with NO
  open admission (a re-admission — even a draft referral — keeps the patient out; a discharge -> re-admit -> discharge cycle
  restarts from the newest discharge; `pending_cosign`/`voided` never count).
- M31 cron `31-portal/jobs/` (M29 poll-sweep template): queue `m31-post-discharge-grace`, `30 2 * * *` UTC (spec §4.8),
  `buildActiveOrgEnumerator` under `m31.platform_crons` (`wireM31Tenancy`), per-org `withOrgContext` + explicit
  `organization_id`. Pages active NON-bereaved grants' patient ids (keyset), asks M6, revokes with
  `revoke_cascade_source='admission_discharged'`, guarded by `revoked_at IS NULL` (idempotent). `bereaved_family` grants are
  never touched. One org's failure does not block later orgs (collected, rethrown as `AggregateError`).
- **Grace floor.** `effectiveGraceDays = max(30, tenant value)`; no tenant-config store exists for this knob, so the optional
  `graceDaysForOrg` port defaults to exactly 30 and a shorter value is clamped UP. The cutoff is strict (`effective_at <
  today-graceDays`), so access survives THROUGH day discharge+30.
- **First run on a deployment with a large discharged backlog.** At most 100 PATIENTS are revoked per org per tick (and 5,000
  scanned); a capped tick reports `capped:true` and the remainder drains on the following daily ticks. Every candidate already
  had >= 30 full days, so the cap is a safety valve, not a correctness requirement.
- Known, accepted race: the M6 read and the revoke are separate transactions (cross-module), so a re-admission committed in
  that millisecond window would still see the grants revoked (re-grant is then needed).
- Catalog: `m31` removed from `declaredConsumers` of `m6.admission.discharged`, added to `seamConsumers`; the event dropped from
  `M31_SUBSCRIBED_EVENT_NAMES`; deferral deleted.

**What is NOT built.** The spec's M36 one-time "entering grace" notification, the M39 consent-expiry signal and the M30
engagement metric on revocation each need a catalogued `m31.*` emit or a new seam (M31 emits none); the M4 write-audit trigger
on `portal_access_grant` records every revocation. The grace-window write denial (`PATIENT_DISCHARGED_READ_ONLY`) was already
live. Provisioning (real grants) is unbuilt and out of scope.

Tests: `apps/backend/__tests__/m31-post-discharge-grace-sweep.live.test.ts` (real NOBYPASSRLS `wardenx_app`, real
`portal_account`/`portal_access_grant`/`admission`/`discharge_event` rows; floor boundary, idempotent rerun, re-admission,
death/voided/pending discharges, bereaved grants, tenant grace longer/shorter, cross-tenant, capped backlog drain, failure
isolation), `m31-lazy-telehealth-room-mint.live.test.ts`, and unit suites `m31-post-discharge-grace-sweep.test.ts` and the
F-220 block of `portal-inject.test.ts`.

## F-225 — the portal document download is accounted; `m31 <- m22.document.rendered` dropped (resolves F-221)

The user approved "fix it, then drop the declaration". Every F-221 claim was re-verified on current code first (all four held),
then fixed:

**1. The route returns a usable URL.** `GET /api/v1/portal/documents/:documentId/download-url` now (a) resolves the GOVERNED
version through M22's published `PortalDocumentReader.resolvePortalDocumentVersion` (new published method: the document's
ACTIVE version, only for the session patient's own, patient-facing, non-superseded/non-destroyed document), then (b) calls
`mintPortalDownloadUrl({documentVersionId, portalSessionId, portalAccountId, patientId, organizationId})` with the account,
session and patient taken from the SERVER-assembled session (`attributes.portalAccountId` / `.sessionId` / `.sessionPatientId`).
The mint also stopped presigning an invented `portal/<versionId>` key: it presigns the version's real `minio_object_key` in the
tenant bucket (TTL 3600 s). The M22 gates are unchanged (owner, patient-facing, F-197 SUD consent re-check) plus a new
`not_active` denial for superseded/destroyed documents. Response: `{ url, expiresAt, patientId }` (`patientId` = the session
patient, used only for M4 attribution).

**2. The ledger row.** Migration `0298` makes `document_access_log` able to account a portal accessor: `accessor_membership_id`
nullable, `+ accessor_portal_account_id`, `+ portal_session_id`, `+ patient_id`, CHECK exactly one accessor kind, per-patient
index; and REVOKEs `UPDATE` from `wardenx_app` (0049 had granted it; the log is append-only by contract, nothing updates it).
The mint appends ONE row (`access_kind='portal_view'`, `purpose='patient_access'`, ids only) AFTER every gate passed and the URL
exists and BEFORE it is returned; if the append fails the mint throws (no un-logged URL) and the route answers 503. A refusal
returns before the append, so the ledger holds ONLY actual disclosures. Design choices: (a) denials are NOT logged in
`document_access_log` (no outcome column was added on purpose: a consumer summing the ledger must not be able to mistake a
refusal for a disclosure; refusals are visible as 404s in request logs only); (b) the append is not in a shared DB transaction
with a read (the mint has none — presign is local SigV4 math); ordering gives "no URL without a row", and a crash between append
and delivery over-reports by one row, never under-reports.

**3. M4 audit semantics.** The route's `config.auditRead` now sets `resourceIdParam: 'documentId'` and
`patientIdPayloadPath: 'patientId'`. The read-audit hook emits only on 2xx; the route used to return 200 with an empty url on
every failure. Every refusal is now a 404 (one indistinguishable answer; malformed id, unknown, other patient's, other org's,
not patient-facing, superseded, SUD without consent) and an M22 outage / failed ledger append is a 503, so an `audit_event`
`portal_document` row exists exactly when a URL was minted, carrying the document id and the session patient. No framework change
was needed. A session with no session id is 403 before any M22 call.

**4. Outbox.** `m31` dropped from `declaredConsumers` of `m22.document.rendered` (recorded under `seamConsumers` — M31 pulls
documents through `PortalDocumentReader`), removed from `M31_SUBSCRIBED_EVENT_NAMES`, and the emptied `m31` group deleted from
`scripts/outbox-deferred-consumers.ts`. `arch:outbox-bindings` declared-but-unbound: 8 -> 7 pairs.

**5. Accounting-of-disclosures read surface — what remains.** M31 §4.3's `PortalDisclosureAccountingProvider.disclosuresForPatient`
is still a stub returning `[]` (`31-portal/routes/store.ts`, "M4 is the source"), and no patient/compliance accounting report reads
`document_access_log` or `audit_event` yet. The new rows are query-ready (`patient_id` + index, 6-year `compliance` audit
trigger) but NOTHING renders them to a patient. Other document disclosure paths still write no ledger row: the STAFF signed-url
service (`signed-url-service.ts` mint — `planAccessLog` is a pure descriptor nothing persists), content download, disclosure
export. The portal watermark rasterization layer (M22 §7.10) is not built: the URL serves the stored PDF unwatermarked.


## Batch 17 / GAP-159 — M31 events published, two of the six §4.8 queues built, four closed as spec drift

**Events.** `events-by-m31.ts` catalogs all 22 §4.10 events (record-only; PHI-free lean payloads) and
`m31OutboxPublisher = bindCallerModule(txOutboxPublisher, "m31")` validates every publish. `events.ts` is the shared
emitter: `emitInTx` for SAME-transaction emits wherever M31 itself writes the row, `emit` (own short org tx, failure
logged not swallowed) for decision points whose row lives in another module's transaction. The earlier "M31 emits ZERO
events (F-160)" statements above are superseded.

Emitted (same tx): `portal_account.suspended` (store), `portal_access_grant.granted` / `.revoked` (m39 consent
cascade, m16 plan_opened / contact_active / plan_closed, the post-discharge-grace sweep, the eraser),
`portal_account.bereaved_mode_entered` (m16 flips), `portal_account.bereaved_window_closed` (m16 plan_closed),
`portal_account.revoked` + `.shredded` and `telehealth.recordings_shredded` (the eraser), `telehealth.room_created`,
`.visit_started`, `.visit_ended`, `.recording_started` (the store's lifecycle writes; also the m17-cancel consumer, the
eraser abort and the late-join watchdog for `visit_ended`).
Emitted (decision point): `portal_session.opened` / `.closed` (select-patient / logout), `portal_message.sent_via_m36`,
`portal_amendment_request.submitted`, `portal_document.upload_started` / `.uploaded` / `.upload_rejected`.

**Catalogued but with NO emit site (and why).** `portal_account.invited` and `.activated`: the invitation and the
`portal_account` row are materialised by M2's magic-link / collaborator-invite layer, which is not built (the admin
issue route returns a synthesised id; ADR-0005 keeps invitations and sessions out of M31's three tables), so M31 has
no real mutation to describe. `telehealth.recording_completed`: the vendor webhook route verifies the signature and
drops the body; mapping the Daily.co / Twilio payload and pulling the bytes is the same unbuilt step as the
recording-finalize queue. `portal_account.revoked` is emitted only by the eraser, the one real terminal-revocation
path.

**Queues (spec §4.8).** Built: `m31.telehealth-late-join-watchdog.cron` (`m31-telehealth-late-join-watchdog`, every 5
min). The room is minted lazily on first clinician join and `telehealth_visit` has no scheduled-start column, so the
15-minute window is measured from `room_minted_at`; the abort is one idempotent UPDATE per org plus a same-tx
`visit_ended`. The vendor room is not ended (the adapter is unbound in production).
Already covered elsewhere: `m31.bereavement-window-close.cron` — the M16 `plan_closed_completed` consumer revokes
bereaved grants at plan close, which is the same fact pulled from the producer (the post-discharge-grace pull-vs-push
precedent), so a second 13-month calendar would only double-revoke.
Closed as spec drift (architecture wins, ADR-0005 — the entities the queues operate on never materialise): 
`m31.invite-expiry.cron` (no `portal_invitation` table; M2 owns invitations), `m31.upload-intake-handoff` (no
`portal_document_upload` table; the upload routes are stubs until the M22 intake handoff exists),
`m31.telehealth-recording-finalize` (no recording table; needs the vendor webhook mapping and byte pull),
`m31.disclosure-accounting-rotate` (no `portal_audit_view` table to partition).
