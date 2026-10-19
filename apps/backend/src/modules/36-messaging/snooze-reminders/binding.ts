// apps/backend/src/modules/36-messaging/snooze-reminders/binding.ts - WP 4.10 (ADR-0077): the composition-root binding for snooze and
// reminders. The ops flag `messaging.notification_policy` (tenant row wins; absent = off) gates the routes and the sweep, read through
// the platform's FeatureFlagReaderPort and cached a few seconds per org (a kill switch lands within that window).
import type { DbClient } from "@wardenx/db";
import type { AlertEmitter } from "@wardenx/messaging";
import { SNOOZE_REMINDER_FLAG_KEY } from "@wardenx/types";
import { cacheFlagRead } from "../presence/binding";
import { type ReminderSweepSummary, sweepRemindersForOrg } from "./reminder-sweep";
import { type SnoozeReminderService, createSnoozeReminderService } from "./snooze-reminder-service";
import {
  createDbReminderSweepStore,
  createDbSnoozeReminderStore,
} from "./snooze-reminder-store-db";

export interface SnoozeReminderBindingInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
  };
  readonly now?: () => Date;
}

export interface SnoozeReminderBinding {
  readonly service: SnoozeReminderService;
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  /** The per-org sweep body, over the platform's AlertEmitter. */
  readonly sweep: (
    alerts: Pick<AlertEmitter, "emit">,
  ) => (orgId: string) => Promise<ReminderSweepSummary>;
}

export function buildSnoozeReminderBinding(
  input: SnoozeReminderBindingInput,
): SnoozeReminderBinding {
  const isEnabled = cacheFlagRead(async (organizationId) =>
    input.flags
      ? (await input.flags.forOrg(organizationId))[SNOOZE_REMINDER_FLAG_KEY] === true
      : false,
  );
  const service = createSnoozeReminderService({
    isEnabled,
    store: createDbSnoozeReminderStore(input.db),
    canViewChannel: input.messaging.canViewChannel,
    ...(input.now ? { now: input.now } : {}),
  });
  const store = createDbReminderSweepStore(input.db);
  return {
    service,
    isEnabled,
    sweep: (alerts) => (orgId) =>
      sweepRemindersForOrg(
        {
          isEnabled,
          store,
          alerts,
          canViewChannel: input.messaging.canViewChannel,
          ...(input.now ? { now: input.now } : {}),
        },
        orgId,
      ),
  };
}
