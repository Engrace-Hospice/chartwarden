# Module 10 (HOPE Engine) — DR Tier + Integration Inventory + STRIDE

M10-T07 (spec §4.10, §4.10.1, §5.6, §7.9, §7.10). Companion to the module code; cross-references
`docs/architecture/CHARTWARDEN_DR_BCP_v0.1.md`, `CHARTWARDEN_INTEGRATIONS_v0_1.md`, and the CMS HOPE submission
spec. M10 is the first Wave-E module with a **real external integration** (iQIES); the split-tier posture
below is the load-bearing design choice.

## DR posture — **split-tier** (M10-F19 / DR-066/067 / §5.6 — confirmed binding in the spec header)

HOPE timepoint **capture** and iQIES **submission** are deliberately decoupled subsystems with different
DR tiers. A missed timepoint window is *irreversible* HQRP non-compliance (4-point APU exposure), so
capture must survive degradation; a 30-day CMS submission deadline gives submission ample recovery slack.

| Path | Tier | RTO | RPO | Rationale |
|---|---|---|---|---|
| **HOPE timepoint capture** (`recordTimepoint`, the answer patch that opens an SFV obligation, signing) | **2** | **≤ 4 h** | **≤ 15 min** | Bedside recording must continue during degradation — a missed window cannot be recovered after `late_deadline_at`. |
| **iQIES submission** (`assemble` → `iqies-submit-worker` → `iqies-reconcile-worker` → `submit-correction-rfa`) | **3** | **≤ 24 h** | **≤ 1 h** | CMS 30-day deadline absorbs a full-day outage with no regulatory consequence; an iQIES outage never affects care delivery. |

**Tier-2 constraint (DR-010).** No external dependency — M36 alert delivery, M38 terminology seam, M9
`LatestAssessmentProvider`, **or the iQIES adapter** — may block the `recordTimepoint` write path.
`recordTimepoint` inserts the draft in one transaction and calls none of them. The SFV obligation row is inserted by the
answer patch that makes the J2051 trigger fire (`hope-sfv-service.ts`), in that patch's transaction, with
`m10.hope.sfv_created` written to the outbox in the same transaction, so the obligation exists even without alert
delivery. `signTimepoint` reads the M9 snapshot before its write transaction, never inside it. The iQIES adapter sits
entirely on the Tier-3 path — `hope_assessment` writes never depend on adapter health (spec §35 / §5.6).

### Degraded-mode behaviour (§5.6)

| Dependency down | M10 capture-path behaviour |
|---|---|
| M36 (alert delivery) | Assessment records normally; `m10.hope.timepoint_signed` / `m10.hope.j2051_trigger_fired` / `m10.hope.sfv_created` land in the outbox; M36 drains on recovery. The SFV row is inserted in the same transaction — the obligation exists even without alert push (the dashboard reads `symptom_follow_up_visit` rows directly). |
| M9 (`LatestAssessmentProvider`) | The PPS/ESAS-r snapshot is omitted; a `hope_validation_finding` `severity='warning'` is written when the admission's provider entity / location siting resolves (D8 / §7.13); when it does not, a log line says so and no finding is stored. The assessment still proceeds to `signed`. |
| M38 (terminology seam) | No capture write waits on M38; only pre-submission validation (`validation/run-validation.ts`) reads it. A failed read (or an unbound seam) logs one error line (value-set id and error class) and the check it feeds is reported "unavailable", never as a finding. **Not built:** a last-cached value set, and any `revalidate-on-terminology-update` body (a catalog row only in `jobs/index.ts`; nothing binds it). |
| BullMQ (Valkey) | Scheduling + watchdog + submission crons pause. The recording transaction does not use BullMQ. Open windows / overdue SFVs / queued submissions remain visible in the DB; the dashboard reads them directly. |
| **iQIES adapter (Tier 3)** | **Capture is unaffected.** The rest of this row is the automated-transport design: the `assemble-hope-submission` / `iqies-submit-worker` / `iqies-reconcile-worker` runners exist but are not registered, scheduled or given a Worker in this tree (the manual iQIES package flow is the transport; `registerM10CronWorkers` in `jobs/cron-workers.ts` constructs a Worker only for the windows, sfv and retention queues). Queued submissions accumulate; `iqies-submit-worker` retries per §4.8.1; the per-PE circuit breaker (`IQIES_CIRCUIT_BREAKER_CONFIG`) holds open while the adapter is down and throws a retryable `DegradedError` so BullMQ re-queues with backoff; §4.10.1 specifies a `system.integration_failure` alert from M36 when the circuit opens (5 failures inside 30 s, `IQIES_CIRCUIT_BREAKER_CONFIG`), but nothing raises it: the alert rule is seeded in `packages/messaging`, and no code under `apps/backend` emits the event. The 30-day deadline gives headroom (§7.10). |

### BCP re-entry (DR-066/067 — 72-hour window, §5.6)

Paper-captured HOPE timepoints from a declared-disaster outage are re-entered as ordinary captures through
`POST /admissions/:admissionId/hope/timepoints` (`recordTimepoint`); there is no BCP-specific path. The capture gate
judges lateness and the hard cutoff on the LATER of the client's `targetDate` and the server's now (GAP-015,
`assertCaptureAllowed` / `captureInstantOf`), so a paper-origin record dated inside the outage is NOT accepted verbatim:
re-entered after the schedule's `window_closes_at` it is a late capture that needs a typed late-completion reason from
the existing codelist, and re-entered after `late_deadline_at` it is refused (`409 M10_TIMEPOINT_EXPIRED`) unless a holder
of `hope.admin.late_deadline_override` lifts the cutoff for that one capture. The override writes the critical
`hope.late_deadline_override` audit event, which records the admin's typed justification (screened for patient
identifiers; it carries no `lateOverrideReason`); it does not move the schedule's own deadline.
72-hour enforcement is organisational, not technical.

**Not built** (no source file under `apps/`, `packages/`, `scripts/` or `architecture/` defines or emits any of these
names; they appear only in markdown design text, this file and the module specs included): an outage late-reason code
`"system_outage"` (the codelist is `LATE_COMPLETION_REASON_CODES` in `packages/hope/src/recording/timepoint-gate.ts`),
the paper-origin marking `data.Z.bcpPaperOrigin` / `data.Z.bcpPaperFormReference`
(`packages/hope/src/sections/Z/schema.ts`, which the spec cites, does not exist), the
`m10.hope.paper_origin_transcribed` event, the HQRP dashboard's BCP Re-entry panel with its 72 h amber warning, and the
`lateOverrideReason: "system_outage_bcp"` marker (spec §5.6 item 5). A re-entered paper record is therefore recorded like
any other late capture, with nothing marking it as paper-origin.

### Mobile offline (manifest-exempt — server path only, this task)

`hope_assessment_draft` lives in the shared `@chartwarden/mobile-offline` sqlcipher store (SEC-075; AES-256-CBC,
PBKDF2-SHA256 100k, salt = `org_id || device_id`; evict-PHI-on-logout; no IndexedDB fallback). It is **not**
in any codePath and is **not** fitness-governed (deferred in Phase 0). M10-T07 builds only the server-side
submission path; the sync-on-reconnect worker POSTs `synced=0` drafts to
`POST /admissions/:admissionId/hope/timepoints` with `draft_id` as the `Idempotency-Key`.

## Integration inventory — cross-module + external couplings

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| **integrate** | **iQIES (CMS, external)** | `@chartwarden/iqies-client` adapter (D6) — `submitBatch` / `fetchAcceptanceReport` / `submitCorrection`; the ONLY package allowed to talk to iQIES; per-PE circuit breaker + typed `DegradedError` (§4.10.1). Design of the automated transport: the manual package flow in use does not call it | yes (envelope XML; MinIO in the automated design, a database column in the manual flow) |
| publish | M14/M22/M28/M30/M33/M36 | `m10.hope.*` outbox events (§2.4 / events-by-m10.ts) — timepoint signed/expired, J2051 trigger, SFV created/overdue/missed, submission queued/transmitted/accepted/rejected, correction submitted | minimal (ids); submission alerts feed §4.9 M36 |
| serve | M14 (IDG), M22 (Documents), M30 (HQRP), M32 (AI) | `HopeTimepointProvider` / `HopeJ2051Provider` / `HopeSubmissionProvider` seams (§2 / D10) | yes (ids) |
| consume | M9 (Assessments) | `LatestAssessmentProvider` seam — PPS/ESAS-r snapshot at HOPE sign (D8); never inline on the capture path (Tier-2 constraint) | yes (ids) |
| consume | M6 (Admission) | admission activation timestamp + `level_of_care_period` anchor the timepoint windows; `admission.discharged` outbox drives the Discharge RFA | minimal (ids) |
| consume | M38 (Terminology) | HOPE J-code / hospice-diagnosis value sets for pre-submission validation (`asOfDate` lookups) | no |
| consume | M36 (Messaging) | typed-alert payloads (§4.9) — timepoint-window / SFV / submission-deadline / `system.integration_failure` (the last is specified for the automated transport, which is not wired: nothing emits it today); never inline on the capture path | minimal (ids) |
| consume | M5 (Patient) | `medicare_beneficiary_identifier` for the iQIES envelope MBI cross-check; deceased status drives the Discharge-by-death RFA | yes (ids) |
| consume | M34 (SaaS Platform) | per-ProviderEntity iQIES submitter credentials from M34's secret store (M10 does not own the onboarding UX) | no (credentials never logged) |

Notes:
- **iQIES is M10's only external integration.** Per CHARTWARDEN_INTEGRATIONS §3.2 (INT-009), the adapter
  declares its circuit-breaker config (`IQIES_CIRCUIT_BREAKER_CONFIG`) and exposes the typed five-field
  `DegradedError` — a raw `fetch` rejection never propagates to an M10 caller. Phase 1 ships the typed
  adapter surface + the deny-stub `createUnboundIqiesAdapter()` (throws `retryable: false` → immediate DLQ);
  the live transport binds with M34's per-tenant credentials. **No `dependsOn` edge** is created by the
  adapter — `packages/iqies-client` is an M10 codePath (D6), not a cross-module dependency. M10 `dependsOn`
  stays `[1, 9, 36, 38]`.
- **Automated-transport design (not built; see the iQIES row above):** the submission envelope (PHI-bearing CMS HOPE XML)
  is stored under
  `tenants/<org_id>/iqies-envelopes/<provider_entity_id>/<submission_period>/<submission_id>.xml.enc` with
  `COMPLIANCE` object-lock (10 years) + lifecycle expiry (12 years) per §4.10.1 (SD-033/034). The DB records
  only the object key (`hope_submission.envelope_storage_uri`) + the SHA-256; reads go through the M4
  audit-read presigned-URL proxy. **The manual flow in use** (`assembleSubmission`) stores no MinIO object: it writes the
  deterministic ZIP as a `db://hope_submission/<submission_id>/package` URI on the batch
  (`package_storage_uri` / `envelope_storage_uri`) with the bytes base64 in `hope_submission.acceptance_report`, so
  neither the object lock nor the lifecycle expiry applies to it.
- **Per-PE blast radius (§4.10).** A 401/403 from iQIES for one ProviderEntity opens only that PE's breaker;
  other PEs submit independently. iQIES submitter credentials never appear in audit logs or error envelopes
  — the audit payload records only the ProviderEntity id + the envelope SHA-256.
- All logs are PHI-free by construction: `assessment_id` / `submission_id` / `provider_entity_id` /
  `org_id` UUIDs + enums + the envelope SHA-256 only — never the envelope XML, the `data` payload, or the
  iQIES validation free-text.

## STRIDE highlights (§8.5)

- **Spoofing (S):** the iQIES submitter credential is resolved per-PE from M34's secret store, never
  client-supplied; the recorder is the session-bound author membership, never a request field.
- **Tampering (T):** `hope_assessment` rows are immutable once signed — a correction is an append-only new
  row with `corrects_assessment_id` + a supersede trigger on the original (D7); the original is never
  UPDATE-d, and the iQIES Correction RFA references it by `iqies_record_id`. The transmitted envelope's
  SHA-256 is recorded so a stored-envelope tamper is detectable.
- **Repudiation (R):** every iQIES submission emits `hope_submission.transmitted` with the envelope SHA-256;
  per-row author + the M4 write-audit trigger's before/after diff back the clinical record.
- **Information disclosure (I):** in the automated-transport design the envelope is encrypted at rest (MinIO SSE +
  per-tenant DEK) under WORM object-lock (the manual `db://` package lives in a database column, under RLS); `DegradedError` and out-of-band M36 alerts carry only integration / operation / correlation
  id (no PHI, §4.9.1); credentials are redacted from every log + error envelope.
- **Denial of service (D):** the per-PE circuit breaker fails fast on iQIES outage (no retry storm); BullMQ
  exponential backoff + the `hope:submission.dlq` (depth-alert) bound retries; the capture path never touches
  the adapter so a submission-side DoS cannot starve bedside recording.
- **Elevation (E):** `hope.submission.manage` (assemble/retry) is Compliance-Officer / Platform-Admin only
  (§6); RN/NP cannot trigger submission. The HOPE-author discipline rule (RN/NP/MD; SFV RN/NP/LPN/LVN) is a structural floor on capture.
- **Cross-tenant:** RLS on all six owned tables keys on `app.org_id` with `WITH CHECK`; even with RBAC/ABAC
  stubbed open, RLS alone blocks the cross-tenant read; a forged id returns 404 (RLS-hidden), never 403.
  In the automated-transport design the MinIO `tenants/<org_id>/` prefix isolates envelopes at the storage layer.

## Destruction (`hope_assessment` data class, §8.4 / D7)

The HOPE data class is erased ONLY through the M4 destruction-cert workflow (M10-T08 eraser). The eraser refuses
(`HopeRetentionBlockedError`) while a submitted assessment is still inside the CMS 10-year retention horizon (the
`extended_for_cms` retention class) unless a legal-hold override is supplied. It deletes the assessments, schedules,
SFVs and validation findings; the `hope_submission` / `hope_submission_item` rows SURVIVE the erase as compliance
evidence. A manual `db://` package lives in `hope_submission.acceptance_report`, which M4's envelope-purge worker never
touches (only a cancel deletes those bytes, together with each item's XML, and not while an M4 legal hold applies to the batch:
a cancelled package was never transmitted, so it has no CMS 10-year hold; the bytes of every non-cancelled batch outlive a
destruction certificate); an automated-transport envelope in MinIO is that worker's to purge. The cancel purge is a LOGICAL
deletion (NULLed jsonb: dead tuples until vacuum, and WAL, replicas and backups until their own retention expires), so a
backup restored from before the cancel holds the bytes again.
`scale_license`-equivalent org configuration is not patient data and is never touched.
