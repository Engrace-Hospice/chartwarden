// apps/backend/src/modules/40-mdm/jobs/baa-scan.ts — M40 §4.3 `mdm.baa_expiration_scan` cron body (GAP-173).
//
// The pure planner (`planBaaExpiryAlerts`, @chartwarden/mdm) decides which 90/30/0-day alerts are due; this file is
// the I/O shell. Until it existed nothing ever read `mdm_baa_record.expires_on`, so a facility/payer BAA could
// lapse (and the §7.7 gate start denying disclosure to it) with nobody having been warned.
//
// RELAY/CRON TICKS ARE NOT REQUESTS: org-explicit, one RLS-scoped `withOrgContext` read per org, the fan-out
// over orgs is the caller's audited active-org enumerator. Idempotent by construction — every plan carries a
// `(record, window)` correlation id and the M36 AlertEmitter dedups on `(org, correlationId)`, so the daily
// scan re-raises nothing until a record crosses into a more urgent window.
import { type DbClient, schema } from "@chartwarden/db";
import { BAA_SCAN_LOOKAHEAD_DAYS, type BaaScanRecord, planBaaExpiryAlerts } from "@chartwarden/mdm";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { M40ActiveOrgPort, M40AlertPort } from "../outbox-consumers/nppes-consumer-ports";

const BAA = schema.mdmBaaRecords;

/** Empty, not a UUID: reads back as SQL NULL, which the audit trigger's actor FK accepts (M39/M20 precedent). */
const M40_WORKER_SYSTEM_USER_ID = "";
const MS_PER_DAY = 86_400_000;

export interface BaaScanDeps {
  readonly db: DbClient;
  readonly alerts: M40AlertPort;
  readonly orgs: M40ActiveOrgPort;
  readonly now?: () => Date;
}

export interface BaaScanSummary {
  readonly orgsScanned: number;
  readonly alertsEmitted: number;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** The executed BAAs of ONE org that expire within the scan horizon (or already have). */
async function loadScannableBaas(
  db: DbClient,
  organizationId: string,
  today: Date,
): Promise<readonly BaaScanRecord[]> {
  const horizon = isoDate(new Date(today.getTime() + BAA_SCAN_LOOKAHEAD_DAYS * MS_PER_DAY));
  return withOrgContext(
    db,
    { organizationId, userId: M40_WORKER_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const rows = await tx
        .select({
          id: BAA.id,
          entityKind: BAA.entityKind,
          canonicalId: BAA.canonicalId,
          baaStatus: BAA.baaStatus,
          expiresOn: BAA.expiresOn,
        })
        .from(BAA)
        .where(
          and(
            eq(BAA.organizationId, organizationId),
            eq(BAA.baaStatus, "executed"),
            isNotNull(BAA.expiresOn),
            lte(BAA.expiresOn, horizon),
          ),
        );
      return rows.map((r) => ({
        id: r.id,
        organizationId,
        entityKind: r.entityKind,
        canonicalId: r.canonicalId,
        baaStatus: r.baaStatus as BaaScanRecord["baaStatus"],
        expiresOn: r.expiresOn,
      }));
    },
  );
}

/** `mdm.baa_expiration_scan` for ONE org. Returns how many alerts were emitted. */
export async function runBaaExpirationScanForOrg(
  deps: BaaScanDeps,
  organizationId: string,
): Promise<number> {
  const today = (deps.now ?? (() => new Date()))();
  const records = await loadScannableBaas(deps.db, organizationId, today);
  const plans = planBaaExpiryAlerts(records, isoDate(today));
  for (const plan of plans) {
    await deps.alerts.emit(organizationId, {
      eventType: "mdm.baa_expiring",
      payload: {
        baaRecordId: plan.baaRecordId,
        entityKind: plan.entityKind,
        canonicalId: plan.canonicalId,
        window: plan.window,
        daysRemaining: plan.daysRemaining,
        expiresOn: plan.expiresOn,
      },
      severity: plan.severity,
      correlationId: plan.correlationId,
    });
  }
  return plans.length;
}

/** `mdm.baa_expiration_scan` across every active org; one org's failure never blocks the rest, and every
 *  failure is re-thrown together afterwards (BullMQ retries / DLQ alert) — never swallowed. */
export async function runBaaExpirationScan(deps: BaaScanDeps): Promise<BaaScanSummary> {
  const orgs = await deps.orgs.listActiveOrgs();
  let alertsEmitted = 0;
  const errors: unknown[] = [];
  for (const { organizationId } of orgs) {
    try {
      alertsEmitted += await runBaaExpirationScanForOrg(deps, organizationId);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `M40 BAA expiration scan failed for ${errors.length} org(s)`);
  }
  return { orgsScanned: orgs.length, alertsEmitted };
}
