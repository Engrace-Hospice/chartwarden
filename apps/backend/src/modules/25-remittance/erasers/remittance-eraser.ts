// apps/backend/src/modules/25-remittance/erasers/remittance-eraser.ts — the M25 `remittance` data eraser
// (M4 destruction registry, §3.7 / §8.4). Per the §3.7 contract the per-patient destruction subject erases
// the patient_responsibility_ledger rows for the approved patient scope; the remittance line/adjustment/
// remark history is billing-substantiating (7-year compliance class) and rolls off via the M4 partition
// manager at the retention boundary, NOT per-patient — the patient↔claim linkage is broken at partition
// detach (clp01_patient_control_number is a submitter tracking number, not PHI in isolation). The real
// store is injected by the composition root; this wrapper adapts it to the M1 `DataEraser` contract and
// registers the REAL eraser over the Phase-0 deny-stub via the injected `registerEraser` hook (the M23
// import-boundary posture — the bootstrap registry is not imported here).
import { type DbClient, schema } from "@wardenx/db";
import type { DataClass, DataEraser } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

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

/**
 * The in-memory slice store — counts a requested erase but persists nothing (the M23 in-memory eraser
 * precedent). Lets the composition root register a REAL eraser over the Phase-0 deny-stub at boot before the
 * Drizzle destruction store binds (the per-patient PR-ledger DELETE runs under the M4 cert workflow's
 * privileged context — a deferred bind, same as M23's BillingEraseStore).
 */
export function createInMemoryRemittanceEraseStore(): RemittanceEraseStore {
  return {
    async erasePrLedgerForPatient() {
      return 0;
    },
  };
}

/**
 * The REAL Drizzle-backed destruction store (§3.7): deletes the patient's `patient_responsibility_ledger`
 * rows — and ONLY those. The remittance line/adjustment/remark history is 7-year billing-substantiating
 * evidence that rolls off via the M4 partition manager at the retention boundary, NOT per-patient, so this
 * store deliberately implements nothing beyond what the port asks.
 *
 * Runs on the PRIVILEGED M4 destruction-cert connection the composition root binds (wardenx_admin —
 * migration 0083 grants `wardenx_app` no DELETE on the PR ledger, so the app-role `withOrgContext` path
 * cannot destroy; the M24/M26 sibling posture). The explicit `organization_id` predicate keeps a
 * certificate from ever reaching across tenants; the count is the rows ACTUALLY deleted (`.returning()`).
 */
export function createDrizzleRemittanceEraseStore(db: DbClient): RemittanceEraseStore {
  const L = schema.patientResponsibilityLedger;
  return {
    async erasePrLedgerForPatient(organizationId, patientId) {
      const deleted = await db
        .delete(L)
        .where(and(eq(L.organizationId, organizationId), eq(L.patientId, patientId)))
        .returning({ id: L.id });
      return deleted.length;
    },
  };
}

/** Deps for the M25 eraser registration. */
export interface RemittanceEraserDeps {
  readonly registerEraser: RegisterEraserHook;
  /** The destruction store (defaults to the in-memory slice until the Drizzle store binds). */
  readonly store?: RemittanceEraseStore;
}

/** Register the real M25 eraser over the Phase-0 deny-stub (composition-root `registerModuleErasers` hook). */
export function registerRemittanceErasers(deps: RemittanceEraserDeps): void {
  const store = deps.store ?? createInMemoryRemittanceEraseStore();
  deps.registerEraser(REMITTANCE_DATA_CLASS, createRemittanceEraser(store));
}
