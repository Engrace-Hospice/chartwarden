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
import { and, eq, gte, lt } from "drizzle-orm";

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
  };
}
