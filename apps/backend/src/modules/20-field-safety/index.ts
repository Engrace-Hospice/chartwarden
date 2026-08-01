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
// Still to land: the M17/M18/M19 consumed seams (T04), the seven §4.3 published seams (T05), the §4.1
// routes + §4.6 keys + §4.7 ABAC (T06), and the §5 screens (T07).
export * from "./lifecycle";
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
