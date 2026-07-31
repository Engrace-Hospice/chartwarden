// apps/backend/src/modules/19-oncall — Module 19 (On-Call Triage).
//
// M19-T02 lands the §3.7 `triage_record` eraser (`erasers/`) alongside the ten owned tables in
// `packages/db/src/schema/oncall` (migrations 0107/0108). The eraser is here rather than in a feature
// package because M19 has none: Wave P2-2 acceptance #1 limits this wave's manifest changes to
// `packages/triage-vendors` and the two Track B web codePaths, so M19's CONTRACTS live in
// `@wardenx/types` (`oncall.ts`, M19-T01) and its domain services under this path (the M6 precedent).
//
// Still to land: the §3 triage-call lifecycle + protocol engine and the ≥25-protocol platform-floor seed
// (M19-T03), the M17/M18 inbound triggers (T04), the M8/M11/M12 seam consumers (T05), the five published
// reader seams (T06), routes/permissions/ABAC (T07) and the §5 screens (T08).
export {
  type InMemoryTriageEraseSeed,
  type TriageEraseCounts,
  type TriageEraseOptions,
  type TriageEraseStore,
  type TriageEraserDeps,
  createDrizzleTriageEraseStore,
  createInMemoryTriageEraseStore,
  createTriageEraser,
  eraseTriageRecord,
  registerTriageErasers,
} from "./erasers/oncall-eraser";
