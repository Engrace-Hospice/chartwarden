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
// Still to land: the §7.x lifecycle services + the overdue/SLA/coverage workers (T03), the M17/M18/M19
// consumed seams (T04), the seven §4.3 published seams (T05), the §4.1 routes + §4.6 keys + §4.7 ABAC
// (T06), and the §5 screens (T07).
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
