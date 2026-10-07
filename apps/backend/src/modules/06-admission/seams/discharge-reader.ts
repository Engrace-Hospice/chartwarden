// apps/backend/src/modules/06-admission/seams/discharge-reader.ts — the DEDICATED Drizzle reader backing
// M6's `DischargeReader` seam (M30 HCI indicators 3/4: Early / Late Live Discharges). Mirrors
// `death-discharge-reader.ts`'s shape exactly, but reads ALL discharge types (not just `dischargeType=
// 'death'`) — the denominator for HCI 3/4 is every discharge in the window, live or death.
//
// CMS criterion: among LIVE discharges (`dischargeType !== 'death'`), one is "early" when it falls on or
// before day 7 since admission (indicator 3; matches the FY2025 threshold label in
// `HCI_THRESHOLDS_v2025.indicators.indicator_03`, "early (≤ day-7) live-discharge rate") and "late" when it
// falls on or after day 180 since admission (indicator 4). The day-180 cutoff is NOT pinned anywhere else
// in this codebase — it is the platform's own reading of the CMS HCI technical specification's long-stay
// live-discharge definition, flagged here (not silently invented) the same way M7's 15-day grace-period
// interpretation and M14's cadence interpretation are flagged elsewhere in this module family. Revisit if
// a future CMS technical-spec refresh publishes a different cutoff.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DischargeReader } from "@wardenx/types";
import { and, eq, gte, inArray, lt } from "drizzle-orm";

const DE = schema.dischargeEvents;
const ADM = schema.admissions;

/** Same empty-acting-user sentinel {@link createDeathDischargeReader} uses for an aggregate census read. */
const SYSTEM_USER_ID = "";

/** CMS HCI indicator 3 — a live discharge on or before this many days since admission is "early". */
const EARLY_LIVE_DISCHARGE_DAY_CUTOFF = 7;

/** CMS HCI indicator 4 — a live discharge on or after this many days since admission is "late" (flagged
 *  interpretation — see this file's header comment; not independently pinned elsewhere in the codebase). */
const LATE_LIVE_DISCHARGE_DAY_CUTOFF = 180;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** SSVI metric 5 (CMS-1851-F Table 9) — "length of stay over 180 days": strictly more than this many days. */
const SSVI_LONG_STAY_DAYS = 180;

/** SSVI metric 8 — a live discharge "returns to the same hospice in seven days": readmitted within this many days. */
const SSVI_READMIT_WINDOW_DAYS = 7;

/** `yyyy-mm-dd` + n days. */
function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole days between an admission timestamp and a discharge `date` (yyyy-mm-dd) column value. */
function daysSinceAdmission(admissionAt: Date, effectiveAt: string): number {
  const dischargeDate = new Date(`${effectiveAt}T00:00:00.000Z`);
  const admissionDate = new Date(
    Date.UTC(admissionAt.getUTCFullYear(), admissionAt.getUTCMonth(), admissionAt.getUTCDate()),
  );
  return Math.round((dischargeDate.getTime() - admissionDate.getTime()) / MS_PER_DAY);
}

/**
 * The production {@link DischargeReader} over M6's `discharge_event` / `admission` tables. Closes over the
 * pooled `DbClient`; each call opens its OWN per-org `withOrgContext` envelope with a belt-and-suspenders
 * `organization_id = $org` predicate (mirrors `createDeathDischargeReader`).
 */
export function createDischargeReader(db: DbClient): DischargeReader {
  return {
    liveDischargeTimingCounts(organizationId, period) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
        const rows = await (tx as unknown as DbClient)
          .select({
            dischargeType: DE.dischargeType,
            effectiveAt: DE.effectiveAt,
            admissionAt: ADM.admissionAt,
          })
          .from(DE)
          .innerJoin(ADM, eq(DE.admissionId, ADM.id))
          .where(
            and(
              eq(DE.organizationId, organizationId),
              gte(DE.effectiveAt, period.from),
              lt(DE.effectiveAt, period.to),
            ),
          );

        let earlyLiveDischarges = 0;
        let lateLiveDischarges = 0;
        for (const r of rows) {
          if (r.dischargeType === "death") continue;
          // A discharge with no recorded admission timestamp cannot be day-classified — excluded from
          // BOTH early/late counts (never guessed), but still counted in `totalDischarges` below.
          if (r.admissionAt === null) continue;
          const days = daysSinceAdmission(r.admissionAt, r.effectiveAt);
          if (days <= EARLY_LIVE_DISCHARGE_DAY_CUTOFF) earlyLiveDischarges += 1;
          else if (days >= LATE_LIVE_DISCHARGE_DAY_CUTOFF) lateLiveDischarges += 1;
        }
        return { totalDischarges: rows.length, earlyLiveDischarges, lateLiveDischarges };
      });
    },

    ssviDischargeCounts(organizationId, period) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
        const client = tx as unknown as DbClient;
        const rows = await client
          .select({
            admissionId: DE.admissionId,
            dischargeType: DE.dischargeType,
            effectiveAt: DE.effectiveAt,
            admissionAt: ADM.admissionAt,
            patientId: ADM.patientId,
          })
          .from(DE)
          .innerJoin(ADM, eq(DE.admissionId, ADM.id))
          .where(
            and(
              eq(DE.organizationId, organizationId),
              gte(DE.effectiveAt, period.from),
              lt(DE.effectiveAt, period.to),
            ),
          );

        const live = rows.filter((r) => r.dischargeType !== "death");
        let dischargesWithLosOver180 = 0;
        for (const r of rows) {
          if (r.admissionAt === null) continue; // never guessed — see liveDischargeTimingCounts
          if (daysSinceAdmission(r.admissionAt, r.effectiveAt) > SSVI_LONG_STAY_DAYS)
            dischargesWithLosOver180 += 1;
        }

        // Readmissions: the same patient's OTHER admissions to this org, admitted on or after the discharge
        // date and no more than 7 days later. One bounded read for every live-discharged patient.
        let liveDischargesReadmittedWithin7Days = 0;
        const patientIds = [...new Set(live.map((r) => r.patientId))];
        if (patientIds.length > 0) {
          const later = await client
            .select({ id: ADM.id, patientId: ADM.patientId, admissionAt: ADM.admissionAt })
            .from(ADM)
            .where(and(eq(ADM.organizationId, organizationId), inArray(ADM.patientId, patientIds)));
          for (const d of live) {
            const windowEnd = addDays(d.effectiveAt, SSVI_READMIT_WINDOW_DAYS);
            const readmitted = later.some((a) => {
              if (a.id === d.admissionId || a.patientId !== d.patientId || a.admissionAt === null)
                return false;
              const day = a.admissionAt.toISOString().slice(0, 10);
              return day >= d.effectiveAt && day <= windowEnd;
            });
            if (readmitted) liveDischargesReadmittedWithin7Days += 1;
          }
        }

        return {
          totalDischarges: rows.length,
          liveDischarges: live.length,
          dischargesWithLosOver180,
          liveDischargesReadmittedWithin7Days,
        };
      });
    },
  };
}
