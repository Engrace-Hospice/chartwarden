// apps/backend/src/modules/26-cap/consumers/inpatient-reconcile.ts - GAP-038. `cap_inpatient_accrual` is a
// CACHE of `cap_inpatient_day_line`: the ledger (rows not yet reversed) is the source of truth, the roll-up is
// rebuilt from it. This is what heals rows written before the denominator fix (`gip_days > 0` with
// `total_patient_days = 0`, which no event replay can repair because the replayed ledger insert is a conflict
// and increments nothing) and any later drift. It publishes nothing and is idempotent.
import { type DbClient, schema } from "@chartwarden/db";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const IA = schema.capInpatientAccrual;
const IDL = schema.capInpatientDayLine;

/** rev_code '0655' = IRC, '0656' = GIP (numerator); every code's days are the denominator. */
const GIP_REV_CODE = "0656";
const IRC_REV_CODE = "0655";

/**
 * Rebuild the (org, period) inpatient roll-up from the live ledger rows, inside the caller's tenant tx.
 * A roll-up row is created only when the period has ledger lines (or already has a roll-up row, so a period
 * whose every line was reversed drops to zero); a period with neither is left without a row.
 */
export async function reconcileInpatientAccrual(
  tx: Tx,
  organizationId: string,
  capPeriodId: string,
): Promise<void> {
  await tx.execute(sql`
    WITH agg AS (
      SELECT count(*)::int AS n,
             coalesce(sum(${IDL.days}) FILTER (WHERE ${IDL.revCode} = ${GIP_REV_CODE}), 0)::int AS gip,
             coalesce(sum(${IDL.days}) FILTER (WHERE ${IDL.revCode} = ${IRC_REV_CODE}), 0)::int AS irc,
             coalesce(sum(${IDL.days}), 0)::int AS total
        FROM ${IDL}
       WHERE ${IDL.organizationId} = ${organizationId}
         AND ${IDL.capPeriodId} = ${capPeriodId}
         AND ${IDL.reversedAt} IS NULL
    )
    INSERT INTO ${IA} (organization_id, cap_period_id, gip_days, irc_days, total_patient_days, last_updated_at)
    SELECT ${organizationId}::uuid, ${capPeriodId}::uuid, agg.gip, agg.irc, agg.total, now()
      FROM agg
     WHERE agg.n > 0
        OR EXISTS (SELECT 1 FROM ${IA}
                    WHERE ${IA.organizationId} = ${organizationId}
                      AND ${IA.capPeriodId} = ${capPeriodId})
    ON CONFLICT (organization_id, cap_period_id) DO UPDATE
       SET gip_days = EXCLUDED.gip_days,
           irc_days = EXCLUDED.irc_days,
           total_patient_days = EXCLUDED.total_patient_days,
           last_updated_at = now()
  `);
}
