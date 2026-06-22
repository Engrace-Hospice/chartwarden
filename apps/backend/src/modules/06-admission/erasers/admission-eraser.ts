// apps/backend/src/modules/06-admission/erasers/admission-eraser.ts — M6-T12 the `admission_record`
// data eraser (M6 spec §3.6 module-init "registers ... eraser"; M4 destruction-cert workflow, D7/D8).
//
// M6 owns the destruction callback for a patient's ADMISSION record — the clinical satellites M6
// creates around the M5 patient spine: election periods, election statements, CTIs, F2F encounters,
// level-of-care periods, revocation/discharge/transfer events, notice-of-rights acknowledgments, and
// compliance windows, plus the `referral` rows for the subject. Under an M4 destruction certificate it
// erases that subtree for the subject patient while leaving the `admission` row as a TOMBSTONE
// (status flip; the PK survives for FK referential integrity) — the same D8 resolver pattern M5's
// `clinical_record` eraser uses on the patient spine. The two erasers are disjoint by table ownership:
// M5 destroys the patient demographics subtree; M6 destroys the admission subtree it owns.
//
// Registers the REAL eraser over the Phase-0 deny-stub (`admission_record` is in REQUIRED_ERASERS);
// the composition root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before
// validateErasers(), so a real eraser stands over its stub.
import type { DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/** The per-table counts an admission-record destruction removed (recorded on the destruction cert). */
export interface AdmissionEraseCounts {
  readonly referrals: number;
  readonly electionPeriods: number;
  readonly electionStatements: number;
  readonly certifications: number;
  readonly faceToFaceEncounters: number;
  readonly levelOfCarePeriods: number;
  readonly revocationEvents: number;
  readonly dischargeEvents: number;
  readonly transferEvents: number;
  readonly noticeOfRightsAcknowledgments: number;
  readonly complianceWindows: number;
}

/** The narrow data port the admission eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface AdmissionEraseStore {
  /** Delete the patient's admission satellites; return per-table counts. The `admission` row is NOT deleted. */
  eraseAdmissionSubtree(organizationId: string, patientId: string): Promise<AdmissionEraseCounts>;
  /** Tombstone the patient's `admission` row(s) (status flip; keeps the PK for FK integrity, D8). */
  tombstoneAdmissions(organizationId: string, patientId: string): Promise<void>;
}

/**
 * Erase a patient's admission-record subtree under a destruction certificate (D7/D8): delete the
 * admission satellites + referrals, tombstone the `admission` row(s), and report the total removed.
 * Pure orchestration over the store — no I/O of its own.
 */
export async function eraseAdmissionRecord(
  organizationId: string,
  patientId: string,
  store: AdmissionEraseStore,
): Promise<{ erased: number; counts: AdmissionEraseCounts }> {
  const counts = await store.eraseAdmissionSubtree(organizationId, patientId);
  await store.tombstoneAdmissions(organizationId, patientId);
  const erased = Object.values(counts).reduce((a, b) => a + b, 0);
  return { erased, counts };
}

/** An in-memory {@link AdmissionEraseStore} for the slice/tests (seeded per-table counts to remove). */
export function createInMemoryAdmissionEraseStore(seed: Partial<AdmissionEraseCounts> = {}): {
  store: AdmissionEraseStore;
  tombstoned: string[];
} {
  const zero: AdmissionEraseCounts = {
    referrals: 0,
    electionPeriods: 0,
    electionStatements: 0,
    certifications: 0,
    faceToFaceEncounters: 0,
    levelOfCarePeriods: 0,
    revocationEvents: 0,
    dischargeEvents: 0,
    transferEvents: 0,
    noticeOfRightsAcknowledgments: 0,
    complianceWindows: 0,
  };
  const counts: AdmissionEraseCounts = { ...zero, ...seed };
  const tombstoned: string[] = [];
  let used = false;
  return {
    tombstoned,
    store: {
      async eraseAdmissionSubtree() {
        // idempotent: a second erase removes nothing (rows already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
      async tombstoneAdmissions(_org, patientId) {
        tombstoned.push(patientId);
      },
    },
  };
}

/** Injected adapter for the M6 eraser (slice defaults to in-memory). */
export interface AdmissionEraserDeps {
  store?: AdmissionEraseStore;
}

/** Build M6's `admission_record` DataEraser. `subjectId` is the patient being destroyed (D7/D8). */
export function createAdmissionEraser(store: AdmissionEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseAdmissionRecord(scope.orgId, subjectId, store);
      return { erased };
    },
  };
}

/** Register M6's REAL `admission_record` eraser over the Phase-0 deny-stub (M6-T12; before validateErasers()). */
export function registerAdmissionErasers(deps: AdmissionEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryAdmissionEraseStore().store;
  registerEraser("admission_record", createAdmissionEraser(store));
}
