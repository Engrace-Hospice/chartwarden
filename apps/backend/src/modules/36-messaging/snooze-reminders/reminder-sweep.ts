// apps/backend/src/modules/36-messaging/snooze-reminders/reminder-sweep.ts - WP 4.10 (ADR-0077): raise the alert for every due reminder.
//
// One org per call. For each due row (oldest first, at most SWEEP_LIMIT): drop it unfired when it is stale (overdue more than 7 days:
// the sweep was down, a reminder that old would only confuse) or when its message was deleted or its owner can no longer see the
// conversation; otherwise raise ONE `m36.reminder.due` alert to the owner and delete the row. The alert id is the row id, so a retry or
// a second worker is absorbed by the emitter's correlation id and nothing is delivered twice. If the emit fails the row stays and
// the next tick tries again (counted as `failed`). The alert carries ids and one FIXED generic sentence - no message text, no patient,
// no sender - and an in-app link; out-of-band copies are the sanitiser's fixed generic line with an opaque link (ADR-0074).
import type { AlertEmitter } from "@chartwarden/messaging";
import { REMINDER_ALERT_EVENT, REMINDER_STALE_AFTER_DAYS } from "@chartwarden/types";
import type { DueReminder, ReminderSweepStore } from "./snooze-reminder-store-db";

export const SWEEP_LIMIT = 200;
const MAX_PAGES = 5;
const STALE_MS = REMINDER_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
export const REMINDER_ALERT_TEXT = "You asked to be reminded about a message in a conversation";

export interface ReminderSweepSummary {
  readonly raised: number;
  readonly dropped: number;
  readonly failed: number;
}

export interface ReminderSweepDeps {
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly store: ReminderSweepStore;
  readonly alerts: Pick<AlertEmitter, "emit">;
  readonly canViewChannel: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  readonly now?: () => Date;
  /** Ids and a reason code only. */
  readonly onDropped?: (event: {
    organizationId: string;
    reminderId: string;
    reason: "no_recipient";
  }) => void;
}

export const reminderDeepLink = (row: Pick<DueReminder, "channelId" | "messageId">): string =>
  `/messaging?channelId=${encodeURIComponent(row.channelId)}&messageId=${encodeURIComponent(row.messageId)}`;

export async function sweepRemindersForOrg(
  deps: ReminderSweepDeps,
  orgId: string,
): Promise<ReminderSweepSummary> {
  // Off: the rows wait (nothing is raised, nothing is deleted); turning the flag back on resumes them.
  if (!(await deps.isEnabled(orgId))) return { raised: 0, dropped: 0, failed: 0 };
  const now = (deps.now ?? (() => new Date()))();
  const totals = { raised: 0, dropped: 0, failed: 0 };
  // A row that fails stays at the front of the oldest-first list. Each page skips the failures of the pages before it (offset), so a
  // permanently failing row cannot starve newer due ones; a few pages per tick bound the work (ponytail: MAX_PAGES x SWEEP_LIMIT per minute).
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const due = await deps.store.listDue(orgId, SWEEP_LIMIT, totals.failed);
    for (const row of due) {
      const outcome = await sweepOne(deps, orgId, row, now);
      totals[outcome] += 1;
    }
    if (due.length < SWEEP_LIMIT) break;
  }
  return totals;
}

async function sweepOne(
  deps: ReminderSweepDeps,
  orgId: string,
  row: DueReminder,
  now: Date,
): Promise<"raised" | "dropped" | "failed"> {
  try {
    const stale = now.getTime() - row.remindAt.getTime() > STALE_MS;
    const live =
      !stale &&
      (await deps.canViewChannel(orgId, row.userId, row.channelId)) &&
      (await deps.store.messageLive(orgId, row));
    if (!live) {
      await deps.store.remove(orgId, row);
      return "dropped";
    }
    const { resolvedRecipientCount } = await deps.alerts.emit(orgId, {
      eventType: REMINDER_ALERT_EVENT,
      severity: "info",
      correlationId: `reminder:${row.id}`,
      payload: {
        recipientUserId: row.userId,
        channelId: row.channelId,
        messageId: row.messageId,
        message: REMINDER_ALERT_TEXT,
        deepLink: reminderDeepLink(row),
      },
    });
    await deps.store.remove(orgId, row);
    if (resolvedRecipientCount === 0) {
      // The alert reached nobody (the owner is no longer an active member): a counted, logged drop, not a delivered reminder.
      deps.onDropped?.({ organizationId: orgId, reminderId: row.id, reason: "no_recipient" });
      return "dropped";
    }
    return "raised";
  } catch {
    // Isolated per row: the row stays and the next tick asks again. The summary tells the worker to fail the tick visibly.
    return "failed";
  }
}
