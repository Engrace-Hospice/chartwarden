// apps/backend/src/modules/17-scheduling/seams/consumed.ts — the §4.4 surface of the seams M17 CONSUMES
// (M17-T06). Typed accessors over the M1 seam registry for the cross-module reads M17's pre-schedule gate
// (M17-T07) and day-view/reconciliation services use, so a consumer never imports an upstream module's schema
// (architecture §25.15 blocks the import; the boundary is the boot-injected seam). Each accessor resolves the
// real impl a producer registered, or — for a producer that has not landed — the fail-closed deny-stub that
// throws on call (validateSeams() applies it, §3.18.3). The seams resolved here are already declared in
// REQUIRED_SEAMS; this task adds the two M15 entries (deny-stubbed, M17-F06/ADR-0009).
//
//   M8  (Wave E, LIVE)   — `MileagePayrollReader` (route-actuals reconciliation report, D10) +
//                          `BillableEncounterReader` (the post-visit billable/non-billable day-view badge).
//   M15 (Phase 2, STUB)  — `VolunteerComplianceProvider` (D8 gate predicate 6, `VOLUNTEER_GATE_UNMET`) +
//                          `SupervisoryCadenceReader` (day-view advisory + the propose-from-frequency worker).
//
// Consuming via the registry adds NO `dependsOn` edge to M15 (the registry is M1-owned); M8 is already a M17
// dependsOn. The accessors are thin so the gate/service layers (M17-T07) inject the resolved seam under RLS.
import type {
  BillableEncounterReader,
  MileagePayrollReader,
  SupervisoryCadenceReader,
  VolunteerComplianceProvider,
} from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";

/** M8 (Wave E) — authoritative per-clinician mileage; M17's route-actuals reconciliation (D10) reads it. */
export function getMileagePayrollReader(): MileagePayrollReader {
  return getSeam("MileagePayrollReader");
}

/** M8 (Wave E) — post-visit billability; the day view badges each completed visit billable/non-billable. */
export function getBillableEncounterReader(): BillableEncounterReader {
  return getSeam("BillableEncounterReader");
}

/** M15 (Phase 2, deny-stubbed) — the D8 pre-schedule gate predicate-6 input for `volunteer_visit` purpose. */
export function getVolunteerComplianceProvider(): VolunteerComplianceProvider {
  return getSeam("VolunteerComplianceProvider");
}

/** M15 (Phase 2, deny-stubbed) — next-due RN supervisory visit per admission (day-view advisory / proposals). */
export function getSupervisoryCadenceReader(): SupervisoryCadenceReader {
  return getSeam("SupervisoryCadenceReader");
}
