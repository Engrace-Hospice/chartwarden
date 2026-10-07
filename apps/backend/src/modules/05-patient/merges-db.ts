// apps/backend/src/modules/05-patient/merges-db.ts — the real Drizzle-backed direct patient merge
// (F-171, #248) `merges.ts`'s pure `planMerge` closes over.
//
// Mirrors the `deceased.ts` / `deceased-db.ts` split: `merges.ts` is the pure decision core (no I/O),
// this file is the ONE transaction that reads both rows, applies the target's field resolutions, flips
// the source to `merged`, writes the `patient_merge` audit row, and emits `m5.patient.merged` — all
// under the SAME `withOrgContext` tx, so a rejected outbox payload rolls the whole merge back rather
// than leaving a half-merged pair (the `deceased-db.ts` file header's own documented invariant).
//
// NOT part of `PatientRouteService` — like `recordDeathFromDischarge`, this is invoked directly by its
// one real caller (the merge ROUTE, here, rather than an outbox consumer) with `db` + the outbox port
// closed over at the composition root, so `PatientRouteService`'s in-memory slice implementation is
// untouched.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { M5OutboxPort } from "./deceased-db";
import { type FieldResolutions, type PatientMergeSubject, planMerge } from "./merges";
import { SOURCE_PRIOR_STATUS_KEY } from "./patient-lifecycle";

const P = schema.patients;
const PM = schema.patientMerges;

/** The subject-row projection {@link planMerge} needs — `id`/`status` plus every mergeable field. */
const SUBJECT_COLUMNS = {
  id: P.id,
  status: P.status,
  legalFirstName: P.legalFirstName,
  legalMiddleName: P.legalMiddleName,
  legalLastName: P.legalLastName,
  legalNameSuffix: P.legalNameSuffix,
  dob: P.dob,
  sexAssignedAtBirth: P.sexAssignedAtBirth,
  genderIdentityCode: P.genderIdentityCode,
  sexualOrientationCode: P.sexualOrientationCode,
  pronounsCode: P.pronounsCode,
  maritalStatusCode: P.maritalStatusCode,
  raceCodes: P.raceCodes,
  ethnicityCodes: P.ethnicityCodes,
} as const;

function toSubject(row: {
  id: string;
  status: string;
  [key: string]: unknown;
}): PatientMergeSubject {
  return { id: row.id, status: row.status, fields: row };
}

export class PatientNotFoundError extends Error {
  constructor(readonly patientId: string) {
    super(`patient '${patientId}' not found`);
    this.name = "PatientNotFoundError";
  }
}

export interface MergePatientsInput {
  readonly organizationId: string;
  readonly sourcePatientId: string;
  readonly targetPatientId: string;
  readonly fieldResolutions: FieldResolutions;
  readonly reason: string;
  readonly actorUserId: string;
}

export interface MergePatientsResult {
  readonly mergeId: string;
  readonly sourcePatientId: string;
  readonly targetPatientId: string;
  /** The target-row columns the merge actually wrote (empty when every resolution kept `target`). */
  readonly targetFieldsApplied: readonly string[];
}

/**
 * Execute a direct patient merge (§4.3 `POST /api/v1/patients/:id/merge`): loads both rows (org-scoped,
 * RLS-backstopped), plans the merge via the pure core (validates preconditions, resolves field
 * conflicts), applies the target's field updates, flips the source to `merged` + `merged_into_id`,
 * writes the `patient_merge` audit row, and emits `m5.patient.merged` — one transaction. Every OTHER
 * table's `patient_id` FK is left pointed at the source (§2.4's "no destructive UPDATE on satellite
 * tables"); this function performs no cross-table re-point of any kind.
 *
 * Throws {@link PatientNotFoundError} for a missing/cross-tenant id, or one of `merges.ts`'s typed
 * precondition errors (self-merge, already-merged source/target, an unmergeable source status, or an
 * unknown field-resolution key) — the route layer maps each to its own HTTP status.
 */
export async function mergePatients(
  db: DbClient,
  outbox: M5OutboxPort,
  input: MergePatientsInput,
): Promise<MergePatientsResult> {
  return withOrgContext<DbClient, MergePatientsResult>(
    db,
    { organizationId: input.organizationId, userId: input.actorUserId },
    (tx) => mergePatientsInTx(tx, outbox, input),
  );
}

/** The merge body on a caller-supplied `withOrgContext` tx — so the §7.3 review-queue merge closes its
 *  `patient_match_review` row in the SAME transaction as the merge itself. */
export async function mergePatientsInTx(
  tx: DbClient,
  outbox: M5OutboxPort,
  input: MergePatientsInput,
): Promise<MergePatientsResult> {
  {
    const [sourceRow] = await tx
      .select(SUBJECT_COLUMNS)
      .from(P)
      .where(and(eq(P.organizationId, input.organizationId), eq(P.id, input.sourcePatientId)))
      .limit(1);
    if (!sourceRow) throw new PatientNotFoundError(input.sourcePatientId);

    const [targetRow] = await tx
      .select(SUBJECT_COLUMNS)
      .from(P)
      .where(and(eq(P.organizationId, input.organizationId), eq(P.id, input.targetPatientId)))
      .limit(1);
    if (!targetRow) throw new PatientNotFoundError(input.targetPatientId);

    const planned = planMerge({
      source: toSubject(sourceRow),
      target: toSubject(targetRow),
      fieldResolutions: input.fieldResolutions,
      reason: input.reason,
    });

    if (Object.keys(planned.targetFieldUpdates).length > 0) {
      await tx
        .update(P)
        .set({ ...planned.targetFieldUpdates, updatedAt: new Date() })
        .where(and(eq(P.organizationId, input.organizationId), eq(P.id, input.targetPatientId)));
    }

    await tx
      .update(P)
      .set({ status: "merged", mergedIntoId: input.targetPatientId, updatedAt: new Date() })
      .where(and(eq(P.organizationId, input.organizationId), eq(P.id, input.sourcePatientId)));

    const [mergeRow] = await tx
      .insert(PM)
      .values({
        organizationId: input.organizationId,
        sourcePatientId: input.sourcePatientId,
        targetPatientId: input.targetPatientId,
        reason: input.reason,
        // The source's pre-merge status rides along under a reserved key so an unmerge restores it.
        mergedFieldDiff: {
          ...planned.mergedFieldDiff,
          [SOURCE_PRIOR_STATUS_KEY]: sourceRow.status,
        },
        performedBy: input.actorUserId || null,
      })
      .returning({ id: PM.id });
    if (!mergeRow) throw new Error("patient_merge insert returned no row");

    await outbox.publish(tx, {
      eventName: "m5.patient.merged",
      payload: {
        patientId: input.targetPatientId,
        organizationId: input.organizationId,
        sourcePatientId: input.sourcePatientId,
      },
      organizationId: input.organizationId,
      aggregateKind: "patient",
      aggregateId: input.targetPatientId,
    });

    return {
      mergeId: mergeRow.id,
      sourcePatientId: input.sourcePatientId,
      targetPatientId: input.targetPatientId,
      targetFieldsApplied: Object.keys(planned.targetFieldUpdates),
    };
  }
}
