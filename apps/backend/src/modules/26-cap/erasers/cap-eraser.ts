// apps/backend/src/modules/26-cap/erasers/cap-eraser.ts — the M26 `cap` data eraser (M4 destruction
// registry, §3.7 / §8.4 / D14). The per-patient right-to-erasure REDACTS the patient PHI link
// (patient_id → sentinel, mbi_normalized → '[ERASED]') while RETAINING the cap-year aggregates so CMS-side
// reconciliation stays reproducible from the ledger (D14). The full tenant-destruction path (eraseCapTenant)
// is exported for org offboarding. The real Drizzle store runs under the M4 cert workflow's privileged
// (wardenx_admin) context — bound by the composition root; the in-memory default lets boot register the real
// eraser over the Phase-0 deny-stub before that store binds (the M25 `remittance` / M27 precedent).
import {
  type CapPatientRedactStore,
  type CapTenantEraseStore,
  ERASED_MBI_SENTINEL,
  ERASED_PATIENT_SENTINEL,
  eraseCapTenant,
  redactCapPatient,
} from "@wardenx/cap-management";
import { type DbClient, schema } from "@wardenx/db";
import type { DataClass, DataEraser } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

/** The M4 destruction-registry hook the composition root binds (its bootstrap `registerEraser`). */
export type RegisterEraserHook = (dataClass: DataClass, eraser: DataEraser) => void;

/** The M26 destruction data class (not yet a `@wardenx/types` DataClass member — cast, the M25/M27 posture). */
export const CAP_DATA_CLASS = "cap" satisfies DataClass;

/** Build the M26 `DataEraser`: the M4 cert workflow passes the org scope + the PATIENT subject id (D14 redaction). */
export function createCapEraser(store: CapPatientRedactStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      if (!scope.orgId || !subjectId) return { erased: 0 };
      const counts = await redactCapPatient(store, scope.orgId, subjectId);
      return { erased: Object.values(counts).reduce((a, b) => a + b, 0) };
    },
  };
}

/** In-memory slice store — counts nothing (the deferred-bind default; the M25 in-memory eraser precedent). */
export function createInMemoryCapRedactStore(): CapPatientRedactStore {
  return {
    async redactBeneficiaryAccrual() { return 0; },
    async redactAccrualLines() { return 0; },
    async redactInpatientDayLines() { return 0; },
    async redactProjectionSnapshots() { return 0; },
    async redactThresholdEvents() { return 0; },
    async redactPsrReconciliation() { return 0; },
  };
}

/** The real Drizzle redaction store — runs under the privileged M4 cert context (wardenx_admin connection). */
export function createDrizzleCapRedactStore(db: DbClient): CapPatientRedactStore {
  const BA = schema.capBeneficiaryAccrual;
  const BAL = schema.capBeneficiaryAccrualLine;
  const IDL = schema.capInpatientDayLine;
  const PS = schema.capProjectionSnapshot;
  const TE = schema.capThresholdEvent;
  const PR = schema.capPsrReconciliation;
  const wOrg = (t: { organizationId: unknown }, p: { patientId: unknown }, orgId: string, patientId: string) =>
    and(eq(t.organizationId as never, orgId), eq(p.patientId as never, patientId));
  return {
    async redactBeneficiaryAccrual(orgId, patientId) {
      const r = await db
        .update(BA)
        .set({ patientId: ERASED_PATIENT_SENTINEL, mbiNormalized: ERASED_MBI_SENTINEL })
        .where(wOrg(BA, BA, orgId, patientId))
        .returning({ id: BA.id });
      return r.length;
    },
    async redactAccrualLines(orgId, patientId) {
      const r = await db.update(BAL).set({ patientId: ERASED_PATIENT_SENTINEL }).where(wOrg(BAL, BAL, orgId, patientId)).returning({ id: BAL.id });
      return r.length;
    },
    async redactInpatientDayLines(orgId, patientId) {
      const r = await db.update(IDL).set({ patientId: ERASED_PATIENT_SENTINEL }).where(wOrg(IDL, IDL, orgId, patientId)).returning({ id: IDL.id });
      return r.length;
    },
    async redactProjectionSnapshots(orgId, patientId) {
      const r = await db.update(PS).set({ patientId: ERASED_PATIENT_SENTINEL }).where(wOrg(PS, PS, orgId, patientId)).returning({ id: PS.id });
      return r.length;
    },
    async redactThresholdEvents(orgId, patientId) {
      const r = await db.update(TE).set({ patientId: ERASED_PATIENT_SENTINEL }).where(wOrg(TE, TE, orgId, patientId)).returning({ id: TE.id });
      return r.length;
    },
    async redactPsrReconciliation(orgId, patientId) {
      const r = await db.update(PR).set({ patientId: ERASED_PATIENT_SENTINEL }).where(wOrg(PR, PR, orgId, patientId)).returning({ id: PR.id });
      return r.length;
    },
  };
}

/** The real Drizzle tenant-destruction store (org offboarding; FK-ordered deletes under wardenx_admin). */
export function createDrizzleCapTenantStore(db: DbClient): CapTenantEraseStore {
  const del = async (t: { organizationId: unknown; id?: unknown }, orgId: string): Promise<number> => {
    const r = await db.delete(t as never).where(eq((t as { organizationId: never }).organizationId, orgId)).returning();
    return (r as unknown[]).length;
  };
  return {
    deletePsrReconciliation: (o) => del(schema.capPsrReconciliation, o),
    deletePsrImports: (o) => del(schema.capPsrImport, o),
    deleteSettlements: (o) => del(schema.capSettlement, o),
    deleteThresholdEvents: (o) => del(schema.capThresholdEvent, o),
    deleteProjectionSnapshots: (o) => del(schema.capProjectionSnapshot, o),
    deleteAccrualLines: (o) => del(schema.capBeneficiaryAccrualLine, o),
    deleteBeneficiaryAccruals: (o) => del(schema.capBeneficiaryAccrual, o),
    deleteInpatientDayLines: (o) => del(schema.capInpatientDayLine, o),
    deleteInpatientAccruals: (o) => del(schema.capInpatientAccrual, o),
    deleteMethodologyLocks: (o) => del(schema.capPeriodMethodologyLock, o),
    deletePeriods: (o) => del(schema.capPeriod, o),
  };
}

/** Tenant-offboarding destruction entry (exported for the offboarding flow; not the per-patient cert path). */
export async function eraseCapForTenant(db: DbClient, orgId: string): Promise<Record<string, number>> {
  return eraseCapTenant(createDrizzleCapTenantStore(db), orgId);
}

export interface CapEraserDeps {
  readonly registerEraser: RegisterEraserHook;
  /** The per-patient redaction store (defaults to the in-memory slice until the privileged store binds). */
  readonly store?: CapPatientRedactStore;
}

/** Register the real M26 `cap` eraser over the Phase-0 deny-stub (composition-root registerModuleErasers hook). */
export function registerCapErasers(deps: CapEraserDeps): void {
  const store = deps.store ?? createInMemoryCapRedactStore();
  deps.registerEraser(CAP_DATA_CLASS, createCapEraser(store));
}
