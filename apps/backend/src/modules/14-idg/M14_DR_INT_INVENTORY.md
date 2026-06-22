# Module 14 (Interdisciplinary Group / IDG) — DR Tier + Integration Inventory + STRIDE

M14-T07 (spec §4.12, §8.4, §8.5). Companion to the module code; cross-references
`docs/architecture/WARDENX_DR_BCP_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`,
`WARDENX_SECURITY_HARDENING_v0_2.md`, and the M14 spec. IDG meetings are scheduled in advance and the IDG
decision burst is the legally-actionable output that drives care-plan / order / medication change downstream
(M7/M11/M12), but a live meeting is unlikely to coincide with the first hours after a major failure — so the
read path (packet snapshots, minutes) carries the availability priority and the write/lifecycle path is
recoverable by coordinator replay.

## DR posture — **Tier 2** (spec §8.5 / DR-BCP §3.2)

- **RTO:** 4 hours from declared disaster to M14 API serving read requests.
- **RPO:** 1 hour — the most recently committed `idg_patient_packet` and `idg_decision` rows may be up to 1 hour
  behind the primary at switchover. Meeting-lifecycle writes from the past hour (scheduled / started / decisions
  recorded-but-not-yet-adjourned) may be lost and are recovered by coordinator replay; the M4 audit log
  (synchronously replicated, Tier 1) is the reconstruction source.
- **Recovery order:** M1 (Foundation, Tier 1) and M4 (Audit, Tier 1) must be available before M14 recovers. M14
  shares the M1 Valkey cluster; BullMQ in-flight jobs are not replicated — workers re-queue from the outbox on
  startup. `validateSeams()` requires the M5–M12, M36, M38–M40 seams reachable before M14 accepts live traffic;
  in a partial DR scenario M14 starts in **degraded mode**.

| Path | Tier | RTO | RPO | Rationale |
|---|---|---|---|---|
| **Packet / minutes read** (`GET /meetings/:id/packets`, `.../packets/:patientId`, `/minutes`, and the three §4.8 seams) | **2** | **≤ 4 h** | **≤ 1 h** | Served directly from `idg_patient_packet` / `idg_minutes` — frozen snapshots are survey-reconstruction artifacts with no live upstream dependency. Available read-only against the DR replica even while writes are suspended. |
| **Meeting lifecycle write** (schedule materialise / start / adjourn-burst / decision record / attendance / action-item) | **2** | **≤ 4 h** | **≤ 1 h** | The adjournment burst is the actionable output; it requires the `idg.decision-emitter` BullMQ queue (Valkey). In a Valkey outage the adjourn route returns `503 QUEUE_UNAVAILABLE` and the coordinator retries on recovery — the burst is transactional (all-or-nothing, §7.5), never partial. |
| **Downstream fan-out** (`idg.decision_recorded` → M7/M11/M12; `m14.*` → M36 alerts; M22 minutes/packet PDF; M28 FHIR CareTeam/Encounter) | **3** | **≤ 24 h** | **≤ 1 h** | The outbox + BullMQ own the retry backoff; a consumer outage never blocks an adjournment. M22/M28 forward seams deny-stub until those modules lock — fail-closed, never a partial document/resource. |

**Tier-2 constraint.** Packet read-availability must not depend on any upstream seam module being live: the
read paths serve the already-built `idg_patient_packet` / `idg_minutes` rows directly. The packet *build* (§7.2,
the eleven-seam join across M5–M12 + the cached projection) is a pre-meeting batch job, not on the read path —
in degraded mode an unbuilt packet stays `draft` and the meeting holds at `packets_building` until the upstream
seams recover, rather than blocking reads of already-frozen packets.

### Degraded-mode behaviour

| Dependency down | M14 behaviour |
|---|---|
| Primary DB failover; DR replica available | Full **read** availability against the DR replica (Tier-2 RTO 4 h) — frozen packets + finalized minutes are read-only survey artifacts with no upstream dependency. Writes suspended until the primary is promoted. |
| M36 (alert delivery) | Lifecycle proceeds; the packet-ready / action-item-assigned / carry-forward-compliance / non-quorate / review-clock alerts (§4.10) land in the outbox and M36 drains on recovery. The schedule / action-item read screens show the obligation without alert push. |
| M5–M12 seams (packet-build inputs) | Already-frozen packets read normally; a new packet build holds (`packets_building`) until the seams recover. Fail-soft — never a partial snapshot. |
| M39 (`ConsentEvaluator`, 42 CFR Part 2) | The SUD redaction gate (W-SUD-01) is **fail-closed** on the *read* projection: if the Part 2 consult is unavailable the SUD-flagged blocks are elided (the safe default), the response carries `appliedSudRedaction=true`. |
| BullMQ (Valkey) | Schedule materialisation, T-24h packet build, the decision-emitter burst, carry-forward sweep, and the eraser pause. Packet/minutes reads do not use BullMQ and continue. The adjourn route returns `503 QUEUE_UNAVAILABLE` until Valkey recovers (§8.5). |

## Integration inventory — cross-module + external couplings

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| consume (seam) | M5/M6/M7/M8/M9/M10/M11/M12 | the eleven §7.2 packet-build reads (patient spine, admission, care plan, signed encounters since-last-IDG, assessment/HOPE summaries, orders, medications) — M14 never imports their schema | yes (ids + narrative) |
| consume (seam) | M39 / M5 | `ConsentEvaluator` (42 CFR Part 2 SUD gate at packet read, W-SUD-01) — fail-closed on the read projection | yes (ids) |
| serve (seam) | M22/M28/M30/M33 | `IdgPacketProvider` (packet snapshot + M22 render handshake) + `IdgDecisionProvider` (decision read) + `IdgScheduleProvider` (schedule + 15-day-cadence read) registered in the M1 registry (§4.8) | yes (ids) |
| publish | M7/M11/M12 | the canonical **`idg.decision_recorded`** outbox event (the adjournment burst, §4.4 / events-by-m14.ts) — **wires live the M7/M11/M12 decision consumers** declared inert in Waves C–E | yes (ids + decision payload) |
| publish | M36 | `m14.*` outbox events + the §4.10 typed alert payloads (packet-ready / action-item-assigned / carry-forward-compliance / non-quorate / review-clock / review-floor-override) | minimal (ids); free-text scrubbed (§7.6) |
| consume (outbox) | M6/M7/M8/M9/M10/M11/M12 | M6 inclusion cache; the M7/M8/M11/M12 D8 action-item auto-close (an item linked to a downstream artifact closes when that artifact reaches an absorbing state); the M9/M10/M11/M12 "since last IDG" projection cache (§4.5 / consumers/) | yes (ids) |
| forward (deny-stub) | M22 (Wave F) | `IdgPacketProvider` render handshake for the minutes/packet PDF — payload shaped here; M22 subscribes to `m14.*.document_requested` when it locks, no `dependsOn` edge | minimal (ids) |
| forward (deny-stub) | M28 (Wave H) | FHIR `CareTeam` / `Encounter` projection of the adjourned meeting — consumes `idg.decision_recorded` / `m14.meeting.adjourned` when it locks | minimal (ids) |

## STRIDE — see spec §4.12 (authoritative)

The spec §4.12 STRIDE map + per-role authorization test matrix are authoritative (and a §9 test blocker). The
DR/security-relevant mitigations:

- **Spoofing — attendance / quorum:** the `membership_id` on a self check-in is derived server-side from the
  session token, never the request body; the `discipline` is re-read from the M40 canonical catalog
  (`422 DISCIPLINE_MISMATCH`), not the caller-supplied value; the `quorum_snapshot` jsonb freezes the exact
  present-set at decision-write time so a fraudulent attendance row is traceable in the M4 audit log.
- **Tampering — decision payload:** TypeBox discriminated-union validation at route entry
  (`422 DECISION_PAYLOAD_INVALID`); `If-Match` + `Idempotency-Key` optimistic lock on `PATCH /decisions/:id`
  (stale → `412`); the adjournment-burst emitter reads the *stored* row, not the original request, to build the
  `idg.decision_recorded` envelope, so tampering between PATCH and ADJOURN is blocked.
- **Tampering — packet snapshot:** `frozen_at` is set in the same transaction as the outbox burst;
  `buildPacketSnapshot` / the build route refuse a frozen packet (`422 PACKET_FROZEN`, W-PKT-02); direct SQL
  writes are blocked by RLS and would be captured by the M4 audit trigger.
- **Repudiation — adjournment:** the adjourn route requires a **fresh step-up ≤ 5 min** (D13;
  `412 STEP_UP_REQUIRED` otherwise), tied to an M2 session-event with the meeting id; the `idg_minutes` row
  stamps `finalized_by_membership_id` + `finalized_at`; the M4 `m14.meeting.adjourned` audit event closes an
  immutable cross-reference chain (step-up log → audit event → minutes → attendance).
- **Information disclosure — packet PHI:** `idg_meeting_scope` (location) + `caseload_or_scope` (per-patient)
  ABAC gate every read; the SUD gate (W-SUD-01) elides Part 2-flagged blocks at the **SQL-filter level** before
  data leaves the DB; cross-org reads return `404` (IDOR-disambiguation), and RLS keyed only on `app.org_id` is
  the layer-independent backstop (§9.3).
- **Elevation of privilege — cross-location:** `idg_meeting_scope` resolves the meeting's `location_id` against
  the caller's location memberships and returns `403` for a cross-location lifecycle transition; the
  auditor-engagement exception applies to **read** routes only, never to start/adjourn/cancel/reschedule.
- **Right-to-erasure:** the `idg_record` destruction-cert eraser (§8.4) deletes the patient-scoped packet /
  decision / action-item / agenda rows; the caseload-wide `idg_meeting` / `idg_recurring_policy` /
  `idg_attendance` / `idg_minutes` / `idg_minutes_amendment` rows survive (a meeting is not a single patient's
  record; minutes patient references are hash-redacted by the M4 trigger, not deleted).
