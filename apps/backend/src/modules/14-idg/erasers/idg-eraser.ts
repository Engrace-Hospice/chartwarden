// apps/backend/src/modules/14-idg/erasers/idg-eraser.ts — M14-T07 the `idg_record` data eraser (M14 spec §8.4;
// M4 destruction-cert workflow).
//
// M14 owns the destruction callback for a patient's IDG subtree — the patient-scoped artifacts M14 captures
// around the M5 patient spine. Under an M4 destruction certificate it (1) acquires a per-patient advisory lock
// so a concurrent write cannot interleave with the destruction, then (2) erases the patient's
// `idg_patient_packet` rows (the per-patient packet snapshots), the patient's `idg_decision` rows, the patient's
// `idg_action_item` rows, and the patient's `idg_agenda_item` rows — every IDG row that carries a `patient_id`.
//
// What SURVIVES (§8.4): the `idg_meeting`, `idg_recurring_policy`, `idg_attendance`, `idg_minutes`, and
// `idg_minutes_amendment` rows. A meeting is a caseload-wide / location-level artifact, not a single patient's
// record — erasing it would destroy the regulatory record of the whole team's review. Patient-specific
// references inside the `idg_minutes` `*_snapshot` jsonb are HASH-REDACTED via the M4 trigger pattern (the same
// approach M5's `clinical_record` and the minutes audit-trigger use), NOT deleted by this callback. Unlike
// M10's HOPE eraser there is no CMS extended-retention block — IDG records carry M4's standard `compliance`
// retention class, enforced by the certificate's `retentionAsOf` boundary, not by this callback (§8.4).
//
// Registers the REAL eraser over the Phase-0 deny-stub (`idg_record` is in REQUIRED_ERASERS); the composition
// root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before validateErasers(), so a real
// eraser stands over its stub.
import type { DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/** The per-table counts an IDG-record destruction removed (recorded on the destruction cert, §8.4). */
export interface IdgEraseCounts {
  /** `idg_patient_packet` rows deleted for the patient. */
  readonly packets: number;
  /** `idg_decision` rows deleted for the patient (patient-scoped decisions only). */
  readonly decisions: number;
  /** `idg_action_item` rows deleted for the patient (patient-scoped action items only). */
  readonly actionItems: number;
  /** `idg_agenda_item` rows deleted for the patient (patient-scoped agenda entries only). */
  readonly agendaItems: number;
  /** `idg_minutes` rows whose patient-specific snapshot references were hash-redacted (rows NOT deleted, §8.4). */
  readonly minutesRedacted: number;
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now). */
export interface IdgEraseOptions {
  /** Erase rows older than `retentionAsOf`; defaults to {@link IdgEraseOptions.now}'s instant. */
  readonly retentionAsOf?: string;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the IDG eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface IdgEraseStore {
  /**
   * Acquire a per-patient advisory lock (keyed on patient id) so a concurrent write cannot interleave with the
   * destruction. Released by the surrounding transaction commit in prod; a no-op in the slice.
   */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Erase the patient's IDG subtree: the `idg_patient_packet` / `idg_decision` / `idg_action_item` /
   * `idg_agenda_item` rows carrying the patient's id (`*.created_at < retentionAsOf`), and hash-redact the
   * patient-specific references inside the `idg_minutes` snapshots (rows preserved). The caseload-wide
   * `idg_meeting` / `idg_recurring_policy` / `idg_attendance` / `idg_minutes` / `idg_minutes_amendment` rows are
   * left intact (§8.4). Returns counts.
   */
  erasePatientRecords(
    organizationId: string,
    patientId: string,
    retentionAsOf: string,
  ): Promise<IdgEraseCounts>;
}

/**
 * Erase a patient's IDG subtree under a destruction certificate (§8.4): lock the patient, then delete the
 * patient-scoped packet / decision / action-item / agenda rows (and hash-redact minutes references) and report
 * the total removed. Pure orchestration over the store — no I/O of its own. The caseload-wide meeting / policy /
 * attendance / minutes rows are never deleted (§8.4).
 */
export async function eraseIdgRecord(
  organizationId: string,
  patientId: string,
  store: IdgEraseStore,
  options: IdgEraseOptions = {},
): Promise<{ erased: number; counts: IdgEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const retentionAsOf = options.retentionAsOf ?? now();

  await store.lockPatient(organizationId, patientId);

  const counts = await store.erasePatientRecords(organizationId, patientId, retentionAsOf);
  // minutesRedacted is bookkeeping (rows redacted-in-place, not deleted) — excluded from the deleted-row tally.
  const erased = counts.packets + counts.decisions + counts.actionItems + counts.agendaItems;
  return { erased, counts };
}

/** Seed shape for the in-memory {@link IdgEraseStore} (slice/tests). */
export interface InMemoryIdgEraseSeed {
  /** Per-table counts a first erase removes. */
  readonly counts?: Partial<IdgEraseCounts>;
}

/** An in-memory {@link IdgEraseStore} for the slice/tests (seeded counts; idempotent on a second erase). */
export function createInMemoryIdgEraseStore(seed: InMemoryIdgEraseSeed = {}): {
  store: IdgEraseStore;
  locked: string[];
} {
  const zero: IdgEraseCounts = {
    packets: 0,
    decisions: 0,
    actionItems: 0,
    agendaItems: 0,
    minutesRedacted: 0,
  };
  const counts: IdgEraseCounts = { ...zero, ...seed.counts };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_org, patientId) {
        locked.push(patientId);
      },
      async erasePatientRecords() {
        // idempotent: a second erase removes nothing (rows already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
    },
  };
}

/** Injected adapter for the M14 eraser (slice defaults to in-memory). */
export interface IdgEraserDeps {
  store?: IdgEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: IdgEraseOptions;
}

/** Build M14's `idg_record` DataEraser. `subjectId` is the patient being destroyed (§8.4). */
export function createIdgEraser(store: IdgEraseStore, options: IdgEraseOptions = {}): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseIdgRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M14's REAL `idg_record` eraser over the Phase-0 deny-stub (M14-T07; before validateErasers()). */
export function registerIdgErasers(deps: IdgEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryIdgEraseStore().store;
  registerEraser("idg_record", createIdgEraser(store, deps.options ?? {}));
}
