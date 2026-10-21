// apps/backend/src/modules/40-mdm/jobs/license-scan.ts — M40 §4.3 `mdm.license_expiration_scan` cron body
// (GAP-173). The pure planner (`planLicenseExpiryAlerts`, @chartwarden/mdm) decides which 90/30/0-day alerts are due
// over the Phase-1 manual entries in `mdm_license_record`; this is the I/O shell, shaped exactly like the BAA scan
// (`./baa-scan.ts`): org-explicit RLS-scoped read per org, alerts through the M36 AlertEmitter (idempotent on
// `(org, correlationId)`), one org's failure never blocks the rest and every failure is re-thrown afterwards.
// Payload follows spec §4.4 `mdm.license_expiring`: `{ physicianId, state, daysUntilExpiry }` (+ kind/id/window
// so a non-physician entity is identifiable).
import { type DbClient, schema } from "@chartwarden/db";
import {
  BAA_SCAN_LOOKAHEAD_DAYS,
  type LicenseScanRecord,
  planLicenseExpiryAlerts,
} from "@chartwarden/mdm";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, lte } from "drizzle-orm";
import type { M40ActiveOrgPort, M40AlertPort } from "../outbox-consumers/nppes-consumer-ports";

const LIC = schema.mdmLicenseRecords;
const M40_WORKER_SYSTEM_USER_ID = "";
const MS_PER_DAY = 86_400_000;

export interface LicenseScanDeps {
  readonly db: DbClient;
  readonly alerts: M40AlertPort;
  readonly orgs: M40ActiveOrgPort;
  readonly now?: () => Date;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

async function loadScannableLicenses(
  db: DbClient,
  organizationId: string,
  today: Date,
): Promise<readonly LicenseScanRecord[]> {
  const horizon = isoDate(new Date(today.getTime() + BAA_SCAN_LOOKAHEAD_DAYS * MS_PER_DAY));
  return withOrgContext(
    db,
    { organizationId, userId: M40_WORKER_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const rows = await tx
        .select({
          id: LIC.id,
          entityKind: LIC.entityKind,
          canonicalId: LIC.canonicalId,
          licenseState: LIC.licenseState,
          expiresOn: LIC.expiresOn,
        })
        .from(LIC)
        .where(and(eq(LIC.organizationId, organizationId), lte(LIC.expiresOn, horizon)));
      return rows.map((r) => ({ ...r, organizationId }));
    },
  );
}

/** `mdm.license_expiration_scan` for ONE org. Returns how many alerts were emitted. */
export async function runLicenseExpirationScanForOrg(
  deps: LicenseScanDeps,
  organizationId: string,
): Promise<number> {
  const today = (deps.now ?? (() => new Date()))();
  const records = await loadScannableLicenses(deps.db, organizationId, today);
  const plans = planLicenseExpiryAlerts(records, isoDate(today));
  for (const plan of plans) {
    await deps.alerts.emit(organizationId, {
      eventType: "mdm.license_expiring",
      payload: {
        physicianId: plan.entityKind === "physician" ? plan.canonicalId : null,
        entityKind: plan.entityKind,
        canonicalId: plan.canonicalId,
        state: plan.licenseState,
        daysUntilExpiry: plan.daysUntilExpiry,
        window: plan.window,
        expiresOn: plan.expiresOn,
      },
      severity: plan.severity,
      correlationId: plan.correlationId,
    });
  }
  return plans.length;
}

/** `mdm.license_expiration_scan` across every active org. */
export async function runLicenseExpirationScan(deps: LicenseScanDeps): Promise<number> {
  const orgs = await deps.orgs.listActiveOrgs();
  let emitted = 0;
  const errors: unknown[] = [];
  for (const { organizationId } of orgs) {
    try {
      emitted += await runLicenseExpirationScanForOrg(deps, organizationId);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `M40 license expiration scan failed for ${errors.length} org(s)`,
    );
  }
  return emitted;
}
