// apps/backend/src/modules/24-billing-medicaid/jobs/rb-day-lifecycle.ts — GAP-071 follow-up: the two rb_day
// lifecycle writes the §2.2 diagram and §4.4 consumers (`m6-loc-changed.consumer.ts`,
// `m5-patient-deceased.consumer.ts`) call for, beyond the daily sweep's creation.
//   - re-evaluation: an `m6.loc.changed` (or a retroactive LOC correction) re-derives every not-yet-billed day
//     from the changed date forward with the SAME pure rules the sweep uses (`deriveRbDays`), updating
//     loc_of_day / loc_period_id_snapshot / per_diem / status / reason in place;
//   - void: a death or discharge voids the patient's not-yet-billed days after the end of care ("voided —
//     terminal; set when the underlying patient day is voided in M5 deceased / discharge correction").
// SCOPE (stated, not silent): only unannotated `pending`/`billable` days and `excluded` days carrying a SYSTEM
// reason are re-evaluated; any retained operator reason is terminal-until-corrected, including an override to
// `billable`. A `billed` day is left alone — it is attached to a claim line, and un-billing it is the claim
// void/replace path (§2.2), not this one. A `voided` day is never touched, so the sweep (which skips any date
// holding a row) never regenerates it. Every read/write is under `withOrgContext` with the tenant from the
// dispatcher envelope.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { DegradedError } from "@chartwarden/types";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
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

/** System-managed days may be re-derived; a retained operator reason marks an explicit override. */
export function shouldReevaluateRbDay(
  day: Pick<typeof RD.$inferSelect, "status" | "exclusionReason">,
): boolean {
  if (day.exclusionReason !== null && !RB_SYSTEM_EXCLUSION_REASONS.has(day.exclusionReason)) {
    return false;
  }
  if (day.status === "excluded") {
    return day.exclusionReason !== null && RB_SYSTEM_EXCLUSION_REASONS.has(day.exclusionReason);
  }
  return day.status === "pending" || day.status === "billable";
}

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
  return withOrgContext(deps.db, ctx, async (tx) => {
    if (!deps.locPeriods.periodsForPatientInTransaction) {
      throw new DegradedError(
        "M24_RB_LOC_TRANSACTION_READER_UNBOUND",
        "R&B day reconciliation requires M6's admission-locked LOC snapshot on the same transaction",
      );
    }

    // Find the candidate window without taking M24 locks. The transaction-bound LOC reader acquires the
    // M6 admission locks itself; run it before arrangement/day locks to keep the global order:
    // admissions -> LOC snapshot -> M24 arrangements -> M24 day rows.
    const candidates = await tx
      .select({
        id: RD.id,
        serviceDate: RD.serviceDate,
        status: RD.status,
        exclusionReason: RD.exclusionReason,
      })
      .from(RD)
      .where(
        and(
          eq(RD.organizationId, organizationId),
          eq(RD.patientId, patientId),
          gte(RD.serviceDate, from),
          inArray(RD.status, [...OPEN_STATUSES]),
        ),
      )
      .orderBy(asc(RD.serviceDate), asc(RD.id));
    const candidateDays = candidates.filter(shouldReevaluateRbDay);
    const candidateIds = candidateDays.map((d) => d.id);
    if (candidateIds.length === 0) return 0;

    const candidateLast = Math.max(...candidateDays.map((d) => utcDayStart(d.serviceDate)));
    const periods = await deps.locPeriods.periodsForPatientInTransaction(
      tx,
      organizationId,
      patientId,
      { from, to: new Date(candidateLast + MS_PER_DAY - 1) },
    );

    const arrangements = await tx
      .select()
      .from(RB)
      .where(and(eq(RB.organizationId, organizationId), eq(RB.patientId, patientId)))
      .orderBy(asc(RB.id))
      .for("update");
    const arrangementById = new Map(arrangements.map((a) => [a.id, a]));
    const days = await tx
      .select()
      .from(RD)
      .where(
        and(
          eq(RD.organizationId, organizationId),
          eq(RD.patientId, patientId),
          gte(RD.serviceDate, from),
          inArray(RD.status, [...OPEN_STATUSES]),
          inArray(RD.id, candidateIds),
        ),
      )
      .orderBy(asc(RD.serviceDate), asc(RD.id))
      .for("update");
    const evaluable = days.filter(shouldReevaluateRbDay);
    if (evaluable.length === 0) return 0;

    const last = Math.max(...evaluable.map((d) => utcDayStart(d.serviceDate)));
    // Service dates are immutable. Keep an explicit guard in case a future writer violates that contract:
    // never apply a LOC snapshot whose range predates the locked rows being reconciled.
    if (last > candidateLast) {
      throw new DegradedError(
        "M24_RB_LOC_SNAPSHOT_STALE",
        "R&B day reconciliation candidate range changed; retry the reconciliation",
      );
    }
    let changed = 0;
    for (const day of evaluable) {
      const arrangement = arrangementById.get(day.rbArrangementId);
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
      const updated = await tx
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
        // Re-assert the optimistic version and open-status guards despite holding the row lock; a mismatched
        // row is an explicit concurrent ownership conflict rather than a successful re-evaluation.
        .where(
          and(
            eq(RD.id, day.id),
            eq(RD.version, day.version),
            inArray(RD.status, [...OPEN_STATUSES]),
          ),
        )
        .returning({ id: RD.id });
      if (updated.length === 1) changed += 1;
    }
    return changed;
  });
}
