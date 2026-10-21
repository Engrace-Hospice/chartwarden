// apps/backend/src/modules/40-mdm/jobs/provisional-aging.ts — M40 §4.3 `mdm.provisional_aging_scan` cron body
// (GAP-173): weekly, provisional rows pending > 14 days → escalate to platform-ops. The pure grouping lives in
// `@chartwarden/mdm` (`planProvisionalAging`); this reads each org's `pending` provisionals under RLS and sends ONE
// digest notice per org through the org-less platform-ops path (`./platform-ops.ts`) — platform-ops is not a
// tenant, so this deliberately does not use the tenant-scoped AlertEmitter. Re-escalates weekly while a row stays
// pending (that is the point of an escalation), with a week-bucketed correlation id.
import { type DbClient, schema } from "@chartwarden/db";
import { type ProvisionalRow, planProvisionalAging } from "@chartwarden/mdm";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import type { M40ActiveOrgPort } from "../outbox-consumers/nppes-consumer-ports";
import { type PlatformOpsDeps, notifyPlatformOps } from "./platform-ops";

const PROV = schema.mdmProvisional;
const M40_WORKER_SYSTEM_USER_ID = "";
const MS_PER_WEEK = 7 * 86_400_000;

export interface ProvisionalAgingDeps extends PlatformOpsDeps {
  readonly orgs: M40ActiveOrgPort;
  readonly now?: () => Date;
}

async function loadPending(
  db: DbClient,
  organizationId: string,
): Promise<readonly ProvisionalRow[]> {
  return withOrgContext(
    db,
    { organizationId, userId: M40_WORKER_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const rows = await tx
        .select({ id: PROV.id, entityKind: PROV.entityKind, createdAt: PROV.createdAt })
        .from(PROV)
        .where(and(eq(PROV.organizationId, organizationId), eq(PROV.resolution, "pending")));
      return rows.map((r) => ({ ...r, organizationId }));
    },
  );
}

/** `mdm.provisional_aging_scan` for ONE org. Returns true when a notice was sent. */
export async function runProvisionalAgingForOrg(
  deps: ProvisionalAgingDeps,
  organizationId: string,
): Promise<boolean> {
  const now = (deps.now ?? (() => new Date()))();
  const plan = planProvisionalAging(
    organizationId,
    await loadPending(deps.db, organizationId),
    now,
  );
  if (plan === null) return false;
  await notifyPlatformOps(deps, {
    kind: "mdm.provisional_aged",
    summary: `${plan.agedCount} provisional MDM entit${plan.agedCount === 1 ? "y has" : "ies have"} been pending > 14 days for org ${organizationId} (oldest ${plan.oldestAgeDays}d)`,
    details: {
      organizationId,
      agedCount: plan.agedCount,
      oldestAgeDays: plan.oldestAgeDays,
      byKind: plan.byKind,
      sampleIds: plan.sampleIds,
    },
    correlationId: `m40-provisional-aged:${organizationId}:${Math.floor(now.getTime() / MS_PER_WEEK)}`,
  });
  return true;
}

/** `mdm.provisional_aging_scan` across every active org; returns how many orgs were escalated. */
export async function runProvisionalAgingScan(deps: ProvisionalAgingDeps): Promise<number> {
  const orgs = await deps.orgs.listActiveOrgs();
  let escalated = 0;
  const errors: unknown[] = [];
  for (const { organizationId } of orgs) {
    try {
      if (await runProvisionalAgingForOrg(deps, organizationId)) escalated += 1;
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `M40 provisional aging scan failed for ${errors.length} org(s)`,
    );
  }
  return escalated;
}
