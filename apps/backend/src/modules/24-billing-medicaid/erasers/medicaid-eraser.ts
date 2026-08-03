// apps/backend/src/modules/24-billing-medicaid/erasers/medicaid-eraser.ts — the M24 Medicaid-billing data
// eraser (M4 destruction registry, §3.7 / §8.4). Under an M4 destruction certificate the per-patient
// right-to-erasure SHREDS the PHI-bearing free-text + the KMS-wrapped ciphers on the patient's M24 rows
// (rb_arrangement.termination_reason, rb_day.exclusion_reason, medicaid_eligibility_check.{raw_response_cipher,
// recipient_id_masked_at_check, error_message}) while PRESERVING the FK chain (the surveyor read-view stays
// intact). The real Drizzle store runs under the M4 cert workflow's privileged context — bound by the
// composition root; the in-memory default lets boot register the real eraser over the Phase-0 deny-stub
// before that store binds (the M25 `remittance` / M26 `cap` precedent).
//
// DATA-CLASS NOTE (deviation, architecture wins): the spec §3.7 nominally reuses M23's `billing_record`
// retention class, but the M4 eraser registry is keyed single-owner per DataClass — registering
// `billing_record` again would CLOBBER M23's registered eraser. So M24 registers under the distinct
// `medicaid_billing_record` class (the same 7-year retention floor); both Medicare + Medicaid erasers coexist.
//
// DEFERRAL: the join-only PHI fields (medicaid_submission.{error_message,vendor_payload_cipher},
// medicaid_acknowledgment.raw_payload_cipher, medicaid_validation_override.reason — all keyed by claim, not
// patient) + the trading-partner secret crypto-shred (org-destruction only) follow the claim chain / the
// org-offboarding path; the per-patient direct-link subset is shredded here.
import { type DbClient, schema } from "@wardenx/db";
import type { DataClass, DataEraser, OrgScope } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

/** The M4 destruction-registry hook the composition root binds (its bootstrap `registerEraser`). */
export type RegisterEraserHook = (dataClass: DataClass, eraser: DataEraser) => void;

/** The M24 destruction data class (not a `@wardenx/types` DataClass member — cast, the M25/M26 posture). */
export const MEDICAID_BILLING_DATA_CLASS = "medicaid_billing_record" satisfies DataClass;

const ERASED = "ERASED";

/** The per-patient redaction store the eraser drives (real Drizzle, or the in-memory deferred default). */
export interface MedicaidRedactStore {
  redactRbArrangements(orgId: string, patientId: string): Promise<number>;
  redactRbDays(orgId: string, patientId: string): Promise<number>;
  redactEligibilityChecks(orgId: string, patientId: string): Promise<number>;
}

/** Build the M24 `DataEraser`: the M4 cert workflow passes the org scope + the PATIENT subject id. */
export function createMedicaidEraser(store: MedicaidRedactStore): DataEraser {
  return {
    async erase(scope: OrgScope, subjectId: string) {
      if (!scope.orgId || !subjectId) return { erased: 0 };
      const counts = await Promise.all([
        store.redactRbArrangements(scope.orgId, subjectId),
        store.redactRbDays(scope.orgId, subjectId),
        store.redactEligibilityChecks(scope.orgId, subjectId),
      ]);
      return { erased: counts.reduce((a, b) => a + b, 0) };
    },
  };
}

/** In-memory slice store — counts nothing (the deferred-bind default; the M26 in-memory eraser precedent). */
export function createInMemoryMedicaidRedactStore(): MedicaidRedactStore {
  return {
    async redactRbArrangements() {
      return 0;
    },
    async redactRbDays() {
      return 0;
    },
    async redactEligibilityChecks() {
      return 0;
    },
  };
}

/** The real Drizzle redaction store — runs under the privileged M4 cert context (wardenx_admin connection). */
export function createDrizzleMedicaidRedactStore(db: DbClient): MedicaidRedactStore {
  const A = schema.rbArrangement;
  const RD = schema.rbDay;
  const EC = schema.medicaidEligibilityCheck;
  return {
    async redactRbArrangements(orgId, patientId) {
      const r = await db
        .update(A)
        .set({ terminationReason: ERASED })
        .where(and(eq(A.organizationId, orgId), eq(A.patientId, patientId)))
        .returning({ id: A.id });
      return r.length;
    },
    async redactRbDays(orgId, patientId) {
      const r = await db
        .update(RD)
        .set({ exclusionReason: ERASED })
        .where(and(eq(RD.organizationId, orgId), eq(RD.patientId, patientId)))
        .returning({ id: RD.id });
      return r.length;
    },
    async redactEligibilityChecks(orgId, patientId) {
      const r = await db
        .update(EC)
        .set({ rawResponseCipher: null, recipientIdMaskedAtCheck: null, errorMessage: ERASED })
        .where(and(eq(EC.organizationId, orgId), eq(EC.patientId, patientId)))
        .returning({ id: EC.id });
      return r.length;
    },
  };
}

export interface MedicaidEraserDeps {
  readonly registerEraser: RegisterEraserHook;
  /** The per-patient redaction store (defaults to the in-memory slice until the privileged store binds). */
  readonly store?: MedicaidRedactStore;
}

/** Register the real M24 eraser over the Phase-0 deny-stub (composition-root registerModuleErasers hook). */
export function registerMedicaidErasers(deps: MedicaidEraserDeps): void {
  const store = deps.store ?? createInMemoryMedicaidRedactStore();
  deps.registerEraser(MEDICAID_BILLING_DATA_CLASS, createMedicaidEraser(store));
}
