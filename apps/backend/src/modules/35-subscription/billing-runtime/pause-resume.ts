// apps/backend/src/modules/35-subscription/billing-runtime/pause-resume.ts — the hourly PAUSE-RESUME sweep.
//
// An operator can pause a subscription with an end date (`paused_until`). Billing already treats a pause as over at that date (the live
// contract scope, the statement's pause windows, the org-lifecycle consumer's `lapsed` branch). This sweep makes the STORED status agree: a
// `paused` row whose date has passed goes back to `active`, so the row, the tenant's view, the usage aggregator and the claims-billing
// entitlement stop saying `paused` for a pause that ended. Those special cases stay: a sweep can be late, and billing must be right for the
// hours between the date and the next tick.
//
// WHAT IT WRITES is exactly what the operator's own resume writes (routes/resume-transition.ts: the columns, the ledger shape, the
// `m35.subscription.resumed` event), with two differences that are the point of it:
//   - the ledger row is DATED AT THE PAUSE'S OWN END DATE, not at the sweep's instant, so the statement's pause window (the earlier of the
//     date and the transition that closed it) does not move: a statement computed before the sweep and after it is the same statement;
//   - there is no operator. The ledger actor is NULL as always, and no PLATFORM audit row is written (it exists to name an operator); the
//     write is an org-scoped, RLS-checked transaction whose rows the write-audit trigger copies like any tenant-scoped write.
//
// WHO IT VISITS: the active-organization fan-out every other per-org M35 job uses (`listOrgs`, one audited platform call per sweep, then
// `withOrgContext` per org on the tenant pool: no new bypass). A suspended organization is not on that list, so its subscription is never
// resumed here: the sweep cannot resume billing for an org the platform has suspended. (A suspension pauses OPEN-ENDED, `paused_until` null,
// which never matches the lapse predicate either; this covers the other way round, an operator's dated pause that was running when the
// suspension arrived.)
//
// WHICH SUBSCRIPTION: the org's NEWEST one only (`ORDER BY started_at DESC LIMIT 1`, lockNewestSubscription), the row every other M35
// lifecycle path reads (the org-lifecycle consumer, the tenant routes). It is resumed only when that row is lapsed-paused. An older,
// superseded subscription is never a candidate: resuming it would put a row nobody reads back into billing behind the newest one, or under
// a newer subscription that was canceled.
//
// SAFE UNDER A RACE. That row is read `FOR UPDATE` and written with a guard (`id`, still `paused`, still lapsed): an operator's resume or
// cancel, or the org-lifecycle consumer's suspension, that got there first leaves zero rows to update and the sweep leaves the row alone,
// writing no ledger row and no event. The consumer and the tenant resume read the same row under the same lock, so whichever takes it first
// completes before the other judges the state it left: a sweep that ran first makes the consumer's suspension a plain one (no second lapse
// row); a consumer that ran first leaves an open-ended pause the sweep does not match.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, ne, notInArray } from "drizzle-orm";
import { isPauseLapsed, pauseLapsed } from "../pricing/contract-select";
import { PAUSE_LAPSED_REASON_CODE, lockNewestSubscription } from "../routes/admin-transition";
import { resumedColumns, resumedEventIntent, resumedLedgerRow } from "../routes/resume-transition";
import { type M35JobDeps, runM35Fanout } from "./jobs";

const S = schema.subscriptionRow;
const SH = schema.subscriptionStateHistory;

type SubRow = typeof S.$inferSelect;

/** `paused` with an end date that has passed at `now`: the ONE lapse predicate (contract-select.ts), plus the row's status. */
const lapsedPause = (now: Date) => and(eq(S.status, "paused"), pauseLapsed(now));

/**
 * Whether the org has an OLDER subscription that is live (`subscription_org_active_uq`: one per org that is neither canceled nor paused; the
 * newest can be paused beside an older live one when an operator resumed the older one). Resuming the newest then would violate that index
 * and fail the org's whole transaction every hour, so the pause is left as it is (and reported once).
 */
async function hasOtherLiveSubscription(tx: DbClient, sub: SubRow): Promise<boolean> {
  const [other] = await tx
    .select({ id: S.id })
    .from(S)
    .where(
      and(
        eq(S.organizationId, sub.organizationId),
        ne(S.id, sub.id),
        notInArray(S.status, ["canceled", "paused"]),
      ),
    )
    .limit(1);
  return other !== undefined;
}

/** Subscriptions whose blocked resume has been logged by this process: once per row, not every hour (a restart logs it again). */
const reportedBlocked = new Set<string>();

/**
 * Resume the org's lapsed operator pause, if its newest subscription is one, in ONE org-scoped transaction (a failure rolls all of it back
 * and the next hour retries: a transition never lacks its ledger row or its event). Returns how many it resumed (0 or 1). Idempotent: a
 * second run finds nothing. It acts on the org's NEWEST subscription only (lockNewestSubscription: the row every other M35 lifecycle path
 * reads), so an older, superseded pause is never a candidate: it cannot be resurrected behind the newest one, nor under a newer
 * subscription that was canceled.
 */
export async function runPauseResumeForOrg(
  deps: M35JobDeps,
  organizationId: string,
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const sub = await lockNewestSubscription(tx, organizationId);
    if (!sub || !isPauseLapsed(sub, now)) return 0;
    const endedAt = sub.pausedUntil;
    if (!endedAt) return 0; // isPauseLapsed implies a date; this narrows the type
    if (await hasOtherLiveSubscription(tx, sub)) {
      if (!reportedBlocked.has(sub.id)) {
        reportedBlocked.add(sub.id);
        deps.log?.(
          "m35 lapsed pause not resumed: an older subscription of the organization is live",
          {
            organizationId,
            subscriptionId: sub.id,
          },
        );
      }
      return 0;
    }
    const done = await tx
      .update(S)
      .set(resumedColumns(now))
      .where(and(eq(S.id, sub.id), lapsedPause(now)))
      .returning({ id: S.id });
    if (done.length === 0) return 0; // another writer moved it first: leave it exactly where they left it
    await tx
      .insert(SH)
      .values(
        resumedLedgerRow(sub, { transitionedAt: endedAt, reasonCode: PAUSE_LAPSED_REASON_CODE }),
      );
    await deps.outbox.publish(tx, resumedEventIntent(sub, endedAt));
    return 1;
  });
}

/** The hourly sweep: every active org, each isolated from the others (one org's failure is logged with its id and fails the job at the end). */
export const runPauseResumeSweep = (deps: M35JobDeps): Promise<void> =>
  runM35Fanout(
    deps,
    async (organizationId) => void (await runPauseResumeForOrg(deps, organizationId)),
    "pause_resume",
  );
