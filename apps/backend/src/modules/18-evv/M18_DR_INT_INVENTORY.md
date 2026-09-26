# Module 18 (Electronic Visit Verification) — DR Tier + Integration Inventory + STRIDE

M18-T07 (spec §8.3, §8.4, §8.8). Companion to the module code; cross-references
`docs/architecture/WARDENX_DR_BCP_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`,
`WARDENX_SECURITY_HARDENING_v0_2.md`, and the M18 spec. EVV is the **electronic substantiation of physical
service delivery** — the Cures Act §12006 six-element record that turns a Medicaid-billable hospice claim from
"pending review" into "payable", and the authoritative driver of the M17 visit lifecycle (`check_in` advances
`published → en_route → in_visit`, `check_out` completes it). Because a check-in is the field clinician's first
action at the door and a lost EVV bracket directly blocks billing (§8.8 M18-F10), `evv_event` carries a higher
durability priority than M17's `visit` row — hence Tier 1.

## DR posture — **Tier 1** (spec §8.8 M18-F10 / DR-BCP §3.2; DR-010, DR-064)

- **RTO:** 1 hour from declared disaster to M18 API accepting capture posts + serving reads.
- **RPO:** 5 minutes — `evv_event` is the billing-substantiation artifact; the synchronous-replication tier
  bounds capture loss to 5 minutes at switchover. The device-side SQLCipher offline queue (D5) is the second
  line: any capture not yet acknowledged at switchover re-posts on reconnect through the idempotency-keyed
  `(orgId, deviceId, localId)` route, so an in-flight check-in is **not** lost even inside the RPO window.
- **Recovery order:** M1 (Foundation, Tier 1) + M4 (Audit, Tier 1) + M2 (Identity/device-attestation, Tier 1)
  must be available before M18 recovers. `validateSeams()` requires the M5/M17/M40 (+ M1) seams reachable
  before M18 accepts live traffic; in a partial DR scenario M18 starts in **degraded mode** (capture-continue,
  aggregator-queue-hold) rather than refusing field clinicians.

| Path | Tier | RTO | RPO | Rationale |
|---|---|---|---|---|
| **Capture write** (`POST /evv/check-in`, `/check-out`, `/offline-sync`) | **1** | **≤ 1 h** | **≤ 5 min** | The Cures Act verification event. Idempotency-keyed on `(orgId, deviceId, localId)` (D5) + the M1 header gate (M18-F11), so retries + offline drains are no-ops; the device queue continues capturing through a full backend outage. |
| **EVV read** (`GET /evv/events`, `/events/:id`, `/visits/:id/bracket`, the six §4.3 reader seams) | **1** | **≤ 1 h** | **≤ 5 min** | The M8 `encounter.period` bracket (M8 D9), the M17 visit-state driver, and the M23/M24 billing pre-submission gate all read these — read-only against the DR replica even while writes are suspended. Coordinates decrypt only on the `evv.read_coords` path (D10). |
| **Late-checkout resolution** (`/missing-resolutions`, clinician-attest / supervisor-override; the §2.2.4 D6 machine; `late-check-sweep` cron) | **2** | **≤ 4 h** | **≤ 5 min** | An `open` resolution blocks billing (ADR-0008) but is not on the capture critical path; the sweep re-derives open rows idempotently on `(visit_id, kind='missing_checkout')` on recovery. |
| **Aggregator submission** (the §2.2.5 D7 machine; per-state BullMQ workers; `packages/evv-aggregators`) | **2** | **≤ 4 h** | **≤ 5 min** | Outbox-only handoff (D11) — the submission queues during an aggregator/vendor outage and drains on recovery; idempotent on `(state_code, visit_id, event_pair_hash)` so a replay never double-submits. Never on the user's check-out latency path. |
| **Downstream fan-out** (`m18.evv.*` → M8/M17 transitions, M19/M25 Phase-2 inert, M22 PDF, M30 quality; the §4.9 M36 alerts) | **3** | **≤ 24 h** | **≤ 5 min** | The outbox + BullMQ own retry backoff; a consumer outage never blocks a capture. M19/M25 forward consumers deny-stub until those modules lock — fail-closed. |

### Degraded-mode behaviour (§8.8 M18-F10)

| Dependency down | M18 behaviour |
|---|---|
| Primary DB failover; DR replica available | **Capture-continue:** the device SQLCipher queue (D5) holds check-in/check-out locally; reads serve from the DR replica (Tier-1 RTO 1 h). M36 renders the "EVV running in offline mode" banner. On primary promotion the sync worker drains the queue idempotently; no event is lost inside the 5-min RPO. |
| State aggregator (vendor endpoint / circuit open) | **Aggregator-queue-hold:** submissions stay `queued`/`submitting`; the per-state worker retries per the adapter-owned backoff (the §4.8 per-state override). `aggregator_timeout` emits the M36 critical alert to billing-ops + platform-ops; capture + visit lifecycle are unaffected (D11 outbox-only). |
| M5 (`PatientAddressReader` geocode) | Per §1.2 — a null geocode baseline flips the geofence to **advisory-not-enforcing** for that visit; the check-in still records with `gps_quality='no_geofence_baseline'` and the compliance metric counts it partial. Never blocks the visit. |
| M2 (`device_attestation`) | The D8 integrity gate **fails closed** — a device whose latest attestation cannot be read cannot post (`DEVICE_INTEGRITY_FAILED`); the offline queue holds the capture until attestation is reachable. Security posture over availability for the integrity gate only. |
| M36 (alert delivery) | Capture + resolution proceed; the §4.9 late-checkout / geofence-breach / GPS-spoof / device / aggregator alerts land in the outbox and M36 drains on recovery. The web read screens show the obligation without alert push. |
| M40 (`StateAggregatorConfig` catalog) | A state whose aggregator vendor cannot be resolved holds its submissions `queued` (never mis-routes to the wrong vendor); open-model states (`aggregator_submission_required=false`) short-circuit and are unaffected. |
| BullMQ (Valkey) | The `late-check-sweep`, `gps-spoof-detector`, and per-state aggregator workers pause; capture reads/writes do not require BullMQ and continue. The sweep re-derives open resolutions on restart (idempotent). |

## Integration inventory — cross-module + external couplings

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| consume (seam) | M5 | `PatientAddressReader.geocodedAddressFor` (the geofence baseline coordinate; M18 never geocodes — M5 owns it) | yes (address coords) |
| consume (seam) | M2 | `device_attestation` latest row (the D8 integrity gate; jailbroken/rooted/invalid → `DEVICE_INTEGRITY_FAILED`) | minimal (device ids) |
| consume (seam) | M40 | `StateAggregatorConfig` per-state vendor + operating-model catalog (the `StateAggregatorRegistry` selects the `packages/evv-aggregators` adapter) | no (master data) |
| consume (external, adapter) | State Medicaid aggregator (Sandata / open-model; `packages/evv-aggregators`) | `EvvAggregatorAdapter.submit`/`poll` — the only place the per-state endpoint/credentials/payload live (D1); BullMQ worker-driven, outbox-only (D11) | yes (visit + service record) |
| serve (seam) | M8 | `EvvBracketResolver.resolveBracket` (**CLOSES M8's `encounter.period` EVV-bracket forward seam, M8 D9**) | yes (ids + timestamps) |
| serve (seam) | M23/M24/M30 | `EvvComplianceReader` (billing pre-submission gate + HQRP measure) | minimal (ids) |
| serve (seam) | M24/M25 | `EvvAggregatorReferenceReader` (claim EVV-reference + denial categorization) | minimal (ids) |
| serve (seam) | M20 | `EvvLocationProvider.lastKnownLocationForClinician` (the **only** coordinate-bearing seam, D10; discrete check-in/out coords, never continuous track) | yes (coords) |
| serve (seam) | M30/M33 | `EvvMetricsProvider` (compliance / late-checkout / geofence-deviation / GPS-spoof / aggregator-acceptance rates) | minimal (ids) |
| serve (seam) | M31 | `EvvVerificationProvider` (the portal arrival surface — **timestamp only, no coordinates / no clinician / no device**, §5.3) | minimal (timestamp) |
| publish | M8/M17 | `m18.evv.check_in_recorded` / `check_out_recorded` (**close the M8 bracket, M8 D9; drive the M17 visit transitions, D14**) + `at_patient_address` (M17 geofence confirmation) + `event_corrected` | yes (ids + timestamps) |
| publish | M22 | `m18.evv.aggregator_accepted` / `verification_pdf_requested` (the D11 PDF-render trigger — M18 has no PDF code) | minimal (ids) |
| publish | M36 | the §4.9 typed alert payloads (late-checkout / geofence-breach / GPS-spoof / device pending+suspended / aggregator rejected+timeout); out-of-band channels carry NO PHI (M18-F16) | minimal (ids + first name); reasons scrubbed (§3.6) |
| consume (outbox) | M17 | `m17.visit.published` (seed the EVV bracket placeholder) / `m17.visit.cancelled` (cancel pending aggregator submissions) — string-literal topics, no `dependsOn` edge (D14) | yes (ids) |
| consume (outbox) | M8 | `m8.encounter.signed` → the `closed_documented_at_encounter` resolution marker for a self-attested visit (M8 D9 / §2.2.4) | yes (ids) |
| forward (deny-stub) | M19 (Phase 2) | on-call triage consumes `m18.evv.late_check_out_detected` when it locks — M18 emits to the outbox today | minimal (ids) |
| forward (deny-stub) | M25 (Phase 2) | denial-management consumes `m18.evv.aggregator_rejected` when it locks | minimal (ids) |

## STRIDE — see spec §8.3 (authoritative)

The spec §8.3 STRIDE map + the §6 per-role permissions matrix are authoritative (and a §9 test blocker). The
DR/security-relevant mitigations:

- **Spoofing — a clinician posts EVV for a visit they are not assigned to:** the two §4.7 capture predicates
  `assigned_clinician_for_visit` ∧ `evv_within_visit_window` gate `evv.check_in`/`evv.check_out` over the
  session membership + the M17 visit window; a non-assigned membership cannot capture.
- **Spoofing — GPS coordinate falsification:** the device integrity gate (D8) refuses jailbroken/rooted devices;
  the `gps-spoof-detector` (D9) flags `gps_quality='suspected_spoof'` (advisory, never auto-reject — a false
  positive must not block a real visit) and routes the M36 warn alert to the Clinical Supervisor.
- **Tampering — altering a recorded EVV event:** `evv_event` is append-only (the M4 audit trigger denies
  UPDATE/DELETE; GRANT is SELECT,INSERT only); corrections take the correction-of-record pattern (a new event
  with `replaces_event_id`, Clinical Supervisor+ step-up, §2.3) — never an in-place UPDATE.
- **Repudiation — who resolved a missing checkout / cancelled a submission:** the M4 PHI write-audit trigger
  captures actor + reason marker on every resolution / submission transition; the attest/override/cancel reasons
  are denylisted free-text (§3.6) but the transition + resolver membership are recorded.
- **Information disclosure — coordinate leakage (D10):** lat/lng is per-tenant DEK-envelope-encrypted at rest
  (`coords_cipher`); the audit trigger captures the `<changed>` marker only, never plaintext coords; reads
  require the explicit `evv.read_coords` permission (separate from `evv.read`); the web read surfaces + the M31
  portal projection are coordinate-free; the M28 FHIR projection gates coords behind `consent.evaluate('share_coords')`.
- **Information disclosure — alert OOB channels (M18-F16):** push/SMS carry only a generic prompt + an
  authenticated deep-link; no PHI payload crosses the out-of-band channel regardless of severity.
- **Elevation of privilege — AI-authored EVV (D13):** Module 32 cannot create/modify/witness/resolve any M18
  row — boot-time rejects any M32 prompt template whose `outputType` matches `evv_*`; dependency-cruiser blocks
  `packages/ai-platform/*` imports from `apps/backend/src/modules/18-evv/*` and `packages/evv-aggregators/*`;
  the per-route guard rejects `actor_kind='ai_*'`. An AI-generated EVV event would be fraud per Cures Act
  §12006 / 42 CFR §455.20.
- **Cross-tenant / IDOR:** every read/write is org-pinned server-side (`request.context`, never the body); an
  out-of-scope event/visit returns `404` (IDOR-disambiguation); RLS keyed only on `app.org_id` is the
  layer-independent backstop (§9.3/§9.4).
- **Right-to-erasure:** the `evv_record` eraser (§8.4) cryptographically shreds the per-tenant DEK and drops the
  patient-scoped rows; the `compliance` retention class governs because the EVV record is the billing-
  substantiation artifact (longer hold than `operational`).
