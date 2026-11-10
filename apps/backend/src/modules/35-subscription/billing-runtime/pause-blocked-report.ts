// apps/backend/src/modules/35-subscription/billing-runtime/pause-blocked-report.ts — telling operators about a paused subscription that
// cannot be resumed because ANOTHER subscription of its organization is live.
//
// An organization may hold one live subscription (`subscription_org_active_uq`: one per organization that is neither canceled nor paused),
// so a resume that would make a second one live is refused. The two paths that resume without a person looking (the hourly pause-resume
// sweep, and the org-lifecycle consumer's `.activated` branch) cannot refuse to a caller: they leave the subscription `paused` (and the
// claims-billing entitlement denies it) until an operator cancels or pauses the other one, so that state must not depend on someone reading a
// log line. Both report it through this one gate: logged AND raised through `onPauseBlocked` (the composition root binds the ops alert
// sink; ids only), once per day per subscription however many times either path meets it.
import type { M35JobDeps, PauseBlockedEvent, PauseBlockedTrigger } from "./jobs";

/** A blocked pause is reported to operators again after this long (not every hour). */
const BLOCKED_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const BLOCKED_LOG_MESSAGE: Readonly<Record<PauseBlockedTrigger, string>> = {
  lapsed_pause: "m35 lapsed pause not resumed: an older subscription of the organization is live",
  organization_activated:
    "m35 organization reactivated but its paused subscription was not resumed: an older subscription of the organization is live",
};

/** The sinks a path that can meet a blocked pause reports through. */
export type PauseBlockedSinks = Pick<M35JobDeps, "log" | "onPauseBlocked">;

/**
 * The blocked pauses this process has reported, by subscription id: reported again only after a day, and forgotten as soon as the
 * subscription is no longer blocked (resumed, moved by another writer, no longer the organization's newest), so being blocked AGAIN is
 * reported at once. In memory: a restart reports it again, which is the right direction to err in.
 */
const blockedReports = new Map<string, { readonly organizationId: string; readonly at: number }>();

/** Forget the reports of every organization the sweep did not list (suspended, closed: it never visits them again to clear them). */
export function forgetBlockedOutside(visited: ReadonlySet<string>): void {
  for (const [id, report] of blockedReports) {
    if (!visited.has(report.organizationId)) blockedReports.delete(id);
  }
}

/** Forget what was reported for the organization, except `keepSubscriptionId`'s report (it is still blocked). */
export function forgetBlocked(organizationId: string, keepSubscriptionId?: string): void {
  for (const [id, report] of blockedReports) {
    if (report.organizationId === organizationId && id !== keepSubscriptionId) {
      blockedReports.delete(id);
    }
  }
}

/**
 * Report a paused subscription that cannot be resumed because another one of its organization is live: logged and raised through
 * `onPauseBlocked`, at most once per day per subscription. A sink that fails never fails the caller (the sweep's org run, or the consumer's
 * delivery, which would otherwise retry to a dead letter for want of an alert): it is logged under `err` (the PHI-safe key).
 */
export function reportBlockedPause(
  sinks: PauseBlockedSinks,
  blocked: PauseBlockedEvent,
  now: Date,
): void {
  forgetBlocked(blocked.organizationId, blocked.subscriptionId);
  const last = blockedReports.get(blocked.subscriptionId);
  if (last && now.getTime() - last.at < BLOCKED_REPORT_INTERVAL_MS) return;
  blockedReports.set(blocked.subscriptionId, {
    organizationId: blocked.organizationId,
    at: now.getTime(),
  });
  sinks.log?.(BLOCKED_LOG_MESSAGE[blocked.trigger], {
    organizationId: blocked.organizationId,
    subscriptionId: blocked.subscriptionId,
  });
  try {
    sinks.onPauseBlocked?.(blocked);
  } catch (err) {
    sinks.log?.("m35 blocked-pause alert failed", {
      organizationId: blocked.organizationId,
      subscriptionId: blocked.subscriptionId,
      err,
    });
  }
}
