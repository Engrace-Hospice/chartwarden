// apps/backend/src/modules/05-patient/erasers/patient-eraser.ts — M5-T12 the `clinical_record` data
// eraser (M5 spec §8 / §10, D7/D8). M5 owns the destruction-cert callback for the patient clinical
// record: under an M4 destruction certificate, it erases the patient SUBTREE (addresses / identifiers
// / payers / caregiver links / contacts / assignments / communication-prefs / privacy snapshots /
// amendments) for the subject patient, while PRESERVING `patient_merge` (audit) and leaving the
// `patient` row as a tombstone (`status='merged'`/destroyed) for FK referential integrity — deletion
// is never destructive on the satellite-table FKs (D8 resolver pattern). Registers the REAL eraser
// over the Phase-0 deny-stub (the `clinical_record` data class is in REQUIRED_ERASERS); the
// composition root's wireModuleErasers() invokes it before validateErasers().
import type { DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/** The per-subtree counts a patient destruction removed (the destruction certificate records these). */
export interface PatientEraseCounts {
  readonly addresses: number;
  readonly identifiers: number;
  readonly payers: number;
  readonly caregiverLinks: number;
  readonly emergencyContacts: number;
  readonly assignments: number;
  readonly communicationPreferences: number;
  readonly privacySnapshots: number;
  readonly amendments: number;
  readonly nameAliases: number;
  readonly phones: number;
  readonly emails: number;
}

/** The narrow data port the patient eraseFn composes over (Drizzle deletes in prod). */
export interface PatientEraseStore {
  /** Delete the patient's subtree rows; return the per-table counts. `patient_merge` is NOT touched. */
  erasePatientSubtree(organizationId: string, patientId: string): Promise<PatientEraseCounts>;
  /** Tombstone the `patient` row (status flip; keeps the PK for FK integrity, D8). */
  tombstonePatient(organizationId: string, patientId: string): Promise<void>;
}

/**
 * Erase a patient's clinical-record subtree under a destruction certificate (D7/D8): delete the
 * satellite rows, tombstone the patient row, and report the total removed. `patient_merge` survives
 * (it is audit). Pure orchestration over the store.
 */
export async function erasePatientClinicalRecord(
  organizationId: string,
  patientId: string,
  store: PatientEraseStore,
): Promise<{ erased: number; counts: PatientEraseCounts }> {
  const counts = await store.erasePatientSubtree(organizationId, patientId);
  await store.tombstonePatient(organizationId, patientId);
  const erased = Object.values(counts).reduce((a, b) => a + b, 0);
  return { erased, counts };
}

/** An in-memory {@link PatientEraseStore} for the slice/tests (seeded per-table counts to remove). */
export function createInMemoryPatientEraseStore(seed: Partial<PatientEraseCounts> = {}): {
  store: PatientEraseStore;
  tombstoned: string[];
} {
  const zero: PatientEraseCounts = {
    addresses: 0,
    identifiers: 0,
    payers: 0,
    caregiverLinks: 0,
    emergencyContacts: 0,
    assignments: 0,
    communicationPreferences: 0,
    privacySnapshots: 0,
    amendments: 0,
    nameAliases: 0,
    phones: 0,
    emails: 0,
  };
  const counts: PatientEraseCounts = { ...zero, ...seed };
  const tombstoned: string[] = [];
  let used = false;
  return {
    tombstoned,
    store: {
      async erasePatientSubtree() {
        // idempotent: a second erase removes nothing (rows already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
      async tombstonePatient(_org, patientId) {
        tombstoned.push(patientId);
      },
    },
  };
}

/** Injected adapter for the M5 eraser (slice defaults to in-memory). */
export interface PatientEraserDeps {
  store?: PatientEraseStore;
}

/** Build M5's `clinical_record` DataEraser. `subjectId` is the patient being destroyed (§10). */
export function createPatientEraser(store: PatientEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await erasePatientClinicalRecord(scope.orgId, subjectId, store);
      return { erased };
    },
  };
}

/** Register M5's REAL `clinical_record` eraser over the Phase-0 deny-stub (M5-T12; before validateErasers()). */
export function registerPatientErasers(deps: PatientEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryPatientEraseStore().store;
  registerEraser("clinical_record", createPatientEraser(store));
}
