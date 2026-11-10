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
// SAFE UNDER A RACE. That row is read plainly, and only a lapsed pause is then read `FOR UPDATE` (and judged again) and written with a guard
// (`id`, still `paused`, still lapsed): an operator's resume or cancel, or the org-lifecycle consumer's suspension, that got there first
// leaves zero rows to update and the sweep leaves the row alone, writing no ledger row and no event. The consumer and the tenant resume read
// the same row under the same lock, so whichever takes it first completes before the other judges the state it left: a sweep that ran
// first makes the consumer's suspension a plain one (no second lapse row); a consumer that ran first leaves an open-ended pause the sweep
// does not match.
//
// BLOCKED. The newest pause cannot be resumed while an OLDER subscription of the organization is live (one live per organization). It then
// stays `paused`, so it is reported to operators (log and `onPauseBlocked`, the ops alert sink) once a day per subscription until an
// operator cancels or pauses the older one; the next tick resumes it. The two resume routes refuse the same state with a typed 409.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { isPauseLapsed, pauseLapsed } from "../pricing/contract-select";
import { PAUSE_LAPSED_REASON_CODE } from "../routes/admin-transition";
import {
  findOtherLiveSubscriptionId,
  lockNewestSubscription,
  selectNewestSubscription,
} from "../routes/current-subscription";
import { resumedColumns, resumedEventIntent, resumedLedgerRow } from "../routes/resume-transition";
import { type M35JobDeps, runM35Fanout } from "./jobs";

const S = schema.subscriptionRow;
const SH = schema.subscriptionStateHistory;

/** How long a lapsed pause's row lock may be waited for before that org's run fails (it retries next hour; the other orgs continue). */
const LOCK_TIMEOUT_MS = 5_000;
/** A blocked pause is reported to operators again after this long (not every hour). */
const BLOCKED_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PauseResumeDeps extends M35JobDeps {
  /** Overrides the row-lock wait (LOCK_TIMEOUT_MS): tests only. */
  readonly lockTimeoutMs?: number;
}

/** `paused` with an end date that has passed at `now`: the ONE lapse predicate (contract-select.ts), plus the row's status. */
const lapsedPause = (now: Date) => and(eq(S.status, "paused"), pauseLapsed(now));

/**
 * The blocked pauses this process has reported, by subscription id: reported again only after a day, and forgotten as soon as the
 * subscription is no longer blocked (resumed, moved by another writer, no longer the organization's newest), so being blocked AGAIN is
 * reported at once. In memory: a restart reports it again, which is the right direction to err in.
 */
const blockedReports = new Map<string, { readonly organizationId: string; readonly at: number }>();

/** Forget the reports of every organization the sweep did not list (suspended, closed: it never visits them again to clear them). */
function forgetBlockedOutside(visited: ReadonlySet<string>): void {
  for (const [id, report] of blockedReports) {
    if (!visited.has(report.organizationId)) blockedReports.delete(id);
  }
}

function forgetBlocked(organizationId: string, keepSubscriptionId?: string): void {
  for (const [id, report] of blockedReports) {
    if (report.organizationId === organizationId && id !== keepSubscriptionId) {
      blockedReports.delete(id);
    }
  }
}

/**
 * The newest pause cannot be resumed while an OLDER subscription of the organization is live (resuming would break one-live-per-org). It
 * stays `paused` (and the claims-billing entitlement denies it) until someone acts, so it must not depend on someone reading a log line:
 * once per day per subscription it is logged AND raised through `onPauseBlocked` (the composition root binds the ops alert sink; ids only).
 * The operator cancels or pauses the older subscription by id and the next tick resumes this one.
 */
function reportBlocked(
  deps: M35JobDeps,
  blocked: { organizationId: string; subscriptionId: string; olderLiveSubscriptionId: string },
  now: Date,
): void {
  forgetBlocked(blocked.organizationId, blocked.subscriptionId);
  const last = blockedReports.get(blocked.subscriptionId);
  if (last && now.getTime() - last.at < BLOCKED_REPORT_INTERVAL_MS) return;
  blockedReports.set(blocked.subscriptionId, {
    organizationId: blocked.organizationId,
    at: now.getTime(),
  });
  deps.log?.("m35 lapsed pause not resumed: an older subscription of the organization is live", {
    organizationId: blocked.organizationId,
    subscriptionId: blocked.subscriptionId,
  });
  try {
    deps.onPauseBlocked?.(blocked);
  } catch (err) {
    // an alert sink that fails must not fail the org's run (it has committed) or hide the next org: logged, under `err` (the PHI-safe key)
    deps.log?.("m35 blocked-pause alert failed", {
      organizationId: blocked.organizationId,
      subscriptionId: blocked.subscriptionId,
      err,
    });
  }
}

type Outcome =
  | { readonly kind: "none" }
  | { readonly kind: "resumed" }
  | {
      readonly kind: "blocked";
      readonly subscriptionId: string;
      readonly olderLiveSubscriptionId: string;
    };

/**
 * Resume the org's lapsed operator pause, if its newest subscription is one, in ONE org-scoped transaction (a failure rolls all of it back
 * and the next hour retries: a transition never lacks its ledger row or its event). Returns how many it resumed (0 or 1). Idempotent: a
 * second run finds nothing. It acts on the org's NEWEST subscription only (the row every other M35 lifecycle path reads), so an older,
 * superseded pause is never a candidate: it cannot be resurrected behind the newest one, nor under a newer subscription that was canceled.
 *
 * LOCKING. The newest row is read PLAINLY first: nearly every organization, every hour, has no lapsed pause and takes no row lock (a
 * `FOR UPDATE` would block the KEY SHARE child-row inserts of subscription_state_history and invoices for the whole transaction). Only a
 * lapsed pause is locked, under a short `lock_timeout` set for this transaction alone: a holder that stalls longer fails THAT org's run with
 * SQLSTATE 55P03 (the fan-out logs it with the org id, the other orgs continue, the next hour retries) instead of stalling every org behind
 * it. The row is judged AGAIN after the lock: whoever held it may have resumed it, cancelled it or made it open-ended.
 */
export async function runPauseResumeForOrg(
  deps: PauseResumeDeps,
  organizationId: string,
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const outcome = await withOrgContext(
    deps.db,
    { organizationId, userId: "" },
    async (scoped): Promise<Outcome> => {
      const tx = scoped as unknown as DbClient;
      const peeked = await selectNewestSubscription(tx, organizationId);
      if (!peeked || !isPauseLapsed(peeked, now)) return { kind: "none" };
      await tx.execute(
        sql`SELECT set_config('lock_timeout', ${String(deps.lockTimeoutMs ?? LOCK_TIMEOUT_MS)}, true)`,
      );
      const sub = await lockNewestSubscription(tx, organizationId);
      if (!sub || !isPauseLapsed(sub, now)) return { kind: "none" };
      const endedAt = sub.pausedUntil;
      if (!endedAt) return { kind: "none" }; // isPauseLapsed implies a date; this narrows the type
      const olderLive = await findOtherLiveSubscriptionId(tx, sub);
      if (olderLive !== null) {
        return { kind: "blocked", subscriptionId: sub.id, olderLiveSubscriptionId: olderLive };
      }
      const done = await tx
        .update(S)
        .set(resumedColumns(now))
        .where(and(eq(S.id, sub.id), lapsedPause(now)))
        .returning({ id: S.id });
      if (done.length === 0) return { kind: "none" }; // another writer moved it first: leave it where they left it
      await tx
        .insert(SH)
        .values(
          resumedLedgerRow(sub, { transitionedAt: endedAt, reasonCode: PAUSE_LAPSED_REASON_CODE }),
        );
      await deps.outbox.publish(tx, resumedEventIntent(sub, endedAt));
      return { kind: "resumed" };
    },
  );
  if (outcome.kind === "blocked") {
    reportBlocked(
      deps,
      {
        organizationId,
        subscriptionId: outcome.subscriptionId,
        olderLiveSubscriptionId: outcome.olderLiveSubscriptionId,
      },
      now,
    );
  } else {
    forgetBlocked(organizationId); // committed: whatever was blocked here no longer is
  }
  return outcome.kind === "resumed" ? 1 : 0;
}

/** The hourly sweep: every active org, each isolated from the others (one org's failure is logged with its id and fails the job at the end). */
export async function runPauseResumeSweep(deps: PauseResumeDeps): Promise<void> {
  const listing: { orgs: ReadonlySet<string> | null } = { orgs: null };
  const listOrgs = async () => {
    const orgs = await deps.listOrgs();
    listing.orgs = new Set(orgs.map((o) => o.organizationId));
    return orgs;
  };
  try {
    await runM35Fanout(
      { ...deps, listOrgs },
      async (organizationId) => void (await runPauseResumeForOrg(deps, organizationId)),
      "pause_resume",
    );
  } finally {
    // only after a successful listing: a failed one says nothing about who is still active
    if (listing.orgs) forgetBlockedOutside(listing.orgs);
  }
}
