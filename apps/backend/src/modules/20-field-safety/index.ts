// apps/backend/src/modules/20-field-safety — Module 20 (Field Safety).
//
// M20-T02 lands the §3.7 `safety_record` eraser (`erasers/`) alongside the thirteen owned tables in
// `packages/db/src/schema/safety` (migrations 0110/0111). The eraser is here rather than in a feature
// package because M20 has none: Wave P2-2 acceptance #1 limits this wave's manifest changes to
// `packages/triage-vendors` and the two Track B web codePaths, so M20's CONTRACTS live in `@wardenx/types`
// (`safety.ts`, M20-T01) and its domain services under this path (the M6 / M19 precedent).
//
// The eraser is the one place this task had to decide something the spec states twice in different words.
// §3.7's retention table reads like a delete plan; read against §3.5 and §1.1 it is the opposite — M20 is a
// WORKFORCE-safety module, its patient surface is two logical M5 references, and almost everything else in
// it is the CLINICIAN's own record. So the erase redacts and unlinks and deletes nothing. The full argument
// is in `erasers/field-safety-eraser.ts`.
//
// M20-T03 lands the §2.2 domain core in `lifecycle/` — the thirteen-state SOS machine (§2.2.2) with the D5
// cancel window, the §4.8 SLA watchdog that walks the tier ladder into `emergency_terminus` and loops there,
// the D4 overdue-escalation rungs (§7.3), the D6 continuous-location gates (§7.9 / §8.7), the §7.8
// coverage-gap watchdog, and the §2.2.4 policy resolver they all read their thresholds from.
//
// FIVE THINGS THIS TASK DECIDED THAT ARE NOT OBVIOUS FROM THE SPEC:
//   • THE FAN-OUT IS AT THE PRESS, not at the end of the cancel window. §2.2.2's diagram says the latter;
//     D5 ("fire-immediate"), §7.4 (voice dialed at +800 ms) and §9.7 (300 ms budget) say the former.
//   • A REJECTED CANCEL DOES NOT MOVE THE LIFECYCLE — and the reason is migration 0110's `ssa_sla_scan_idx`,
//     which does not cover `cancel_attempted_but_rejected`: an alert parked there would never be scanned by
//     the SLA watchdog, so the hostile-actor SOS would stop escalating. §7.4's prose beats §2.2.2's diagram.
//   • §7.3 NAMES SCHEDULE STATES THE ENUM DOES NOT HAVE (`escalation_tier_1`, `sos_equivalent`). The stored
//     ladder is `proposed → overdue → escalated` and the D4 RUNG is derived from `expected_at`; the rung is
//     reconstructed from `escalated_at` so each fires exactly once with no new column.
//   • TWO §4.10 IDEMPOTENCY KEYS WOULD HAVE SUPPRESSED THE REPETITION THEY KEY — `check_in_escalated`
//     (once per rung) and `sos_terminus_reached` (once per loop). Both are composite now (@wardenx/types).
//   • THE TERMINUS LOOP WRITES NO STATE-HISTORY ROW: §3.3's `m20_ssash_no_self` CHECK refuses `from = to`,
//     so a loop that emitted one would die on a constraint at the moment nobody is answering.
//
// M20-T04 lands the §4.4 upstream bindings: `seams/consumed.ts` (M17 `VisitReader` /
// `VisitAssignmentReader`, M18 `EvvLocationProvider`, M19 `OnCallProvider`, M5 `PatientReader`) and the
// `consumers/` deciders they feed — the §7.1 cadence materializer, the EVV bracket re-anchors, the §4.8
// no-show inquiry, the §7.7 GPS-spoof badge and the §7.5 D14 after-hours parallel set. Binding
// `EvvLocationProvider` closes M18's Wave-F last-known-location deny-stub; binding `OnCallProvider`
// replaces the Phase-1 SOS degraded fallback (Wave P2-2 acceptance #2 and #3).
//
// SIX THINGS T04 DECIDED THAT ARE NOT OBVIOUS FROM THE SPEC:
//   • §4.4's `PatientAddressReader.geocodedAddressFor` DOES NOT EXIST anywhere on the platform, so D12's
//     pre-visit high-risk-area evaluation has NO address source and none is invented: there is no
//     accessor and no polygon evaluator. Fail-closed means the advisory is absent, never guessed.
//   • THE MID-VISIT CADENCE IS MEASURED FROM THE EVV ARRIVAL, not from the scheduled start (§7.1's own
//     arithmetic: 10:02 arrival → 11:02 prompt). Anchoring to the schedule prompts a late clinician at
//     minute twenty and then leaves her alone for the rest of the visit.
//   • AN EVV CHECK-IN CANNOT CLOSE AN UNANSWERED PRE-VISIT OBLIGATION: `m20_scis_recorded_fulfilled`
//     refuses `recorded` without a fulfilling check-in row, and minting one would forge an attestation.
//     D2 asks "are you OK", not "are you there", so the ladder keeps running.
//   • A NO-SHOW INQUIRY WITH NO SCHEDULE ROW IS UNEMITTABLE (`scheduleId` is non-nullable on both the
//     §4.10 payload and the §4.9 alert), so the consumer keeps ONE genuinely-overdue obligation as the
//     anchor, retires the rest, and emits nothing at all when every prompt was answered.
//   • RETIRING AN OBLIGATION IS A DELETE, because no member of `safety_check_in_state` can say "this plan
//     was invalidated" without lying — `recorded` is refused by a CHECK and `superseded` means
//     correction-of-record. The M4 write-audit trigger is what keeps the retirement on the record.
//   • THE D14 SET IS THREE-VALUED and carries external triage vendors on their own field: an
//     `OnCallProvider` outage is `unavailable` (never `[]`, which reads as a real coverage gap), and a
//     vendor-covered Saturday night has no membership to page but is NOT an uncovered night.
//
// Still to land: the seven §4.3 published seams + the §4.5 composed resolver (T05), the §4.1 routes +
// §4.6 keys + §4.7 ABAC (T06), and the §5 screens (T07).
export * from "./consumers";
export * from "./lifecycle";
export * from "./seams";
export {
  type InMemorySafetyEraseSeed,
  type SafetyEraseCounts,
  type SafetyEraseOptions,
  type SafetyEraseStore,
  type SafetyEraserDeps,
  SAFETY_REDACTED_CIPHER_SQL,
  SAFETY_REDACTED_TEXT,
  createDrizzleSafetyEraseStore,
  createInMemorySafetyEraseStore,
  createSafetyEraser,
  eraseSafetyRecord,
  registerSafetyErasers,
} from "./erasers/field-safety-eraser";
