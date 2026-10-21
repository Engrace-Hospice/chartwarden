// apps/backend/src/modules/26-cap/consumers/backfill-ports.ts - GAP-038. The M26 half of the platform-ops cap-day
// backfill (`scripts/backfill-line-finalized.ts`): which cap years a tenant has opened tracking for, so the
// replay emits only for those and REPORTS the rest instead of silently dropping them. A cap year with no
// `cap_period` is a product act (open the period, then re-run); a settled/closed period is not rewritten by a
// backfill (a past year's roll-up must not move under a filed cost report), so it is reported too.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";

const P = schema.capPeriod;

/** Statuses whose roll-up may still move (the nightly projection's own `listOpenPeriods` set). */
const BACKFILLABLE_STATUSES: ReadonlySet<string> = new Set(["open", "active", "reopened"]);

/** The cap years of one org, split by whether a backfill may write into them. */
export interface CapYearsForBackfill {
  /** Years with an open / active / reopened `cap_period`: the backfill writes these. */
  readonly backfillable: ReadonlySet<string>;
  /** Years with a `cap_period` that is closed / settled: reported, never rewritten. */
  readonly sealed: ReadonlyMap<string, string>;
}

export interface CapBackfillPorts {
  capYearsForBackfill(organizationId: string): Promise<CapYearsForBackfill>;
}

export function createCapBackfillPorts(db: DbClient, systemUserId: string): CapBackfillPorts {
  return {
    async capYearsForBackfill(organizationId) {
      const rows = await withOrgContext(db, { organizationId, userId: systemUserId }, (tx) =>
        tx
          .select({ capYear: P.capYear, status: P.status })
          .from(P)
          .where(eq(P.organizationId, organizationId)),
      );
      const backfillable = new Set<string>();
      const sealed = new Map<string, string>();
      for (const row of rows) {
        if (BACKFILLABLE_STATUSES.has(row.status)) backfillable.add(row.capYear);
        else sealed.set(row.capYear, row.status);
      }
      return { backfillable, sealed };
    },
  };
}
