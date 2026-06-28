// apps/backend/src/modules/23-billing-medicare/erasers/billing-eraser.ts — the M23 `billing_record` data
// eraser (M4 destruction registry, §3.7 / §8.4). Unlike M27/M30 (org-only operational rows), the M23
// billing record IS per-patient PHI: claim / claim_line / claim_state_history / validation_run/result/
// override / claim_submission / claim_acknowledgment / hipps_calculation / sia_calculation /
// eligibility_check / noe_record / notr_record all carry the patient FK. The billing record is
// COMPLIANCE-class (7 years past final action per CMS 42 CFR §424 / §405 + state override, M4 D1), so the
// registered eraser is the DESTRUCTION handler the M4 destruction-cert workflow invokes — NOT an
// ordinary-offboarding cleanup. The §3.7 cascade order + the redact/shred surface are the pure
// `@wardenx/billing` eraser contract (`M23_PATIENT_CASCADE_ORDER` / `M23_REDACT_FIELDS`); this backend
// wrapper only adapts the package's `BillingEraseStore` to the M1 `DataEraser` contract and registers the
// REAL eraser over the Phase-0 deny-stub via the composition-root `registerModuleErasers` hook (after
// wireErasers(), before validateErasers() — the same M6/M22/M27/M30 registration shape).
//
// SUBJECT HANDLING (differs from M27): for `billing_record` the `DataEraser.erase(scope, subjectId)`
// subject is the PATIENT (the per-patient cascade is the registered path); the M4 cert workflow passes the
// patient id, and the §3.7 in-flight guard (a `BillingEraseRefused` from the store) refuses an erase that
// would destroy a claim still moving through submission / awaiting a MAC acknowledgment, or a record under
// a surveyor hold. The MAC `client_secret_cipher` cryptographic SHRED + the org-operational config rows are
// an ORGANIZATION-destruction concern (`eraseOrgBillingConfig`), NOT the per-patient subject path; that
// org-destruction binding lands with the M4 org-destruction driver (documented below, not faked here).
//
// CASCADE ORDER (§3.7, from the package contract): children first so FKs unwind cleanly —
//   eligibility_check → claim_acknowledgment → claim_submission → claim_state_history →
//   validation_override → validation_result → validation_run → sia_calculation → hipps_calculation →
//   claim_line → claim → noe_record → notr_record.
// The append-only tables are deleted in-cascade; the free-text fields in `M23_REDACT_FIELDS` (override
// reason, replacement reason, patient-id refs) are redacted rather than orphaned. NO MBI is ever a field
// (§3.6 — it never persists).
//
// AI-BLOCK (D13): no `@wardenx/ai-platform` import here (the dependency-cruiser boundary enforces it).
import {
  type BillingEraseStore,
  type BillingEraseTableCounts,
  M23_RETENTION_CLASS,
} from "@wardenx/billing";
import type { DataClass, DataEraser } from "@wardenx/types";

// IMPORT-BOUNDARY NOTE (differs from M27): M23 `dependsOn = [6,8,22,38,40]` does NOT include M1, so the
// M1-owned `apps/backend/src/bootstrap` M4 destruction registry (`registerEraser`) is forbidden by
// `module-23-boundary` (and `dependsOn` may not be widened). The bootstrap `registerEraser` hook is
// therefore INJECTED by the composition root (the app root may import bootstrap), not imported here.

/** The M4 destruction-registry hook the composition root binds (its bootstrap `registerEraser`). */
export type RegisterEraserHook = (dataClass: DataClass, eraser: DataEraser) => void;

/**
 * The M23 destruction data class. NOT yet a member of the `@wardenx/types` `DataClass` union (M4-owned) —
 * cast here as the single string literal so the wiring lands in one place (the M27 `cost_report_class` /
 * M30 `quality_class` precedent). The Integrate phase adds `"billing_record"` to that union + to
 * `REQUIRED_ERASERS` (apps/backend/src/bootstrap/erasers/registry.ts) so boot fails closed if M23's real
 * eraser is never registered.
 */
export const BILLING_DATA_CLASS = M23_RETENTION_CLASS as DataClass;

/** Deps for the M23 eraser registration. */
export interface BillingEraserDeps {
  /**
   * The bootstrap `registerEraser` hook, injected by the composition root (M23 cannot import the M1-owned
   * bootstrap registry — see the import-boundary note above). Required: with no hook the eraser cannot be
   * registered.
   */
  readonly registerEraser: RegisterEraserHook;
  /** The Drizzle-backed `BillingEraseStore` in prod (each DELETE / redact under the destruction-cert
   *  tenancy context); the in-memory slice store by default. */
  readonly store?: BillingEraseStore;
}

/** Sum every per-table count in the §3.7 erase-count map (the M4 destruction-cert `tableCounts`). */
function sumCounts(counts: BillingEraseTableCounts): number {
  return Object.values(counts).reduce((total, n) => total + n, 0);
}

/**
 * Adapt the package's pure `BillingEraseStore` to the M1 `DataEraser` contract. The registered subject is
 * the PATIENT: the per-patient §3.7 cascade deletes/redacts every owned billing table for that patient in
 * the org. The store enforces the §3.7 in-flight / surveyor-hold guard (it raises `BillingEraseRefused`
 * which propagates to the M4 destruction-cert workflow — fail-closed, never a silent no-op).
 */
export function createBillingEraser(store: BillingEraseStore): DataEraser {
  return {
    // `scope.orgId` is the tenant; `subjectId` is the patient whose billing record the M4 destruction
    // certificate authorizes. The MAC credential cryptographic shred + operational-config rows are NOT
    // reached here — that is the ORG-destruction path (`store.eraseOrgBillingConfig`), bound by the M4
    // org-destruction driver when it lands.
    async erase(scope, subjectId) {
      const counts = await store.erasePatientBillingRecord({
        organizationId: scope.orgId,
        patientId: subjectId,
      });
      return { erased: sumCounts(counts) };
    },
  };
}

/**
 * Default in-memory `BillingEraseStore` (the slice store): zero counts, never deletes. Prod injects the
 * Drizzle-backed store. Mirrors the M27 `createInMemoryCostReportEraseStore` default.
 */
function createInMemoryBillingEraseStore(): BillingEraseStore {
  return {
    async erasePatientBillingRecord(_input) {
      return {};
    },
    async eraseOrgBillingConfig(_input) {
      return {};
    },
  };
}

/**
 * Register the REAL M23 billing eraser over the Phase-0 `billing_record` deny-stub. Called by the
 * composition root's `registerModuleErasers` hook (after wireErasers(), before validateErasers()), the same
 * hook M5/M6/M22/M27/M30 use — the composition root passes its bootstrap `registerEraser` as
 * `deps.registerEraser` (M23 cannot import the M1-owned bootstrap registry). The in-memory slice store is
 * the default; prod injects the Drizzle store.
 *
 * TODO(M23 boot-wiring, Integrate phase): (1) add `"billing_record"` to the `@wardenx/types` `DataClass`
 * union + `REQUIRED_ERASERS` so the deny-stub exists to register over; (2) inject the Drizzle-backed
 * `BillingEraseStore` (each cascade DELETE + redact under the destruction-cert tenancy context) so the
 * eraser runs against the real M23 tables and enforces the §3.7 in-flight guard; (3) wire the ORG-
 * destruction path (`eraseOrgBillingConfig` — MAC `client_secret_cipher` cryptographic shred + operational
 * config) once the M4 org-destruction driver lands.
 */
export function registerBillingErasers(deps: BillingEraserDeps): void {
  const store = deps.store ?? createInMemoryBillingEraseStore();
  deps.registerEraser(BILLING_DATA_CLASS, createBillingEraser(store));
}
