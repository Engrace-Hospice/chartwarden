// apps/backend/src/modules/06-admission/seams/portal-discharge-grace-for-org.ts — the org-explicit, BATCHED
// "which of these patients are discharged-alive past a cutoff and NOT re-admitted" read M31's daily
// post-discharge-grace sweep needs (F-222, #248; M31 spec §7.6 / §4.8 `m31.post-discharge-grace.cron`).
//
// WHY A PULL: the push alternative (`m6.admission.discharged` -> a per-event 30-day delayed job that a
// re-admission must CANCEL) needs cancel logic and a jobs tier; a sweep over the CURRENT discharge state
// needs neither — a re-admitted patient simply stops being a candidate (an open admission exists again).
//
// THE FACT THIS PROJECTS (per patient, from M6's own tables only):
//   • the patient's LATEST completed discharge (`discharge_event.status='completed'`, greatest
//     `effective_at`; `pending_cosign`/`voided` for-cause discharges never count — the admission stays active
//     until a medical director resolves them) is NOT a `death` (death is the bereavement path: M16 plan_opened /
//     contact_active flip the grants, never this sweep), AND
//   • that `effective_at` is STRICTLY BEFORE `cutoffDate` (the caller computes `today - graceDays`; strict `<`
//     means access survives THROUGH day discharge+graceDays — never shorter than the floor), AND
//   • the patient has NO open admission (status NOT IN discharged/bereavement/closed) — a re-admission
//     (including a draft referral admission) keeps the patient out, deliberately conservative: never revoke
//     access on a stale read.
// Using the LATEST discharge (not "any old discharge") is what makes a discharge -> re-admit -> discharge
// cycle restart the clock from the newest discharge.
//
// ORG-EXPLICIT: opens its own `withOrgContext` (a cron tick is not a request) and filters `organization_id`
// explicitly, so a wrong-tenant call cannot read another tenant even on a superuser connection.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";

const ADM = schema.admissions;
const DIS = schema.dischargeEvents;

/** A read with no acting human (the `ADMISSION_READER_SYSTEM_USER_ID` convention). */
const PORTAL_GRACE_SYSTEM_USER_ID = "";

/** A patient id list this long is a caller bug — the M31 sweep pages well under it. */
export const PORTAL_DISCHARGE_GRACE_MAX_PATIENTS = 500;

/** One patient whose latest discharge is alive, past the cutoff, and not re-admitted. */
export interface PortalDischargedPastGrace {
  readonly patientId: string;
  /** The M6 `discharge_event.id` the decision rests on — the audit back-reference. */
  readonly dischargeEventId: string;
  readonly admissionId: string;
  /** `discharge_event.effective_at` (a calendar date, `YYYY-MM-DD`). */
  readonly effectiveAt: string;
  readonly dischargeType: string;
}

/** The pure decision over one patient's rows (exported for unit tests — no DB). */
export function isPastGraceAndNotReadmitted(input: {
  readonly latestDischargeType: string;
  readonly latestEffectiveAt: string;
  readonly cutoffDate: string;
  readonly hasOpenAdmission: boolean;
}): boolean {
  if (input.hasOpenAdmission) return false;
  if (input.latestDischargeType === "death") return false;
  // ISO dates compare lexicographically; strict `<` so access survives the whole floor day.
  return input.latestEffectiveAt < input.cutoffDate;
}

/**
 * Of `patientIds`, the ones whose latest completed discharge is non-death, strictly older than `cutoffDate`
 * (`YYYY-MM-DD`), with no open admission. Patients that fail any condition (or have no discharge) are absent
 * from the map. TWO queries, one tenant-scoped transaction.
 */
export async function portalDischargedPastGraceForOrg(
  db: DbClient,
  organizationId: string,
  patientIds: readonly string[],
  cutoffDate: string,
): Promise<ReadonlyMap<string, PortalDischargedPastGrace>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) {
    throw new Error(`portalDischargedPastGraceForOrg: cutoffDate '${cutoffDate}' is not YYYY-MM-DD`);
  }
  const ids = [...new Set(patientIds)];
  const out = new Map<string, PortalDischargedPastGrace>();
  if (ids.length === 0) return out;
  if (ids.length > PORTAL_DISCHARGE_GRACE_MAX_PATIENTS) {
    throw new Error(
      `portalDischargedPastGraceForOrg: ${ids.length} patients exceeds the ${PORTAL_DISCHARGE_GRACE_MAX_PATIENTS} cap`,
    );
  }
  return withOrgContext(
    db,
    { organizationId, userId: PORTAL_GRACE_SYSTEM_USER_ID },
    async (tx) => {
      const t = tx as unknown as DbClient;
      const discharges = await t
        .select({
          patientId: ADM.patientId,
          dischargeEventId: DIS.id,
          admissionId: DIS.admissionId,
          effectiveAt: DIS.effectiveAt,
          dischargeType: DIS.dischargeType,
        })
        .from(DIS)
        .innerJoin(ADM, eq(ADM.id, DIS.admissionId))
        .where(
          and(
            eq(DIS.organizationId, organizationId),
            eq(ADM.organizationId, organizationId),
            eq(DIS.status, "completed"),
            inArray(ADM.patientId, ids),
          ),
        )
        .orderBy(desc(DIS.effectiveAt), desc(DIS.createdAt));
      // First row per patient = the latest completed discharge (ordered newest first).
      const latest = new Map<string, (typeof discharges)[number]>();
      for (const d of discharges) if (!latest.has(d.patientId)) latest.set(d.patientId, d);
      if (latest.size === 0) return out;

      const open = await t
        .select({ patientId: ADM.patientId })
        .from(ADM)
        .where(
          and(
            eq(ADM.organizationId, organizationId),
            inArray(ADM.patientId, [...latest.keys()]),
            notInArray(ADM.status, ["discharged", "bereavement", "closed"]),
          ),
        );
      const reAdmitted = new Set(open.map((r) => r.patientId));

      for (const [patientId, d] of latest) {
        if (
          !isPastGraceAndNotReadmitted({
            latestDischargeType: d.dischargeType,
            latestEffectiveAt: d.effectiveAt,
            cutoffDate,
            hasOpenAdmission: reAdmitted.has(patientId),
          })
        ) {
          continue;
        }
        out.set(patientId, {
          patientId,
          dischargeEventId: d.dischargeEventId,
          admissionId: d.admissionId,
          effectiveAt: d.effectiveAt,
          dischargeType: d.dischargeType,
        });
      }
      return out;
    },
  );
}
