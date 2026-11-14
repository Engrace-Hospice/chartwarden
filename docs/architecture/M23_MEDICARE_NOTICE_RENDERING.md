# M23 Medicare notice rendering — CM-4A.2

This is an internal authoritative-data and X12-rendering capability. It does not authorize or perform a filing. Claim.MD and Stedi notice upload remain `CH_NOT_WIRED`. Direct-MAC notice workers remain delayed under `M23_NOTICE_GATEWAY_ARTIFACT_CONTRACT_UNSUPPORTED`; because that hold is known before transmission readiness, preflight does not decrypt MBI or render X12 just to park the job. The internal renderer remains bound for separately authorized internal rendering/recovery operations; no external dispatch is enabled.

CMS Claims Processing Manual, Chapter 11 §§20.1.1–20.1.4 defines 8xA as NOE, 8xB as NOTR, 8xC as the receiving hospice's change-of-provider notice, and 8xD as cancellation of an election/transfer/ownership notice submitted in error. A transfer is not a NOTR, and 8xD is not another transfer. WardenX currently has an authoritative 8xD source only for cancellation of its persisted transfer notice; general election cancellation remains held.

## Loader boundary

`medicare-notice-source-loader.ts` is the mapping core, `medicare-notice-production-loader.ts` supplies M23 persistence/routing adapters, and M6 owns `seams/medicare-notice-source.ts`. The composition root binds the existing renderer and artifact store to notice worker dependencies. Claim.MD/Stedi and Direct-MAC jobs are held in lightweight preflight before notice rendering because their required external submission capability is unavailable/unverified. Explicit internal rendering still recovers a finalized artifact before reading current facts, returning the original bytes without rerendering.

Source chain: M23 notice/attempt → M6 admission/election/event → M5 coverage/patient/address/audited MBI → M23 effective provider routing → M40 payer/physicians/provider → M23 EDI profile → existing TypeScript builder. All database adapters run under `withOrgContext` and repeat organization predicates. BullMQ payloads contain IDs only.

## Source-to-builder field matrix

| TypeScript field | X12 / role | Req. | Authoritative source | Effective-date / mapping rule | Failure |
|---|---|---:|---|---|---|
| `submitter.*`, `envelope.senderId` | ISA06, GS02, 1000A | yes | M23 `billing_edi_profile` | org/provider/vendor profile | route hold; no synthetic ID |
| `receiver.*`, application code | ISA08, GS03, 1000B | yes | M23 `billing_edi_profile` | same account route as identity | route hold |
| envelope usage | ISA15 | yes | tenant/platform account mode | test→T, production→P | route hold |
| ISA13/time and GS/ST controls | envelopes | yes | attempt interchange allocator + render identity | allocated once per submission attempt | identity hold |
| notice/document control | BHT03, CLM01 | yes | M23 notice record | pre-existing durable control number | source hold |
| NOE admission date | DTP 434/435, OC27 | yes | M6 election period + signed election statement | effective dates must agree and belong to admission/patient/provider | source hold |
| NOTR From/Through | DTP 434/435/472 | yes | M6 election/last transfer-in + signed revocation or eligible completed discharge | transfer-out/death/transfer-shaped discharge rejected; filed 814 final claim suppresses discharge-alive NOTR | source hold |
| 8xC/8xD From/admit | DTP 434/435 | yes | M6 transfer-in + M23 snapshot | original 8xC matches transfer-in; 8xD dates match | source/build hold |
| action/TOB/frequency | CLM05 | yes | M23 transfer notice | original/correction=C; cancellation=D with distinct renderer kind | source/build hold |
| D0 + OC56 | HI BG/BH | correction | M23 action/original date | emitted together only | facts hold |
| OC27 | HI BH | conditional | M23 benefit-period start | only when equal to statement date | omitted otherwise |
| subscriber MBI | 2010BA NM109 | yes | protected M5 payer via `MbiUnlockReader` | exact effective Medicare FFS row; audited purpose `medicare_notice_render`, subject=submission UUID | facts hold; never log/queue/persist |
| legal name/DOB/sex | 2010BA NM1/DMG | yes | M5 patient and audited identity | same org/patient; current builder accepts M/F | facts hold |
| historical address | 2010BA N3/N4 | yes | M5 `primaryAddressAt` | primary address on transaction date; no current-address fallback | facts hold |
| principal diagnosis | HI ABK | yes | exact signed M6 election statement | dot/case normalized by builder | facts hold |
| attending physician | 2310A NM1*71 | yes | M6 physician ID → active M40 physician | name and valid NPI | facts hold |
| certifying physician | 2310F NM1*DN | conditional payload | M6 hospice physician ID → M40 | builder omits when NPI equals attending | facts hold if source absent |
| billing provider | 2010AA | yes | M1 provider facts/EIN decrypt | active same-org entity; in-memory only | facts hold |
| provider CCN | business prerequisite | yes | same-org active provider entity | never substituted with prior hospice CCN | facts hold |
| MAC jurisdiction | routing prerequisite | yes | effective M23 provider routing | notice effective date; no MAC credential lookup | route hold |
| payer/account | 2010BB + prerequisite | yes | M5 payer → active M40 payer → M23 route | text payer ID preserves leading zeros; Claim.MD route/account/usage/jurisdiction unique | route hold |
| Claim.MD enrollment | prerequisite only | yes for data readiness | M23 enrollment | existing 837I evidence checked, but does not prove notice support | route hold; support remains false |
| signed election | prerequisite only | yes | M6 status/signed time/document | exact election statement; not emitted | source hold |
| prior final billing (8xC) | prerequisite only | yes | M23 prior-billing confirmation | receiving-hospice evidence; prior and receiving CCNs differ | facts hold |
| 8xD original/reason | prerequisite only | yes | M23 superseded notice/state/reason | same org/provider/patient/transfer; original already submitted/in acknowledgment | source hold |

The notice builder currently emits non-hospital 81A/81B. No authoritative hospital-based classification exists for 82A/82B, so the loader does not fabricate one. The transfer builder accepts persisted 81C/82C/81D/82D and enforces C/D invariants.

## MBI and PHI controls

The closed disclosure purpose `medicare_notice_render` is validated before M5 reads data. M5 performs the protected read and `patient_payer.mbi_disclosed` audit in one organization-scoped transaction. Errors contain codes and field paths only. MBI, address, credentials, and raw X12 are absent from logs, queues, APIs, and the render-identity table.

## Rendering and integrity

`createMedicareNoticeRenderer` calls only `build837iNotice` or `build837iTransferNotice`; it accepts no HTTP gateway, transport, or `MacPortalPort`. The loader validates a committed pending attempt and returns in-memory builder input plus a non-PHI identity (source-version hash, route fingerprint, provider/jurisdiction, vendor/account/usage, mapper version, control number, related source).

The identity store allocates stable envelope metadata and refuses source/route changes under the same attempt. The artifact store encrypts the exact UTF-8 builder output with M36's tenant DEK ring (AES-256-GCM), binds AAD to organization plus render-identity UUID, and commits ciphertext, key version, exact byte length, SHA-256, and finalized state atomically in PostgreSQL. PostgreSQL was selected over the existing S3-compatible object store because notice X12 is a small transactional artifact and SQL uniqueness/RLS gives a single commit point without an object/DB dual-write protocol. No plaintext X12 is stored.

`buildDrizzleMedicareNoticeRenderArtifactStore` uses a unique `(organization_id, render_identity_id)` constraint. Concurrent inserts converge on the row; identical bytes recover the original artifact, while different bytes fail with `NOTICE_ARTIFACT_CONFLICT`. Retrieval requires the requested organization, notice, submission and transaction kind to match the stored render identity, decrypts only through the tenant ring provider, and rechecks UTF-8 round-trip, length, and SHA-256. A failed authentication or digest check marks the row `corrupt` (without replacing bytes), records a PHI-safe critical M36 alert, and returns `NOTICE_ARTIFACT_INTEGRITY_FAILED`. Reads produce a safe audit event with identity metadata only. Old ring versions remain readable through the existing `dekForOrgVersion` contract; this lot does not run a bulk re-encryption job.

On renderer invocation, the artifact is recovered before current clinical or routing facts are loaded. Thus a finalized attempt returns its original bytes and does not invoke a builder, allocate a new ISA13, or update render time. If identity exists without artifact, the normal source loader and immutable identity reservation still detect source/route drift before rendering. External dispatch remains unavailable in this lot; accordingly the code does not claim safe reconstruction after a future dispatch/in-doubt transition. CM-4B.2 must gate that transition on a verified finalized artifact and must reconcile rather than regenerate/resend an ambiguous transmission.

| Capability | NOE | NOTR | 8xC | 8xD transfer cancellation |
|---|---:|---:|---:|---:|
| Authoritative production loader | yes | revocation/eligible live discharge | yes | yes, transfer cancellation only |
| Internal TypeScript render | yes | yes | yes | yes, distinct cancellation path |
| Audited transient MBI | yes | yes | yes | yes |
| Stable metadata/envelope identity | yes | yes | yes | yes |
| Exact encrypted X12 artifact | yes | yes | yes | yes, supported transfer cancellation only |
| Verified vendor notice support / live filing | no | no | no | no |

General election cancellation, hospital-based 82A/82B selection, transaction-specific Claim.MD/Stedi notice support, and any dispatch/reconciliation integration remain explicit holds. Internal rendering and artifact finalization are neither filing nor payer acceptance.

## Artifact schema, rollout, and recovery boundary

Migration `1490_m23_medicare_notice_render_artifact.sql` is an expand-only forward migration. It adds a foreign key to the immutable render identity, uniqueness for one artifact per organization/render identity, tenant RLS with FORCE, a PHI-safe creation audit trigger, and an immutable-row trigger that validates organization ownership. The only permitted update is `finalized` → `corrupt`; ciphertext, digest, key version, and identity cannot be replaced by the app role. Existing 1489 identity rows are untouched. No plaintext payload backfill is performed.

Apply 1489 (if not already applied) and then 1490 before deploying code that writes artifacts. Rollback is application rollback only: do not drop 1490 or delete artifacts after any render. Older code ignores the new table; the new code requires the table and ring-key service, failing closed if either is unavailable. Retain retired tenant ring versions for as long as artifacts reference them; missing/destroyed keys make retrieval fail closed. This lot supplies no bulk key rotation, artifact purge, or orphan cleanup because artifacts are database rows committed atomically and existing retention/legal-hold policy must govern any eventual deletion.

The table stores only authenticated ciphertext and non-PHI metadata. M36's `TenantKeyProvider` remains the key owner; M23 stores the envelope version, not a key. AAD is `m23-medicare-notice-x12:v1:<organization UUID>:<render-identity UUID>`. Retrieval independently checks organization/notice/submission/kind, AAD authentication, UTF-8 byte round trip, stored byte length and SHA-256. Audit events record artifact/render IDs, kind, state, digest and length only—not X12, MBI, patient identifiers, addresses, diagnoses, or credentials.

Key lookup failure is distinct from integrity failure: an unavailable or destroyed tenant DEK produces the PHI-safe `NOTICE_ARTIFACT_KEY_UNAVAILABLE` hold and does not change the artifact row. Only failed authenticated decryption, unsupported envelope metadata, or digest/length/UTF-8 mismatch marks a finalized row `corrupt`. M36's body cipher preserves its original no-context AAD bytes, so historical message envelopes continue to open; notice artifacts opt into the additional organization + render-identity context.

State interpretation is structural: no render identity means missing preparation; a durable identity with no artifact means incomplete/pending render; an artifact row in `finalized` means internally render-ready; `corrupt` or a verification failure means blocked. Insert is atomic with finalized state, so no partially written ciphertext row is visible. Current live notice processors remain held and cannot transmit. CM-4B.2 binds internal rendering but does not add dispatch reservation or post-dispatch recovery. A future dispatch path must require a verified finalized artifact before any external call; a dispatched/in-doubt attempt with no artifact must be reconciliation-required, never regenerated from current facts.

## CM-4B.2 dispatch boundary

| Capability | Current behavior |
|---|---|
| Notice worker registration | One NOE, NOTR, and transfer consumer registration remains in place; renderer is injected by the composition root. |
| Claim.MD / Stedi | Delayed with transaction-specific capability hold; no render or upload; `CH_NOT_WIRED` transport refusal remains unchanged. |
| Direct-MAC with missing X12/MAC gateway | Delayed with `M23_NOTICE_DIRECT_MAC_GATEWAY_UNAVAILABLE`. |
| Direct-MAC with gateway and renderer | Does not render during submission preflight; delays with `M23_NOTICE_GATEWAY_ARTIFACT_CONTRACT_UNSUPPORTED` to avoid unnecessary MBI disclosure and rendering. |
| Dispatch reservation / upload | Not implemented. Existing `MacPortalPort` has no artifact digest/render identity/account-usage dispatch contract and no verified ambiguous-outcome reconciliation for this path. |
| 8xD cancellation | Remains held. The shared transfer queue does not encode a distinct cancellation operation; no external dispatch is allowed. |

The current `MacPortalPort.upload` client posts inline `{ organizationId, providerEntityId, kind, x12, controlNumber, ... }` JSON to `/uploads` and receives `{ accepted, generatedFileUri }`. Although this is an implemented raw-payload client contract, it does not bind the notice to persisted submission/render identity, original vendor account/usage, attempt reservation, or immutable artifact digest. No gateway server implementing this contract is present in the repository, and there is no verified notice reconciliation proof. Therefore this code intentionally does not adapt or call it. No durable dispatch reservation is made and no transport receipt/acceptance state changes. The hold uses the existing delayed-job/critical-alert path. Source facts and X12 are not put in queue payloads or alert metadata. A finalized artifact is not an authorization token and does not advance a queued submission attempt.

## CM-4B.3 state-machine status and gateway contract qualification

`claim_submission` already provides durable `pending → sending → in_doubt/finished` transitions, a fencing token, and immutable subject identity (migration 1383). `buildMedicareNoticeDispatchStateMachine` now qualifies a notice reservation against that row, the unique immutable render identity for `(organization_id, submission_id)`, and its single finalized artifact. It atomically claims `pending → sending`; a concurrent/redelivered reservation returns the original token and timestamps; a potentially sent attempt moves to `in_doubt`; a proven non-send/rejection terminates as `failed_portal`; and a correlated transport receipt terminates as `submitted`, which remains distinct from MAC acceptance. Route/account/provider/jurisdiction/usage/control values are returned from the immutable render identity, never current configuration. No parallel attempt table or migration is added.

The state machine is production-composed but live notice preflight does not invoke it while the gateway contract is unqualified. Therefore existing jobs remain `pending` and delayed—there is no false `dispatch_started` event. Once a real gateway contract is qualified, the required ordering is: recover and cryptographically verify the finalized artifact, call `reserve`, commit, then permit I/O. Any timeout/crash after that commit must call or recover as `in_doubt`; redelivery receives `already_started` and cannot upload again. The current gateway offers no verified lookup, so such a future in-doubt row would require operator reconciliation.

| Gateway capability | Existing backend client | Server implementation in this repository | Required for safe notice dispatch |
|---|---|---|---|
| Inline X12 upload | Yes: `POST /uploads` JSON through `MacPortalPort.upload` | Not found | Yes, or an approved protected artifact handoff |
| Artifact digest/ciphertext identity | No | Not found | Yes, tied to recovered exact artifact |
| Organization/provider/jurisdiction scoping | Request has organization/provider; jurisdiction is not part of upload body | Not found | Yes, including credential isolation |
| Submission/attempt/render identity | Optional notice ID only; no dispatch-attempt or render identity | Not found | Yes |
| Remote idempotency | No explicit key in contract | Not found | Required for automatic resend after ambiguity |
| Durable receipt/correlation identity | `generatedFileUri` only | Not found | Required for confirmed transport receipt |
| Outcome lookup by original attempt | No | Not found | Required for automated ambiguity reconciliation |
| MAC acknowledgment matching | Separate raw-file polling contracts by jurisdiction | Not found | Required before payer/MAC acceptance can be applied |

No server guarantees are inferred from `createM23LaunchGateway` or its mocks. `accepted: true` and HTTP 200 remain transport response facts only, not Medicare acceptance.

## CM-4B.4 versioned gateway contract boundary

Repository and deployment discovery found no Direct-MAC gateway server, image, OpenAPI contract, reverse-proxy route, or MAC-specific delivery adapter. The external dependency is therefore classified as category C: no implementation or deployment target identified. `direct-mac-notice-gateway-contract.ts` defines the proposed `m23-direct-mac-notice.v1` client contract, strict validators, a qualification boundary, and a non-composed dispatch adapter. This is implementation guidance and an executable client fixture, not evidence that an endpoint exists.

The v1 request binds the committed dispatch token, organization/provider/submission references, immutable render/artifact references and SHA-256, original account/usage/jurisdiction, ISA13/control identity, transaction (`81A`, `81B`, `8XC`, `8XD`), and exact recovered X12. A legacy `{ accepted, generatedFileUri }` response is rejected. A correlated durable receipt proves only a gateway/transport stage. Acknowledgment provenance separately binds the operation, dispatch, artifact, account, provider, and interchange.

Capability self-reporting is insufficient. Qualification requires a matching, current, locally approved conformance attestation and all mandatory durability/correlation capabilities. The versioned client is not constructed in `index.ts`, the qualified adapter is not injected into Workers, and the existing gateway hold is unchanged. Its tests are client unit/contract-fixture tests—not server integration or MAC sandbox results. The implementation package is [`M23_DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_V1.md`](../audits/clearinghouse-integration/M23_DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_V1.md).

### Rollout and rollback

No CM-4B.3 schema migration is required: migration 1383 already owns dispatch fencing, while 1489/1490 own the immutable identity/artifact chain. Deploy 1489 then 1490 before this application code. Mixed versions remain safe because older workers ignore the new service and current workers still hold all external notice dispatch. Existing delayed jobs are not released automatically; an operator must revalidate source, approval, route, account, deadline, and any prior ambiguous evidence after a future gateway qualification.

Rollback is an application rollback only. Preserve `claim_submission`, render identities, encrypted artifacts, delayed jobs, audit rows, and any `sending`/`in_doubt` state. Never reset a dispatch token, delete an artifact, allocate a replacement ISA13, purge a queue, or requeue an ambiguous attempt as a new upload. The current build never invokes reservation from live notice workers, so this lot itself creates no new `sending` rows.

### CM-4B internal verification procedure

From the repository root, run the focused synthetic regressions with `bunx vitest run packages/messaging/__tests__/body-crypto-ring.test.ts packages/messaging/__tests__/body-crypto.test.ts apps/backend/src/modules/23-billing-medicare/services/medicare-notice-renderer.test.ts apps/backend/src/modules/23-billing-medicare/services/medicare-notice-dispatch.test.ts apps/backend/src/modules/23-billing-medicare/jobs/direct-mac-notice-gateway-contract.test.ts apps/backend/src/modules/23-billing-medicare/jobs/m23-pre-run-hold.test.ts apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts apps/backend/src/modules/23-billing-medicare/jobs/claimmd-medicare-readiness.test.ts`. The strict changed-service check uses root compiler strictness, no unchecked indexed access, and Bundler resolution; it covers renderer, artifact store, dispatch state machine, and gateway contract. For the full project graph use the repository entry point `BUILD_NODE_OPTIONS=--max-old-space-size=6144 bun run build`, which builds in bounded child processes. A successful bundle is not a substitute for the TypeScript project check.

The M23 live RLS suite is destructive to its target schema and cluster-global runtime roles: `packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts` resets `public`, applies every migration, and uses `dropLiveRoles`. It must only run in an operator-authorized private PostgreSQL container built from `deploy/production/postgres`, on a dedicated port/database with `max_locks_per_transaction=1024`; never point `CHARTWARDEN_TEST_DATABASE_URL` at a shared Docker cluster, staging, or production. After explicit authorization and container setup, run only `CHARTWARDEN_TEST_DATABASE_URL=<private-disposable-database> bunx vitest run packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts`, capture the Vitest result, then stop and remove that private container/database. If authorization or isolated infrastructure is unavailable, leave the suite unexecuted and do not infer live RLS proof from static policies or mocks. The compliance hook must not be bypassed.

## CM-4C — lifecycle, deadlines, and user-facing status

`services/notice-deadline-policy.ts` is the server-side, read-only deadline/lifecycle projection used by NOE and NOTR list/detail APIs. It uses the persisted event date and existing `window_target_at`; it checks that the stored target is exactly five calendar days after the authoritative event rather than rewriting historical data. Calendar-day comparison is performed in the Medicare Eastern time zone. Only `accepted_at` from the existing verified acknowledgment projection can establish MAC acceptance or filing timeliness. A clearinghouse receipt, submission request, dispatch boundary, or tenant-entered external filing date cannot establish acceptance. Contradictory acknowledgment evidence and in-doubt attempts project to unknown/reconciliation-required.

### CM-4C.2 NOE exception review

`noe_exception_review` is an M23 overlay on an existing NOE, not a replacement lifecycle and not a CMS/MAC adjudication. Its category set is limited to the four hospice NOE exception circumstances described in CMS Pub. 100-04 Chapter 11 §20.1.1. Creating a review records protected M22 document references; it does not modify the NOE, its due date, filing evidence, acknowledgment, or transmission state. A recorded request is an operator-attested historical fact backed by an active beneficiary-scoped document, not an electronic MAC submission. An external decision may be recorded only by a human with recent step-up, after the request state, with an active protected document reference and an explicit `A/B MAC` or `CMS` authority. Its status says `*_recorded`, not `*_verified`: WardenX verifies the protected document's tenant/patient association and records the operator attestation, but does not inspect/independently authenticate the external decision. It never stamps NOE acceptance or changes the deadline projection.

The review has a versioned current row and append-only `noe_exception_review_event` history. Justification and supporting documents are referenced by ID only through M22's exported `DocumentReader` seam and validated under the same organization and patient; M23 stores no uploaded bytes or free-text rationale. RLS uses `app.org_id`, the NOE parent must match the organization, and the API additionally composes the existing provider-scope authorization. No MAC/CMS electronic exception-request integration exists.

The CMS categories are advisory, not an automated eligibility test. A late date alone never creates an approval. The exceptional circumstances include serious operational disruption from a disaster/unusual event, a CMS/MAC system problem outside hospice control, specified newly certified hospice/submitter-access circumstances, or another circumstance determined by the A/B MAC/CMS to be beyond hospice control. The manual also discusses processing delays that require a hospice to wait for Medicare-system updates and resubmit a returned/corrected notice within two business days after the issue is resolved. Those detailed conditions, exclusions, and evidence requirements still govern; WardenX does not infer that a category or elapsed date satisfies them. See the [CMS manual Chapter 11 §20.1.1](https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c11.pdf).

Migration 1491 adds the review and append-only event tables. It is forward-only, performs no historical backfill, does not rewrite old NOE or acknowledgment rows, and has no effect on dispatch readiness. The unified server-side worklist and full authoritative readiness aggregation remain outstanding; existing NOE/NOTR/transfer surfaces remain distinct in this lot.

CMS Chapter 11 §§20.1.1–20.1.2 are represented as a five-calendar-day window for NOE and qualifying discharge-alive/revocation NOTR, measured from the event effective date to MAC acceptance. A persisted final claim suppresses a discharge NOTR only when a qualifying 814 claim belongs to the same organization/admission and ends on that event date. Transfer-out is not an ordinary NOTR and 8xC/8xD do not receive the generic five-day classification. The projection is not an exception approval or a compliance determination. A late filing may require separate MAC exception evidence; WardenX does not grant it. See the [CMS Claims Processing Manual, Chapter 11](https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c11.pdf) and [42 CFR §418.24](https://www.ecfr.gov/current/title-42/section-418.24).

The read model adds a PHI-minimized attempt summary and an evidence timeline assembled only from persisted notice, submission, external-filing, and acknowledgment records. Render/artifact milestones are intentionally absent because those records are not joined into this lifecycle read model; the UI must not imply that an artifact was rendered merely because a notice is ready. The NOE/NOTR screens now consume server deadline/risk fields, show an evidence timeline and latest attempt, and keep external submission disabled with a visible explanation. The transfer workspace likewise states that internal readiness is not external filing. The admission detail adds a small NOE summary only for users with `billing.noe.read`; API denial/unavailability shows no billing details. Existing M6 election-addendum workflow remains separate from NOE EDI filing.

### CM-4C.2B backend worklist projection

`GET /api/v1/billing/medicare-notice-worklist` is the incremental backend contract for the upcoming worklist UI. It merges the existing organization-scoped NOE, NOTR, and transfer-notice readers; a transfer row with `action=void` is represented as `type=cancellation`, never as an ordinary transfer. The identity is `{type, noticeId}`. The signed outer cursor stores separate per-source keyset anchors and a hash of normalized filters, then each source uses its established signed `(createdAt,id)` cursor. This prevents same-UUID cross-table collisions and avoids independently concatenating per-type pages. Ordering is deterministic by creation time descending, then type and notice id ascending. The first version does not claim a global urgency sort.

The handler resolves the same effective permission set used by RBAC and excludes NOE/transfer or NOTR items unless the actor has the corresponding `billing.noe.read` or `billing.notr.read` permission. Organization scoping remains inside the source readers' `withOrgContext`/RLS boundary. Supported query filters are type, provider, patient, admission, notice state, event-date range, deadline risk, readiness state, requires-attention, and NOE exception status. Exception summaries are read in one batched org-scoped query and return status/provenance plus an evidence count only; document ids and contents are not included. The existing per-NOE history route remains authoritative for append-only history.

Readiness is deliberately non-invasive. The projection reuses the NOE/NOTR deadline and lifecycle views and transfer-specific evaluator output. It reports source and routing validation as `verification_required` instead of reading/decrypting MBI, and always reports notice transport as blocked while Claim.MD/Stedi support and the Direct-MAC artifact contract remain unqualified. A batched, organization-scoped metadata query distinguishes missing render identity, pending artifact, finalized artifact, and corrupt artifact without reading ciphertext or asking M36 for a key. Finalized metadata is not payload integrity verification and is not acceptance. This route does not decrypt X12, generate artifacts, create attempts, enqueue work, or dispatch. Attempted transfer dispatch state is included so `in_doubt` can be shown without treating transport receipt as MAC acceptance.

**Count limitation:** the current response's `counts.scope` is `returned_page`; these are page summary counts, not organization-wide totals. They are independent and may overlap. The global filtered aggregate/count query is intentionally not represented as complete by this incremental read contract and must be added before the UI labels these values as worklist-wide operational counts. `sourceValidationRequired` means source validation was not re-run (not that source data is known missing); `awaitingMacEvidence` counts only attempted notices without verified acceptance. Similarly, readiness is an honest checklist of what the read path can establish, not a full rerun of protected source validation or artifact integrity verification. A finalized encrypted artifact is reported as requiring internal integrity verification, not as verified/dispatch-ready.

Representative synthetic item (IDs are placeholders, not real people):

```json
{
  "identity": { "type": "noe", "noticeId": "00000000-0000-4000-8000-000000000010" },
  "sourceEventType": "election",
  "patientId": "00000000-0000-4000-8000-000000000020",
  "admissionId": "00000000-0000-4000-8000-000000000030",
  "providerEntityId": "00000000-0000-4000-8000-000000000040",
  "eventDate": "2026-11-10",
  "deadline": { "dueDate": "2026-11-15", "risk": "approaching", "basis": "server deadline policy" },
  "lifecycle": "ready",
  "latestAttempt": null,
  "macAcceptance": "not_verified",
  "readiness": [
    { "key": "source", "state": "verification_required", "reasonCode": "SOURCE_VALIDATION_NOT_RUN" },
    { "key": "transport", "state": "blocked", "reasonCode": "NOTICE_TRANSPORT_UNSUPPORTED" }
  ],
  "exceptionReview": null,
  "nextActions": ["open_notice", "open_noe_exception_review"]
}
```

Global counts, per-notice readiness detail route, search by patient/admission references, and provider-specific ABAC filtering remain gaps for CM-4C.2C/qualification. No migration is added. The earlier NOE exception API, its protected-document validation, step-up for external request/decision recording, and operator-attested decision provenance are unchanged.

Existing M23 watchdogs continue to emit deduplicated deadline alerts (approaching and breached) and existing typed transport-hold alerts remain authoritative. The new UI projection does not create a second alert system and does not close a deadline alert on upload/request alone. The M23-CM-4C.2B backend adds a cross-type paginated worklist and safe readiness projection, but global operational counts, complete routing/enrollment aggregation, per-notice readiness detail, provider ABAC filtering, and the unified reviewer UI are still incomplete. No database migration was needed. External dispatch remains held: Direct MAC requires gateway qualification; Claim.MD and Stedi notice transactions remain `CH_NOT_WIRED`. Full backend typecheck, production-like build, and application-role PostgreSQL/RLS integration remain release qualification gates, not inferred from focused tests.
