// apps/backend/src/modules/10-hope/seams/drizzle-store.ts — the Drizzle-backed §2 / D10
// {@link HopeSeamStore} (TASK-002, ARCH-003). Until this file, the composition root registered the
// three per-entity HOPE seams (HopeTimepointProvider / HopeJ2051Provider / HopeSubmissionProvider)
// over an unseeded in-memory Map on a db boot: M14's IDG packet read "no open HOPE windows", M30's
// HQRP inputs read empty, M22's timeline rendered nothing — about a database never read. (The
// org-level HopeOrgRollupProvider was already Drizzle-backed via org-rollup-store.ts; this closes
// the per-patient/per-PE surface.)
//
// TENANCY: the port's reads key on patientId / admissionId / providerEntityId with the org PINNED BY
// RLS (store.ts header) — every method opens the CONSUMER's ambient request context via
// `withOrgContextFromRequest`, never selecting by a caller-passed org (the M21 store precedent).
//
// Projection: structured columns only. No HOPE-section `data` jsonb and no
// `clinical_context_snapshot` ever crosses (store.ts header rule).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext, withOrgContextFromRequest } from "@chartwarden/tenancy";
import type { HopeJ2051Event, HopeSubmissionStatusView, HopeTimepointStatus } from "@chartwarden/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { HopeSeamStore } from "./store";

const SCHED = schema.hopeTimepointSchedules;
const ASSESS = schema.hopeAssessments;
const SFV = schema.symptomFollowUpVisits;
const SUB = schema.hopeSubmissions;

type SeamTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const toTimepoint = (r: {
  id: string;
  patientId: string;
  admissionId: string;
  rfaKind: string;
  status: string;
  windowOpensAt: Date;
  windowClosesAt: Date;
  lateDeadlineAt: Date;
  completedByAssessmentId: string | null;
  generatedBy: string;
}): HopeTimepointStatus => ({
  scheduleId: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  rfaKind: r.rfaKind as HopeTimepointStatus["rfaKind"],
  status: r.status as HopeTimepointStatus["status"],
  windowOpensAt: r.windowOpensAt.toISOString(),
  windowClosesAt: r.windowClosesAt.toISOString(),
  lateDeadlineAt: r.lateDeadlineAt.toISOString(),
  completedByAssessmentId: r.completedByAssessmentId,
  generatedBy: r.generatedBy as HopeTimepointStatus["generatedBy"],
});

const toSubmission = (r: {
  id: string;
  providerEntityId: string;
  submissionPeriod: string;
  status: string;
  itemCount: number;
  acceptedCount: number;
  rejectedCount: number;
  transmittedAt: Date | null;
  acceptedAt: Date | null;
}): HopeSubmissionStatusView => ({
  submissionId: r.id,
  providerEntityId: r.providerEntityId,
  submissionPeriod: r.submissionPeriod,
  status: r.status as HopeSubmissionStatusView["status"],
  itemCount: r.itemCount,
  acceptedCount: r.acceptedCount,
  rejectedCount: r.rejectedCount,
  transmittedAt: r.transmittedAt?.toISOString() ?? null,
  acceptedAt: r.acceptedAt?.toISOString() ?? null,
});

const SCHED_COLUMNS = {
  id: SCHED.id,
  patientId: SCHED.patientId,
  admissionId: SCHED.admissionId,
  rfaKind: SCHED.rfaKind,
  status: SCHED.status,
  windowOpensAt: SCHED.windowOpensAt,
  windowClosesAt: SCHED.windowClosesAt,
  lateDeadlineAt: SCHED.lateDeadlineAt,
  completedByAssessmentId: SCHED.completedByAssessmentId,
  generatedBy: SCHED.generatedBy,
} as const;

const SUB_COLUMNS = {
  id: SUB.id,
  providerEntityId: SUB.providerEntityId,
  submissionPeriod: SUB.submissionPeriod,
  status: SUB.status,
  itemCount: SUB.itemCount,
  acceptedCount: SUB.acceptedCount,
  rejectedCount: SUB.rejectedCount,
  transmittedAt: SUB.transmittedAt,
  acceptedAt: SUB.acceptedAt,
} as const;

/** Build the Drizzle {@link HopeSeamStore} over the schedule / assessment / SFV / submission tables. */
export function createDrizzleHopeSeamStore(db: DbClient): HopeSeamStore {
  return {
    async timepointsForPatient(patientId) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        const rows = await tx
          .select(SCHED_COLUMNS)
          .from(SCHED)
          .where(eq(SCHED.patientId, patientId));
        return rows.map(toTimepoint);
      });
    },

    async timepointsForAdmission(admissionId) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        const rows = await tx
          .select(SCHED_COLUMNS)
          .from(SCHED)
          .where(eq(SCHED.admissionId, admissionId));
        return rows.map(toTimepoint);
      });
    },

    async j2051EventsForPatient(patientId) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        // Every SIGNED (active — the supersede trigger flips priors to 'superseded') assessment is a
        // J2051 reading: fired rows drive the SFV worklist, non-fired severities feed M32's
        // trajectory read. `triggeredAt` is the sign instant (the server-authoritative verdict is
        // computed at sign, §J).
        const rows = await tx
          .select({
            id: ASSESS.id,
            j2051MaxSeverity: ASSESS.j2051MaxSeverity,
            j2051TriggerFired: ASSESS.j2051TriggerFired,
            signedAt: ASSESS.signedAt,
          })
          .from(ASSESS)
          .where(and(eq(ASSESS.patientId, patientId), eq(ASSESS.status, "signed")));
        const signed = rows.filter((r) => r.signedAt !== null);
        if (signed.length === 0) return [];
        const sfvRows = await tx
          .select({
            id: SFV.id,
            triggeringAssessmentId: SFV.triggeringAssessmentId,
            dueAt: SFV.dueAt,
            status: SFV.status,
          })
          .from(SFV)
          .where(
            inArray(
              SFV.triggeringAssessmentId,
              signed.map((r) => r.id),
            ),
          );
        const sfvByAssessment = new Map(sfvRows.map((s) => [s.triggeringAssessmentId, s] as const));
        return signed.map((r): HopeJ2051Event => {
          const sfv = sfvByAssessment.get(r.id);
          return {
            assessmentId: r.id,
            sfvId: sfv?.id ?? null,
            patientId,
            maxSeverity: r.j2051MaxSeverity as HopeJ2051Event["maxSeverity"],
            triggerFired: r.j2051TriggerFired,
            triggeredAt: (r.signedAt as Date).toISOString(),
            sfvDueAt: sfv?.dueAt.toISOString() ?? null,
            sfvStatus: (sfv?.status as HopeJ2051Event["sfvStatus"]) ?? null,
          };
        });
      });
    },

    async latestSubmissionForProviderEntity(providerEntityId) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        // "Latest" = most recent transmit; untransmitted batches sort OLDEST (the in-memory
        // reference's `transmittedAt ?? ""` ordering). Postgres DESC defaults to NULLS FIRST, which
        // would pick an untransmitted batch — force NULLS LAST explicitly.
        const rows = await tx
          .select(SUB_COLUMNS)
          .from(SUB)
          .where(eq(SUB.providerEntityId, providerEntityId))
          .orderBy(sql`${SUB.transmittedAt} desc nulls last`)
          .limit(1);
        return rows[0] ? toSubmission(rows[0]) : null;
      });
    },

    async submissionById(submissionId) {
      return withOrgContextFromRequest(db, async (tx: SeamTx) => {
        const rows = await tx
          .select(SUB_COLUMNS)
          .from(SUB)
          .where(eq(SUB.id, submissionId))
          .limit(1);
        return rows[0] ? toSubmission(rows[0]) : null;
      });
    },
  };
}

/**
 * F-164 (#248) — the org-explicit `patientId` lookup M14's "since last IDG" cache consumer needs for
 * `m10.hope.j2051_trigger_fired`/`.sfv_created` (neither payload carries one). A relay tick is not a
 * request, so the published per-patient `HopeJ2051Provider`/`HopeTimepointProvider` seams (which open
 * every read under `withOrgContextFromRequest`, and are patientId-IN rather than patientId-OUT regardless)
 * cannot answer this — the `encounterIdsForVisitsForOrg` (M8) precedent applied to this module.
 */
export async function hopeAssessmentPatientIdForOrg(
  db: DbClient,
  organizationId: string,
  hopeAssessmentId: string,
): Promise<string | null> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const [row] = await tx
      .select({ patientId: ASSESS.patientId })
      .from(ASSESS)
      .where(and(eq(ASSESS.organizationId, organizationId), eq(ASSESS.id, hopeAssessmentId)))
      .limit(1);
    return row?.patientId ?? null;
  });
}
