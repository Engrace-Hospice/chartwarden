// apps/backend/src/modules/24-billing-medicaid/jobs/rb-day-lifecycle.ts — GAP-071 follow-up: the two rb_day
// lifecycle writes the §2.2 diagram and §4.4 consumers (`m6-loc-changed.consumer.ts`,
// `m5-patient-deceased.consumer.ts`) call for, beyond the daily sweep's creation.
//   - re-evaluation: an `m6.loc.changed` (or a retroactive LOC correction) re-derives every not-yet-billed day
//     from the changed date forward with the SAME pure rules the sweep uses (`deriveRbDays`), updating
//     loc_of_day / loc_period_id_snapshot / per_diem / status / reason in place;
//   - void: a death or discharge voids the patient's not-yet-billed days after the end of care ("voided —
//     terminal; set when the underlying patient day is voided in M5 deceased / discharge correction").
// SCOPE (stated, not silent): only `pending`/`billable` days and `excluded` days carrying a SYSTEM reason are
// re-evaluated (an override reason is terminal-until-corrected); a `billed` day is left alone — it is
// attached to a claim line, and un-billing it is the claim void/replace path (§2.2), not this one. A
// `voided` day is never touched, so the sweep (which skips any date holding a row) never regenerates it.
// Every read/write is under `withOrgContext` with the tenant from the dispatcher envelope.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  MS_PER_DAY,
  RB_SYSTEM_EXCLUSION_REASONS,
  type RbLocPeriodsPort,
  deriveRbDays,
  utcDayStart,
} from "./rb-day-sweep";

const RB = schema.rbArrangement;
const RD = schema.rbDay;
const SYSTEM_USER_ID = "";
const OPEN_STATUSES = ["pending", "billable", "excluded"] as const;

const dayMs = (isoDate: string): number => {
  const ms = Date.parse(`${isoDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`rb_day lifecycle: invalid date "${isoDate}"`);
  return ms;
};

/** Void the patient's not-yet-billed days with service_date >= `fromDate` (yyyy-mm-dd). Returns rows voided. */
export async function voidRbDaysFrom(
  db: DbClient,
  organizationId: string,
  patientId: string,
  fromDate: string,
): Promise<number> {
  const from = new Date(dayMs(fromDate));
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await tx
      .update(RD)
      .set({ status: "voided", version: sql`${RD.version} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(RD.organizationId, organizationId),
          eq(RD.patientId, patientId),
          gte(RD.serviceDate, from),
          inArray(RD.status, [...OPEN_STATUSES]),
        ),
      )
      .returning({ id: RD.id });
    return rows.length;
  });
}

/** Re-derive the patient's not-yet-billed days with service_date >= `fromDate`. Returns rows changed. */
export async function reevaluateRbDaysFrom(
  deps: { readonly db: DbClient; readonly locPeriods: RbLocPeriodsPort },
  organizationId: string,
  patientId: string,
  fromDate: string,
): Promise<number> {
  const ctx = { organizationId, userId: SYSTEM_USER_ID };
  const from = new Date(dayMs(fromDate));
  const open = await withOrgContext(deps.db, ctx, async (tx) => {
    const days = await tx
      .select()
      .from(RD)
      .where(
        and(
          eq(RD.organizationId, organizationId),
          eq(RD.patientId, patientId),
          gte(RD.serviceDate, from),
          inArray(RD.status, [...OPEN_STATUSES]),
        ),
      );
    const evaluable = days.filter(
      (d) =>
        d.status !== "excluded" ||
        (d.exclusionReason !== null && RB_SYSTEM_EXCLUSION_REASONS.has(d.exclusionReason)),
    );
    const arrangementIds = [...new Set(evaluable.map((d) => d.rbArrangementId))];
    const arrangements =
      arrangementIds.length === 0
        ? []
        : await tx.select().from(RB).where(inArray(RB.id, arrangementIds));
    return { evaluable, arrangements: new Map(arrangements.map((a) => [a.id, a])) };
  });
  if (open.evaluable.length === 0) return 0;

  const last = Math.max(...open.evaluable.map((d) => utcDayStart(d.serviceDate)));
  const periods = await deps.locPeriods.periodsForPatient(organizationId, patientId, {
    from,
    to: new Date(last + MS_PER_DAY - 1),
  });

  return withOrgContext(deps.db, ctx, async (tx) => {
    let changed = 0;
    for (const day of open.evaluable) {
      const arrangement = open.arrangements.get(day.rbArrangementId);
      if (!arrangement) continue;
      const dayStart = utcDayStart(day.serviceDate);
      const [next] = deriveRbDays({
        arrangement,
        periods,
        fromDay: dayStart,
        toDay: dayStart,
        existingDays: new Set(),
      });
      // No covering LOC period any more: leave the day as-is rather than fabricate or silently drop it.
      if (!next) continue;
      const same =
        next.status === day.status &&
        next.locOfDay === day.locOfDay &&
        next.locPeriodIdSnapshot === day.locPeriodIdSnapshot &&
        next.perDiemCentsSnapshot === day.perDiemCentsSnapshot &&
        next.exclusionReason === day.exclusionReason;
      if (same) continue;
      await tx
        .update(RD)
        .set({
          status: next.status,
          locOfDay: next.locOfDay,
          locPeriodIdSnapshot: next.locPeriodIdSnapshot,
          perDiemCentsSnapshot: next.perDiemCentsSnapshot,
          exclusionReason: next.exclusionReason,
          version: sql`${RD.version} + 1`,
          updatedAt: new Date(),
        })
        // Re-assert the open-status guard so a day billed between the read and this write is never flipped.
        .where(and(eq(RD.id, day.id), inArray(RD.status, [...OPEN_STATUSES])));
      changed += 1;
    }
    return changed;
  });
}
