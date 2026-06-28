// apps/backend/src/modules/25-remittance/erasers/remittance-eraser.ts — the M25 `remittance` data eraser
// (M4 destruction registry, §3.7 / §8.4). Per the §3.7 contract the per-patient destruction subject erases
// the patient_responsibility_ledger rows for the approved patient scope; the remittance line/adjustment/
// remark history is billing-substantiating (7-year compliance class) and rolls off via the M4 partition
// manager at the retention boundary, NOT per-patient — the patient↔claim linkage is broken at partition
// detach (clp01_patient_control_number is a submitter tracking number, not PHI in isolation). The real
// store is injected by the composition root; this wrapper adapts it to the M1 `DataEraser` contract and
// registers the REAL eraser over the Phase-0 deny-stub via the injected `registerEraser` hook (the M23
// import-boundary posture — the bootstrap registry is not imported here).
import type { DataClass, DataEraser } from "@wardenx/types";

/** The M4 destruction-registry hook the composition root binds (its bootstrap `registerEraser`). */
export type RegisterEraserHook = (dataClass: DataClass, eraser: DataEraser) => void;

/**
 * The M25 destruction data class. NOT yet a member of the `@wardenx/types` `DataClass` union (M4-owned) —
 * cast here as the single string literal so the wiring lands in one place (the M23 `billing_record` /
 * M27 `cost_report_class` precedent). The Integrate phase adds `"remittance"` to that union + (optionally)
 * to `REQUIRED_ERASERS` so boot fails closed if M25's real eraser is never registered.
 */
export const REMITTANCE_DATA_CLASS = "remittance" as DataClass;

/** The store the eraser drives (the Drizzle binding deletes PR-ledger rows for one patient under RLS). */
export interface RemittanceEraseStore {
  erasePrLedgerForPatient(organizationId: string, patientId: string): Promise<number>;
}

/** Build the M25 `DataEraser`: the M4 cert workflow passes the org scope + the PATIENT subject id (§3.7). */
export function createRemittanceEraser(store: RemittanceEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      if (!scope.orgId || !subjectId) return { erased: 0 };
      const erased = await store.erasePrLedgerForPatient(scope.orgId, subjectId);
      return { erased };
    },
  };
}

/** Deps for the M25 eraser registration. */
export interface RemittanceEraserDeps {
  readonly registerEraser: RegisterEraserHook;
  readonly store: RemittanceEraseStore;
}

/** Register the real M25 eraser over the Phase-0 deny-stub (composition-root `registerModuleErasers` hook). */
export function registerRemittanceErasers(deps: RemittanceEraserDeps): void {
  deps.registerEraser(REMITTANCE_DATA_CLASS, createRemittanceEraser(deps.store));
}
