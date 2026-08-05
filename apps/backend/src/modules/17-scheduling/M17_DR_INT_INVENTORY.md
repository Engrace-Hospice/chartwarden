# Module 17 (Scheduling & Route Optimization) — DR Tier + Integration Inventory + STRIDE

M17-T08 (spec §8.3, §8.4, §8.5). Companion to the module code; cross-references
`docs/architecture/WARDENX_DR_BCP_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`,
`WARDENX_SECURITY_HARDENING_v0_2.md`, and the M17 spec. Scheduling is **operational** infrastructure — the
field clinician's "My Visits" / day view is the first surface they need after a failure, and an EVV check-in
(M18) brackets a visit only if the visit row is reachable — so the read path (visits, day/week views) carries
the availability priority. Route optimization is OFF in Phase 1 (`scheduling.route_optimization`); the §7.9
OSRM degraded path (visits in scheduled order) is the steady-state, so an OSRM outage is **not** a degradation
relative to Phase-1 behaviour.

## DR posture — **Tier 2** (spec §8.5 / DR-BCP §3.2)

- **RTO:** 4 hours from declared disaster to M17 API serving read requests.
- **RPO:** 1 hour — the most recently committed `visit` / `visit_state_history` rows may be up to 1 hour behind
  the primary at switchover. Lifecycle writes from the past hour (publishes, reschedules, no-shows) may be lost
  and are recovered by scheduler replay; the M4 audit log (synchronously replicated, Tier 1) + the append-only
  `visit_state_history` are the reconstruction source.
- **Recovery order:** M1 (Foundation, Tier 1) and M4 (Audit, Tier 1) must be available before M17 recovers. M17
  shares the M1 Valkey cluster (the §4.5 D11 shift cache + the OSRM matrix cache); BullMQ in-flight jobs are not
  replicated — workers re-queue from the outbox on startup. `validateSeams()` requires the M5/M8/M40 (+ M1)
  seams reachable before M17 accepts live traffic; in a partial DR scenario M17 starts in **degraded mode**.

| Path | Tier | RTO | RPO | Rationale |
|---|---|---|---|---|
| **Visit read** (`GET /visits`, `/visits/:id`, `/day-view`, `/week-view`, `/me/visits`, and the four §4.3 reader seams) | **2** | **≤ 4 h** | **≤ 1 h** | Served directly from `visit` — the field clinician's day view + the M8 visit-seeding / M18 EVV-bracket seams have no live upstream dependency. Available read-only against the DR replica even while writes are suspended. |
| **Visit lifecycle write** (publish / reschedule / cancel / reassign / start / no-show; recurring + time-off machines) | **2** | **≤ 4 h** | **≤ 1 h** | The publish/reassign paths run the §1.1 D8 pre-schedule gate over the M5/M40 seams + the optimistic-`version` lock (`412` on stale). On a seam outage a publish degrades to advisory for the drive-time predicate (predicate 7) but never bypasses the credential/discipline/PTO gates. |
| **Route optimization** (`POST /optimize-day`, the OSRM `RoutingProvider`) | **3** | **≤ 24 h** | n/a | OFF in Phase 1; even when ON the §7.9 degraded path (scheduled order) is the fallback. An OSRM circuit-open emits `m17.route_optimization_degraded` and the day still publishes — optimization is never on the visit-write critical path. |
| **Downstream fan-out** (`m17.visit.*` → M5 caseload / M8 / M18 / M19/M31 Phase-2; `m17.*` → M36 alerts; `caregiver_reminder_due` → M22) | **3** | **≤ 24 h** | **≤ 1 h** | The outbox + BullMQ own the retry backoff; a consumer outage never blocks a visit write. M19/M31 forward consumers deny-stub until those modules lock — fail-closed. |

**Tier-2 constraint.** Visit read-availability must not depend on any upstream seam module being live: the read
paths serve `visit` rows directly. The frequency-driven proposal *build* (§2.2.4, the M7 `CarePlanReader` join)
is a nightly batch job, not on the read path — in degraded mode an unbuilt proposal simply doesn't appear in
the inbox; already-published visits read normally.

### Degraded-mode behaviour

| Dependency down | M17 behaviour |
|---|---|
| Primary DB failover; DR replica available | Full **read** availability against the DR replica (Tier-2 RTO 4 h) — visits + day/week views are read-only field artifacts with no upstream dependency. Writes suspended until the primary is promoted. |
| OSRM (`RoutingProvider` circuit open) | The §7.9 Phase-1 degraded path: `optimize-day` returns visits in scheduled order, emits `m17.route_optimization_degraded`, and the day still publishes. Drive-time feasibility (pre-schedule predicate 7) degrades to advisory. |
| M5 (`PatientAddressReader` geocode) | Per §8.6 — `coordsForAddress` returns `null`; the drive-time predicate degrades to advisory (same path as OSRM-unavailable). The credential/discipline/PTO/caseload gates still hard-block. |
| M36 (alert delivery) | Lifecycle proceeds; the §4.9 visit-assigned / reschedule / no-show / reassignment-needed / time-off / stale-visit / route-degraded alerts land in the outbox and M36 drains on recovery. The day/week/time-off read screens show the obligation without alert push. |
| M40 (`Location`/`Facility` / discipline catalog) | A publish/reassign whose discipline cannot be re-validated against the M40 canonical catalog fails closed (`discipline_matches_visit` returns false → gate fail), never assigns. |
| BullMQ (Valkey) | Nightly recurring-materialise / propose-from-frequency / optimize-day, the reassignment + stale-visit + late-check + caregiver-reminder sweeps, and the §4.5 D11 shift cache. Visit reads/writes do not require BullMQ and continue (the shift cache misses degrade M5's caseload read to the DB path, not an outage). |

## Integration inventory — cross-module + external couplings

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| consume (seam) | M5 | `PatientAddressReader.coordsForAddress` (geocoded coords for routing, §8.6) — M17 never geocodes; M5 owns the geocode job | yes (address coords) |
| consume (seam) | M8 | `MileagePayrollReader` / `BillableEncounterReader` (route-actuals reconciliation + the post-visit billable badge, §4.4) — M17 never imports M8 schema | yes (ids) |
| consume (seam) | M40 | `Location` / `Facility` + the discipline catalog the pre-schedule `discipline_matches_visit` predicate re-reads | minimal (ids) |
| consume (seam, deny-stub) | M15 (Phase 2) | `VolunteerComplianceProvider` (pre-schedule volunteer gate) + `SupervisoryCadenceReader` (advisory) — fail-closed deny-stubs until M15 locks (`VOLUNTEER_GATE_UNMET`), per M17-F06 / ADR-0009 | minimal (ids) |
| consume (external, adapter) | OSRM (`packages/routing-client`) | `RoutingProvider.matrix` / `directions` — **coords-only, no PHI** (D9); circuit-breaker + 24h SHA-256 coord-hash cache; the §25.14 adapter boundary | **no PHI** (coords only) |
| serve (seam) | M8/M14/M18/M20 | `VisitReader` (the visit read path; M8's `m17.visit.published` seed is live, M18 EVV geofence target, M14 IDG since-meeting) registered in the M1 registry (§4.3) | yes (ids) |
| serve (seam) | M5/M19/M20 | `VisitAssignmentReader` (the §4.5 D11 caseload contribution M5's `patientCaseloadProvider` reads) | yes (ids) |
| serve (seam) | M31 (Phase 2) | `PortalVisitReader.upcomingForPatient` — lay-language projection only; `scheduler_internal_notes` excluded | yes (lay) |
| serve (seam) | M30/M33 | `VisitMetricsProvider` (on-time / no-show / reschedule + route-efficiency measures) | minimal (ids) |
| publish | M5/M8/M18 | `m17.visit.published` (**wires live M8's visit-seeding consumer, M8 D9; M18 seeds the EVV bracket/geofence**) + `m17.visit.assigned`/`unassigned` (M5 caseload stream) + `started`/`completed`/`late_check_out_suspected` (M18) | yes (ids + visit metadata) |
| publish | M36 | the §4.9 typed alert payloads (visit-assigned / reschedule / cancelled / no-show / reassignment-needed / time-off / route-optimized·unoptimized / stale-visit / caregiver-reminder) | minimal (ids); reasons scrubbed (§3.6) |
| publish | M22 | `m17.caregiver_reminder_due` — M22 renders the reminder, M36 delivers (§4.11) | minimal (ids) |
| consume (outbox) | M8 | `m8.encounter.signed` → the visit's terminal `in_visit → completed` transition (system actor, §2.2.1 / consumers/) — idempotent on `(eventId, consumerName)` | yes (ids) |
| forward (deny-stub) | M19 (Phase 2) | on-call triage — consumes `m17.visit.no_show_detected` / `reassignment_needed` / `time_off.approved` when it locks, no `dependsOn` edge | minimal (ids) |
| forward (deny-stub) | M31 (Phase 2) | portal upcoming-visit notifications — consumes `m17.visit.published`/`rescheduled`/`cancelled`/`caregiver_reminder_due` when it locks | minimal (ids) |

## STRIDE — see spec §8.3 (authoritative)

The spec §8.3 STRIDE map + the §6 per-role permissions matrix are authoritative (and a §9 test blocker). The
DR/security-relevant mitigations:

- **Spoofing — assigned clinician via reassign to a non-credentialed user:** the §1.1 D8 pre-schedule gate
  predicate `clinician_credentials_active` rejects publishes/reassigns to expired-credential memberships; the
  predicate reruns on every PATCH that changes `assigned_membership_id` or `visit_purpose` (no way to mutate a
  visit to volunteer-purpose without re-evaluation).
- **Tampering — published visit to bypass the volunteer gate:** `discipline_matches_visit` +
  `within_caseload_or_unassigned_pool` rerun on the assignment-changing PATCH; the M15 volunteer gate (Phase 2,
  deny-stub) fails closed until M15 locks.
- **Repudiation — who cancelled / rescheduled / no-showed:** `visit_state_history` is append-only (the M4 audit
  trigger denies UPDATE/DELETE; GRANT is SELECT,INSERT only); the M4 PHI write-audit trigger on `visit` captures
  actor + reason marker; the reason free-text is denylisted (§3.6) but the transition is recorded.
- **Information disclosure — routing adapter sends PHI to OSRM:** D9 minimization — only coords + polyline cross
  the network; the `packages/routing-client` adapter request builder cannot include PHI fields (type-system +
  the §25.14 dependency-cruiser rule reject any `osrm-text-instructions`/`@mapbox/*` import outside the package);
  the cache key is a SHA-256 of the sorted coord set, never an address.
- **Information disclosure — portal upcoming-visits:** `PortalVisitReader.upcomingForPatient` projects only
  lay-language fields; `scheduler_internal_notes` is not in the projection; the M39 `family_caregiver_access`
  consent binds the M31 session (Phase 2).
- **Elevation of privilege — reassigning own caseload visits to capture patients:** `visit.reassign` is
  Sched/Clin Supv/DON only; reassigning to oneself still runs the caseload predicate; the audit log captures the
  reassign chain. Cross-org reads return `404` (IDOR-disambiguation); RLS keyed only on `app.org_id` is the
  layer-independent backstop (§9.3/§9.4).
- **Right-to-erasure:** visit metadata retention is `operational` (3y post-discharge, §8.4); patient erasure
  cascades `visit_state_history` + `route_segment`; the clinician-scoped `time_off` / `clinician_availability`
  rows are not patient-scoped and survive. The M8 encounter itself carries the `clinical_record` (7y) class.
