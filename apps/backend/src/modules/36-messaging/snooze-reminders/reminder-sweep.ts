// apps/backend/src/modules/36-messaging/snooze-reminders/reminder-sweep.ts - WP 4.10 (ADR-0077): raise the alert for every due reminder.
//
// One org per call. For each due row (oldest first, at most SWEEP_LIMIT): drop it unfired when it is stale (overdue more than 7 days:
// the sweep was down, a reminder that old would only confuse) or when its message was deleted or its owner can no longer see the
// conversation; otherwise raise ONE `m36.reminder.due` alert to the owner and delete the row. The alert id is the row id, so a retry or
// a second worker is absorbed by the emitter's correlation id and nothing is delivered twice. If the emit fails the row stays and
// the next tick tries again (counted as `failed`). The alert carries ids and one FIXED generic sentence - no message text, no patient,
// no sender - and an in-app link; out-of-band copies are the sanitiser's fixed generic line with an opaque link (ADR-0074).
import type { AlertEmitter } from "@wardenx/messaging";
import { REMINDER_ALERT_EVENT, REMINDER_STALE_AFTER_DAYS } from "@wardenx/types";
import type { DueReminder, ReminderSweepStore } from "./snooze-reminder-store-db";

export const SWEEP_LIMIT = 200;
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
  const due = await deps.store.listDue(orgId, SWEEP_LIMIT);
  let raised = 0;
  let dropped = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const stale = now.getTime() - row.remindAt.getTime() > STALE_MS;
      const live =
        !stale &&
        (await deps.canViewChannel(orgId, row.userId, row.channelId)) &&
        (await deps.store.messageLive(orgId, row));
      if (!live) {
        await deps.store.remove(orgId, row);
        dropped += 1;
        continue;
      }
      await deps.alerts.emit(orgId, {
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
      raised += 1;
    } catch {
      // Isolated per row: the row stays and the next tick asks again. The summary tells the worker to fail the tick visibly.
      failed += 1;
    }
  }
  return { raised, dropped, failed };
}
