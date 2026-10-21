// apps/backend/src/modules/09-assessments/erasers/assessment-eraser.ts — M9-T07 the `clinical_assessment`
// data eraser (M9 spec §8.4; M4 destruction-cert workflow, D7/D8).
//
// M9 owns the destruction callback for a patient's ASSESSMENT record — the clinical-scale facts M9 captures
// around the M5 patient spine. Under an M4 destruction certificate it (1) acquires a per-patient advisory lock
// to avoid racing concurrent writes during destruction (§8.4 #1), (2) erases the child rows first
// (`assessment_cosignature`, `significant_change_event`) referencing the assessments, then (3) the
// `clinical_assessment` rows themselves — BOTH `active` AND `superseded`, so a correction-supersede chain is
// erased at both ends and no orphaned half survives (§8.4 #2). Unlike the M5/M6/M7/M8 erasers there is NO root
// to tombstone: the assessment rows are the leaf clinical facts, so they are deleted outright. The org-level
// `scale_license` / `scale_policy` tables are NEVER touched — they are tenant configuration, not patient data
// (§8.4 #3). The four sibling erasers are disjoint by table ownership: M5 destroys the patient demographics
// subtree, M6 the admission subtree, M7 the care-plan subtree, M8 the encounter subtree, M9 the assessment rows.
//
// Registers the REAL eraser over the Phase-0 deny-stub (`clinical_assessment` is in REQUIRED_ERASERS); the
// composition root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before
// validateErasers(), so a real eraser stands over its stub.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser } from "@chartwarden/types";
import { eq, inArray, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** The per-table counts an assessment-record destruction removed (recorded on the destruction cert, §8.4 #5). */
export interface AssessmentEraseCounts {
  readonly cosignatures: number;
  readonly significantChangeEvents: number;
  readonly assessments: number;
  /** `assessment_reassessment_due` rows removed (GAP-181 cadence ledger; patient-keyed, no assessment FK). */
  readonly reassessmentDue?: number;
}

/** The narrow data port the assessment eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface AssessmentEraseStore {
  /**
   * Acquire a per-patient advisory lock (keyed on patient id) so a concurrent write cannot interleave with
   * the destruction (§8.4 #1). Released by the surrounding transaction commit in prod; a no-op in the slice.
   */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Delete the child rows (`assessment_cosignature`, `significant_change_event`) referencing the patient's
   * assessments, then the `clinical_assessment` rows themselves (active AND superseded). Returns per-table
   * counts. No root is tombstoned — the assessment rows are the leaf clinical facts (§8.4 #2).
   */
  eraseAssessmentSubtree(organizationId: string, patientId: string): Promise<AssessmentEraseCounts>;
}

/**
 * Erase a patient's assessment-record subtree under a destruction certificate (D7/D8): lock the patient,
 * delete the child rows and the assessment rows (active + superseded), and report the total removed. Pure
 * orchestration over the store — no I/O of its own.
 */
export async function eraseAssessmentRecord(
  organizationId: string,
  patientId: string,
  store: AssessmentEraseStore,
): Promise<{ erased: number; counts: AssessmentEraseCounts }> {
  await store.lockPatient(organizationId, patientId);
  const counts = await store.eraseAssessmentSubtree(organizationId, patientId);
  const erased = Object.values(counts).reduce((a, b) => a + b, 0);
  return { erased, counts };
}

/** An in-memory {@link AssessmentEraseStore} for the slice/tests (seeded per-table counts to remove). */
export function createInMemoryAssessmentEraseStore(seed: Partial<AssessmentEraseCounts> = {}): {
  store: AssessmentEraseStore;
  locked: string[];
} {
  const zero: AssessmentEraseCounts = {
    cosignatures: 0,
    significantChangeEvents: 0,
    assessments: 0,
  };
  const counts: AssessmentEraseCounts = { ...zero, ...seed };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_org, patientId) {
        locked.push(patientId);
      },
      async eraseAssessmentSubtree() {
        // idempotent: a second erase removes nothing (rows already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
    },
  };
}

/**
 * The Drizzle-backed store: the REAL destruction path (TASK-003 / ARCH-007). Runs inside
 * `withOrgContext` so RLS scopes every statement to the acting org. `clinical_assessment` is RANGE-
 * partitioned by `captured_at` — every statement targets the PARTITIONED PARENT (exactly how the M9
 * route services read/write it), so Postgres routes the select/delete across all monthly partitions;
 * no per-partition access is ever attempted. There is NO tombstone: the assessment rows are the leaf
 * clinical facts and are deleted OUTRIGHT — active AND superseded, no status filter — after their
 * `assessment_cosignature` / `significant_change_event` children (§8.4 #2). The org-level
 * `scale_license` / `scale_policy` tables are tenant configuration and are NEVER touched (§8.4 #3).
 * Counts come from `returning` lengths (rows ACTUALLY removed). The M9 grants give `chartwarden_app` no
 * DELETE (append-only), so under an app-role connection Postgres REFUSES the delete and this store
 * THROWS — the destruction path must be handed a privileged (chartwarden_admin) `DbClient` at the
 * composition root.
 */
export function createDrizzleAssessmentEraseStore(db: DbClient): AssessmentEraseStore {
  const CA = schema.clinicalAssessments;
  const COSIGN = schema.assessmentCosignatures;
  const SCE = schema.significantChangeEvents;
  const DUE = schema.assessmentReassessmentDue;

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the patient key (§8.4 #1), released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async eraseAssessmentSubtree(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const zero: AssessmentEraseCounts = {
          cosignatures: 0,
          significantChangeEvents: 0,
          assessments: 0,
        };
        // The cadence ledger is keyed on the patient, not an assessment id, so it goes first and regardless of
        // whether any assessment row survives (a second erase is still idempotent).
        const reassessmentDue = (
          await tx.delete(DUE).where(eq(DUE.patientId, patientId)).returning({ id: DUE.id })
        ).length;
        // The children are keyed on assessment id (plain uuid — the partitioned parent takes no FK),
        // so resolve the patient's assessment ids first, via the parent (partition-safe).
        const assessmentIds = (
          await tx.select({ id: CA.id }).from(CA).where(eq(CA.patientId, patientId))
        ).map((r) => r.id);
        if (assessmentIds.length === 0) return { ...zero, reassessmentDue }; // idempotent: a second erase finds nothing.

        const cosignatures = (
          await tx
            .delete(COSIGN)
            .where(inArray(COSIGN.clinicalAssessmentId, assessmentIds))
            .returning({ id: COSIGN.id })
        ).length;
        const significantChangeEvents = (
          await tx
            .delete(SCE)
            .where(inArray(SCE.clinicalAssessmentId, assessmentIds))
            .returning({ id: SCE.id })
        ).length;
        // Active AND superseded in one parent-targeted statement, so a correction-supersede chain is
        // erased at both ends within the same transaction (the DEFERRABLE self-FK never fires).
        const assessments = (
          await tx.delete(CA).where(eq(CA.patientId, patientId)).returning({ id: CA.id })
        ).length;

        return { cosignatures, significantChangeEvents, assessments, reassessmentDue };
      });
    },
  };
}

/** Injected adapter for the M9 eraser (slice defaults to in-memory). */
export interface AssessmentEraserDeps {
  store?: AssessmentEraseStore;
}

/** Build M9's `clinical_assessment` DataEraser. `subjectId` is the patient being destroyed (D7/D8). */
export function createAssessmentEraser(store: AssessmentEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseAssessmentRecord(scope.orgId, subjectId, store);
      return { erased };
    },
  };
}

/** Register M9's REAL `clinical_assessment` eraser over the Phase-0 deny-stub (M9-T07; before validateErasers()). */
export function registerAssessmentErasers(deps: AssessmentEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryAssessmentEraseStore().store;
  registerEraser("clinical_assessment", createAssessmentEraser(store));
}
