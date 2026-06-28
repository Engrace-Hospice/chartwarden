// @wardenx/cap-management — the §3.7 destruction eraseFn contract (M4 destruction registry). M26 registers
// TWO handlers (the backend binds the Drizzle store in P4):
//   - tenant_destruction  — full org offboarding: delete every cap_* row for the org (FK-ordered).
//   - patient_redaction   — honour an individual patient's right-to-erasure WITHOUT destroying the
//     cap-year aggregates: the per-patient PHI link (patient_id, mbi_normalized) is redacted to an
//     `[ERASED]` sentinel while paid_cents / day counts survive, so CMS-side cap reconciliation remains
//     reproducible from the ledger (D14, §1.3 right-to-erasure-vs-cost-report-integrity).
//
// PURE port-injected orchestration (the M27 eraser precedent): a total function over an injected store; no
// clock / RNG / Drizzle / getSeam import here. The store runs each delete/redact under the offboarding or
// erasure tenancy context the composition root supplies.

/** The all-zero sentinel the patient PHI link is redacted to (a real uuid so NOT NULL columns hold). */
export const ERASED_PATIENT_SENTINEL = "00000000-0000-0000-0000-000000000000";
export const ERASED_MBI_SENTINEL = "[ERASED]";

/** Ordered erase counts keyed by table (the M4 destruction-cert `tableCounts`). */
export type CapEraseTableCounts = Record<string, number>;

/** Tenant-destruction store: FK-ordered deletes for every cap_* tenant table. */
export interface CapTenantEraseStore {
  deletePsrReconciliation(orgId: string): Promise<number>;
  deletePsrImports(orgId: string): Promise<number>;
  deleteSettlements(orgId: string): Promise<number>;
  deleteThresholdEvents(orgId: string): Promise<number>;
  deleteProjectionSnapshots(orgId: string): Promise<number>;
  deleteAccrualLines(orgId: string): Promise<number>;
  deleteBeneficiaryAccruals(orgId: string): Promise<number>;
  deleteInpatientDayLines(orgId: string): Promise<number>;
  deleteInpatientAccruals(orgId: string): Promise<number>;
  deleteMethodologyLocks(orgId: string): Promise<number>;
  deletePeriods(orgId: string): Promise<number>;
}

/** Per-patient PHI-redaction store: redact the patient link while retaining aggregate cents/days. */
export interface CapPatientRedactStore {
  redactBeneficiaryAccrual(orgId: string, patientId: string): Promise<number>;
  redactAccrualLines(orgId: string, patientId: string): Promise<number>;
  redactInpatientDayLines(orgId: string, patientId: string): Promise<number>;
  redactProjectionSnapshots(orgId: string, patientId: string): Promise<number>;
  redactThresholdEvents(orgId: string, patientId: string): Promise<number>;
  redactPsrReconciliation(orgId: string, patientId: string): Promise<number>;
}

/** Full tenant destruction: FK-ordered delete of every cap_* row for the org. Returns per-table counts. */
export async function eraseCapTenant(
  store: CapTenantEraseStore,
  orgId: string,
): Promise<CapEraseTableCounts> {
  return {
    cap_psr_reconciliation: await store.deletePsrReconciliation(orgId),
    cap_psr_import: await store.deletePsrImports(orgId),
    cap_settlement: await store.deleteSettlements(orgId),
    cap_threshold_event: await store.deleteThresholdEvents(orgId),
    cap_projection_snapshot: await store.deleteProjectionSnapshots(orgId),
    cap_beneficiary_accrual_line: await store.deleteAccrualLines(orgId),
    cap_beneficiary_accrual: await store.deleteBeneficiaryAccruals(orgId),
    cap_inpatient_day_line: await store.deleteInpatientDayLines(orgId),
    cap_inpatient_accrual: await store.deleteInpatientAccruals(orgId),
    cap_period_methodology_lock: await store.deleteMethodologyLocks(orgId),
    cap_period: await store.deletePeriods(orgId),
  };
}

/** Per-patient PHI redaction (D14): aggregates survive; the patient link → sentinel. Returns per-table counts. */
export async function redactCapPatient(
  store: CapPatientRedactStore,
  orgId: string,
  patientId: string,
): Promise<CapEraseTableCounts> {
  return {
    cap_beneficiary_accrual: await store.redactBeneficiaryAccrual(orgId, patientId),
    cap_beneficiary_accrual_line: await store.redactAccrualLines(orgId, patientId),
    cap_inpatient_day_line: await store.redactInpatientDayLines(orgId, patientId),
    cap_projection_snapshot: await store.redactProjectionSnapshots(orgId, patientId),
    cap_threshold_event: await store.redactThresholdEvents(orgId, patientId),
    cap_psr_reconciliation: await store.redactPsrReconciliation(orgId, patientId),
  };
}
