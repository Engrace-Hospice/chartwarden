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
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { eq, inArray, or, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

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

/**
 * The Drizzle-backed store: the REAL destruction path (ARCH-007 bind). Every statement runs inside
 * `withOrgContext` so RLS scopes it to the acting org (a destruction certificate can never reach
 * across tenants). Discipline:
 *
 *   • FK ORDER — the election-period LEAVES first (CTI / F2F / election statement / revocation all
 *     RESTRICT-FK the period), then the periods, then the admission-keyed satellites, then the
 *     `referral` rows. Deleting a referral auto-clears `admission.referral_id` (its FK is
 *     ON DELETE SET NULL) so the tombstoned root never dangles.
 *   • REFERRAL REACH — referrals are keyed on the patient (`referral.patient_id`), plus any referral
 *     an admission points at whose `patient_id` was never backfilled (pre-conversion drafts).
 *   • COUNTS come from rows actually deleted (`.returning()`), never from input length.
 *   • The `admission` row is TOMBSTONED, not deleted (D8): status flips to the terminal 'closed'
 *     (outside the `admission_patient_open_idx` partial-unique predicate, so it can never block a
 *     future admission) and the free-text `hold_reason` — the row's only clinical narrative — is
 *     cleared. Structural timestamps stay: the destruction certificate's tombstone remains datable.
 *
 * Idempotent (a second erase finds nothing and reports zero). A statement that cannot write THROWS
 * (Drizzle surfaces the SQL error); nothing is swallowed.
 */
export function createDrizzleAdmissionEraseStore(db: DbClient): AdmissionEraseStore {
  const ADM = schema.admissions;
  const REF = schema.referrals;
  const EP = schema.electionPeriods;
  const ES = schema.electionStatements;
  const CTI = schema.certificationsOfTerminalIllness;
  const F2F = schema.faceToFaceEncounters;
  const LOC = schema.levelOfCarePeriods;
  const REV = schema.revocationEvents;
  const DIS = schema.dischargeEvents;
  const TRANS = schema.transferEvents;
  const NOR = schema.noticeOfRightsAcknowledgments;
  const CW = schema.complianceWindows;

  /** The patient's admission roots + the referral ids they point at. */
  const admissionsFor = async (tx: Tx, patientId: string) =>
    tx
      .select({ id: ADM.id, referralId: ADM.referralId })
      .from(ADM)
      .where(eq(ADM.patientId, patientId));

  return {
    async eraseAdmissionSubtree(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Concurrency fence: the per-patient advisory lock the M5/M15/M16 erasers take, released at
        // transaction commit — a concurrent admission write cannot interleave with the destruction.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);

        const roots = await admissionsFor(tx, patientId);
        const admissionIds = roots.map((r) => r.id);
        const rootReferralIds = roots
          .map((r) => r.referralId)
          .filter((id): id is string => id !== null);
        const periodIds =
          admissionIds.length === 0
            ? []
            : (
                await tx
                  .select({ id: EP.id })
                  .from(EP)
                  .where(inArray(EP.admissionId, admissionIds))
              ).map((r) => r.id);

        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;

        // Election-period LEAVES first — CTI / F2F / statement / revocation RESTRICT-FK the period.
        const certifications =
          periodIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(CTI)
                  .where(inArray(CTI.electionPeriodId, periodIds))
                  .returning({ id: CTI.id }),
              );
        const faceToFaceEncounters =
          periodIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(F2F)
                  .where(inArray(F2F.electionPeriodId, periodIds))
                  .returning({ id: F2F.id }),
              );
        // Election statements carry the patient id directly — key on it so a statement can never be
        // stranded (every period of this patient's admissions is deleted below anyway).
        const electionStatements = await del(() =>
          tx.delete(ES).where(eq(ES.patientId, patientId)).returning({ id: ES.id }),
        );
        const revocationEvents =
          admissionIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(REV)
                  .where(inArray(REV.admissionId, admissionIds))
                  .returning({ id: REV.id }),
              );
        const electionPeriods =
          admissionIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(EP)
                  .where(inArray(EP.admissionId, admissionIds))
                  .returning({ id: EP.id }),
              );

        // Admission-keyed satellites (order among these is free — no cross-FKs).
        const levelOfCarePeriods =
          admissionIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(LOC)
                  .where(inArray(LOC.admissionId, admissionIds))
                  .returning({ id: LOC.id }),
              );
        const dischargeEvents =
          admissionIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(DIS)
                  .where(inArray(DIS.admissionId, admissionIds))
                  .returning({ id: DIS.id }),
              );
        const transferEvents =
          admissionIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(TRANS)
                  .where(inArray(TRANS.admissionId, admissionIds))
                  .returning({ id: TRANS.id }),
              );
        // NOR acknowledgments carry the patient id directly — same completeness argument as above.
        const noticeOfRightsAcknowledgments = await del(() =>
          tx.delete(NOR).where(eq(NOR.patientId, patientId)).returning({ id: NOR.id }),
        );
        const complianceWindows =
          admissionIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(CW)
                  .where(inArray(CW.admissionId, admissionIds))
                  .returning({ id: CW.id }),
              );

        // Referrals last: the patient's own rows, plus any admission-pointed referral whose
        // patient_id was never backfilled. `admission.referral_id` is ON DELETE SET NULL, so the
        // tombstoned root is cleaned up by the FK itself.
        const referrals = await del(() =>
          tx
            .delete(REF)
            .where(
              rootReferralIds.length === 0
                ? eq(REF.patientId, patientId)
                : or(eq(REF.patientId, patientId), inArray(REF.id, rootReferralIds)),
            )
            .returning({ id: REF.id }),
        );

        return {
          referrals,
          electionPeriods,
          electionStatements,
          certifications,
          faceToFaceEncounters,
          levelOfCarePeriods,
          revocationEvents,
          dischargeEvents,
          transferEvents,
          noticeOfRightsAcknowledgments,
          complianceWindows,
        };
      });
    },

    async tombstoneAdmissions(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // D8 tombstone: status flips to the terminal 'closed' (outside the open-admission
        // partial-unique predicate) and the free-text hold narrative is cleared. Idempotent.
        await tx
          .update(ADM)
          .set({ status: "closed", holdReason: null, updatedAt: new Date() })
          .where(eq(ADM.patientId, patientId));
      });
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
