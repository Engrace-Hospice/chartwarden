// apps/backend/src/modules/10-hope/seams/idg-hope-context-for-org.ts — the org-explicit, BATCHED HOPE context
// the M14 IDG packet's `hopeContext` block needs (M14 spec §2.4 `hopeContext.upcomingTimepoints` /
// `openSfvCount`; M14 §1.1 "M10 `HopeTimepointProvider` for upcoming RFAs/SFV chain").
//
// The per-patient `HopeTimepointProvider.openTimepoints` / `HopeJ2051Provider.openSfvs` seams resolve through
// the AMBIENT request context, which a packet-build cron tick does not have — so this is their org-explicit
// batched twin over the SAME M10 tables (`hope_timepoint_schedule`, `symptom_follow_up_visit`) and the SAME
// semantics:
//   • upcomingTimepoints — the patient's schedule rows still `open` (not completed / expired / skipped), one per
//     window, base RFAs only (`04_sfv` schedule rows are the SFV chain, counted below, never double-listed).
//     `timepoint` = the RFA kind (`01_admission`, …); `dueAt` = the window CLOSE (the regulatory due instant).
//     An open window already past its close is still returned — it is the most urgent thing to show.
//     Sorted by `dueAt` ascending.
//   • openSfvCount — `symptom_follow_up_visit` rows with status `open` or `overdue` (the SAME open set as
//     `createHopeJ2051Provider.openSfvs`; a `completed` / `missed` SFV is terminal).
// EVERY requested patient gets an entry (an empty context is a TRUE "nothing due", not "unknown") — an
// unbound/failed seam is the "unknown" case and is the CALLER's null. No assessment answers, no clinician, no
// free text cross this seam: enums, instants and a count only. RLS scopes by `app.org_id`.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray, ne } from "drizzle-orm";

const SCHED = schema.hopeTimepointSchedules;
const SFV = schema.symptomFollowUpVisits;

/** A read with no acting human (the empty-GUC system convention). */
const IDG_HOPE_SYSTEM_USER_ID = "";

/** A patient id list this long is a caller bug (an IDG caseload is dozens). */
export const IDG_HOPE_CONTEXT_MAX_PATIENTS = 500;

/** The SFV statuses that are still an OPEN obligation (mirrors `OPEN_SFV_STATUSES` in ./providers). */
const OPEN_SFV_STATUSES = ["open", "overdue"] as const;

/** One patient's HOPE context (structural twin of M14's `PacketSnapshot["hopeContext"]`, non-null arm). */
export interface IdgHopeContext {
  readonly upcomingTimepoints: ReadonlyArray<{
    readonly timepoint: string;
    readonly dueAt: string;
  }>;
  readonly openSfvCount: number;
}

/**
 * HOPE context for each patient in `patientIds`. Every requested patient is present in the result (empty
 * context when nothing is open). TWO queries, never per patient.
 */
export async function idgHopeContextForOrg(
  db: DbClient,
  organizationId: string,
  patientIds: readonly string[],
): Promise<ReadonlyMap<string, IdgHopeContext>> {
  const ids = [...new Set(patientIds)];
  const out = new Map<string, IdgHopeContext>();
  if (ids.length === 0) return out;
  if (ids.length > IDG_HOPE_CONTEXT_MAX_PATIENTS) {
    throw new Error(
      `idgHopeContextForOrg: ${ids.length} patients exceeds the ${IDG_HOPE_CONTEXT_MAX_PATIENTS} cap`,
    );
  }
  return withOrgContext(db, { organizationId, userId: IDG_HOPE_SYSTEM_USER_ID }, async (tx) => {
    const t = tx as unknown as DbClient;
    const schedules = await t
      .select({
        patientId: SCHED.patientId,
        rfaKind: SCHED.rfaKind,
        windowClosesAt: SCHED.windowClosesAt,
      })
      .from(SCHED)
      .where(
        and(
          eq(SCHED.organizationId, organizationId),
          inArray(SCHED.patientId, ids),
          eq(SCHED.status, "open"),
          ne(SCHED.rfaKind, "04_sfv"),
        ),
      );
    const sfvs = await t
      .select({ patientId: SFV.patientId })
      .from(SFV)
      .where(
        and(
          eq(SFV.organizationId, organizationId),
          inArray(SFV.patientId, ids),
          inArray(SFV.status, [...OPEN_SFV_STATUSES]),
        ),
      );
    const timepoints = new Map<string, { timepoint: string; dueAt: string }[]>();
    for (const s of schedules) {
      const list = timepoints.get(s.patientId) ?? [];
      list.push({ timepoint: s.rfaKind, dueAt: new Date(s.windowClosesAt).toISOString() });
      timepoints.set(s.patientId, list);
    }
    const sfvCount = new Map<string, number>();
    for (const s of sfvs) sfvCount.set(s.patientId, (sfvCount.get(s.patientId) ?? 0) + 1);
    for (const id of ids) {
      const list = (timepoints.get(id) ?? []).sort((a, b) =>
        a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0,
      );
      out.set(id, { upcomingTimepoints: list, openSfvCount: sfvCount.get(id) ?? 0 });
    }
    return out;
  });
}
