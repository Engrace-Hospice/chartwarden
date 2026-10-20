// apps/backend/src/modules/36-messaging/snooze-reminders/snooze-reminder-service.ts - WP 4.10 (ADR-0077): snooze and reminders.
//
//   SNOOZE: one user pauses OUT-OF-BAND notices for the NON-URGENT alerts of one conversation, for 5 minutes to 24 hours. Nothing in
//   the app is hidden and nothing urgent is quieted (the allowlist of quietable alerts is `SNOOZABLE_EVENT_TYPES`). A conversation
//   in which the caller is the sender or the assignee of an OPEN acknowledgment request cannot be snoozed at all: the answer is the
//   typed 409 `SNOOZE_URGENT_NOT_ALLOWED`. The store re-checks inside the write (and a database trigger backs it), so a request opened
//   between the check and the write still refuses.
//   REMINDER: one user asks to be reminded of one NON-URGENT message at an instant 1 minute to 30 days ahead, at most 25 pending. An
//   urgent message, or one with an open acknowledgment request, is refused with `REMINDER_URGENT_NOT_ALLOWED`.
//
// Org and actor are the request context, never a parameter. A missing, deleted, other-tenant or invisible target is the same 404; the
// flag off is the same 404. Everything the caller asks about is their OWN row (RLS pins the owner again).
import {
  SNOOZE_REMINDER_ERROR_CODES as CODES,
  NotFoundError,
  REMINDER_MAX_HORIZON_DAYS,
  REMINDER_MAX_PENDING,
  REMINDER_MIN_LEAD_MINUTES,
  type ReminderDto,
  type ReminderListResponse,
  SNOOZE_MAX_MINUTES,
  SNOOZE_MIN_MINUTES,
  type SnoozeDto,
  WardenXError,
} from "@wardenx/types";

export interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

export interface ReminderRow {
  readonly id: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly remindAt: Date;
}

export interface MessageFacts {
  readonly channelId: string;
}

/** Every method is its own atomic unit; the DB implementation runs it in one transaction under the actor's context. */
export interface SnoozeReminderStore {
  /** The end of the caller's snooze of the conversation if it is still running at `at`, else null. */
  activeSnooze(actor: Actor, channelId: string, at: Date): Promise<Date | null>;
  /** Is the caller the sender or assignee of an OPEN acknowledgment request in the conversation? */
  hasOpenRequest(actor: Actor, channelId: string): Promise<boolean>;
  /** Upsert. `blocked` when an open request exists (re-checked inside the write). */
  setSnooze(
    actor: Actor,
    channelId: string,
    window: { readonly at: Date; readonly until: Date },
  ): Promise<"ok" | "blocked">;
  clearSnooze(actor: Actor, channelId: string): Promise<boolean>;
  /** The message's conversation, or null when it is missing, deleted or in another organisation. */
  messageFacts(actor: Actor, messageId: string): Promise<MessageFacts | null>;
  /** Upsert one reminder per message; `limit` past `max` pending (counted inside the write), `urgent` when the message is not routine. */
  setReminder(
    actor: Actor,
    input: {
      readonly messageId: string;
      readonly channelId: string;
      readonly at: Date;
      readonly remindAt: Date;
      readonly max: number;
    },
  ): Promise<
    | { readonly outcome: "ok"; readonly reminder: ReminderRow }
    | { readonly outcome: "limit" | "urgent" }
  >;
  clearReminder(actor: Actor, messageId: string): Promise<boolean>;
  listReminders(actor: Actor): Promise<readonly ReminderRow[]>;
}

export interface SnoozeReminderServiceDeps {
  /** The ops flag `messaging.notification_policy`. A clean false is the uniform 404; a throw propagates. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly store: SnoozeReminderStore;
  /** Opens its own connection: never called inside a store transaction. */
  readonly canViewChannel: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  readonly now?: () => Date;
}

export interface SnoozeReminderService {
  getSnooze(actor: Actor, channelId: string): Promise<SnoozeDto>;
  snooze(actor: Actor, channelId: string, durationMinutes: number): Promise<SnoozeDto>;
  clearSnooze(actor: Actor, channelId: string): Promise<{ readonly cleared: boolean }>;
  setReminder(actor: Actor, messageId: string, remindAt: string): Promise<ReminderDto>;
  clearReminder(actor: Actor, messageId: string): Promise<{ readonly cleared: boolean }>;
  listReminders(actor: Actor): Promise<ReminderListResponse>;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** An instant needs an offset: without one `Date` reads it in the SERVER's zone, a silent hours-off reminder. */
const HAS_OFFSET = /T[0-9:.]+(Z|[+-][0-9]{2}:?[0-9]{2})$/i;

const notFound = (kind: string): NotFoundError => new NotFoundError(kind);

const urgentSnooze = (): WardenXError =>
  new WardenXError(
    CODES.snoozeUrgent,
    "This conversation has an urgent or response-required item, so it cannot be snoozed.",
    409,
  );

function parseDuration(raw: unknown): number {
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < SNOOZE_MIN_MINUTES ||
    raw > SNOOZE_MAX_MINUTES
  ) {
    throw new WardenXError(
      CODES.snoozeDurationInvalid,
      `A snooze lasts between ${SNOOZE_MIN_MINUTES} minutes and ${SNOOZE_MAX_MINUTES / 60} hours.`,
      422,
    );
  }
  return raw;
}

function parseRemindAt(raw: string, now: Date): Date {
  const when = new Date(raw);
  const ahead = when.getTime() - now.getTime();
  if (
    !HAS_OFFSET.test(raw) ||
    Number.isNaN(when.getTime()) ||
    ahead < REMINDER_MIN_LEAD_MINUTES * MINUTE_MS ||
    ahead > REMINDER_MAX_HORIZON_DAYS * DAY_MS
  ) {
    throw new WardenXError(
      CODES.reminderTimeInvalid,
      `Choose a reminder time between ${REMINDER_MIN_LEAD_MINUTES} minute and ${REMINDER_MAX_HORIZON_DAYS} days from now.`,
      422,
    );
  }
  return when;
}

const toReminderDto = (row: ReminderRow): ReminderDto => ({
  id: row.id,
  channel_id: row.channelId,
  message_id: row.messageId,
  remind_at: row.remindAt.toISOString(),
});

export function createSnoozeReminderService(
  deps: SnoozeReminderServiceDeps,
): SnoozeReminderService {
  const { store } = deps;
  const clock = deps.now ?? (() => new Date());

  async function requireOn(orgId: string, kind: string): Promise<void> {
    if (!(await deps.isEnabled(orgId))) throw notFound(kind);
  }
  async function requireVisible(actor: Actor, channelId: string, kind: string): Promise<void> {
    if (!(await deps.canViewChannel(actor.orgId, actor.userId, channelId))) throw notFound(kind);
  }

  return {
    async getSnooze(actor, channelId) {
      await requireOn(actor.orgId, "snooze");
      await requireVisible(actor, channelId, "channel");
      const [until, blocked] = await Promise.all([
        store.activeSnooze(actor, channelId, clock()),
        store.hasOpenRequest(actor, channelId),
      ]);
      // An open request voids a snooze (the planner ignores it), so it is reported as not snoozed.
      return {
        channel_id: channelId,
        snoozed_until: blocked || until === null ? null : until.toISOString(),
        snoozable: !blocked,
      };
    },

    async snooze(actor, channelId, durationMinutes) {
      await requireOn(actor.orgId, "snooze");
      const minutes = parseDuration(durationMinutes);
      await requireVisible(actor, channelId, "channel");
      const at = clock();
      const until = new Date(at.getTime() + minutes * MINUTE_MS);
      if ((await store.setSnooze(actor, channelId, { at, until })) === "blocked") {
        throw urgentSnooze();
      }
      return { channel_id: channelId, snoozed_until: until.toISOString(), snoozable: true };
    },

    async clearSnooze(actor, channelId) {
      await requireOn(actor.orgId, "snooze");
      return { cleared: await store.clearSnooze(actor, channelId) };
    },

    async setReminder(actor, messageId, remindAtRaw) {
      await requireOn(actor.orgId, "reminder");
      const at = clock();
      const remindAt = parseRemindAt(remindAtRaw, at);
      const facts = await store.messageFacts(actor, messageId);
      if (!facts) throw notFound("message");
      await requireVisible(actor, facts.channelId, "message");
      const result = await store.setReminder(actor, {
        messageId,
        channelId: facts.channelId,
        at,
        remindAt,
        max: REMINDER_MAX_PENDING,
      });
      if (result.outcome === "ok") return toReminderDto(result.reminder);
      if (result.outcome === "urgent") {
        throw new WardenXError(
          CODES.reminderUrgent,
          "A reminder cannot be set on an urgent or response-required message.",
          409,
        );
      }
      throw new WardenXError(
        CODES.reminderLimit,
        `You can have at most ${REMINDER_MAX_PENDING} reminders. Cancel one first.`,
        409,
      );
    },

    async clearReminder(actor, messageId) {
      await requireOn(actor.orgId, "reminder");
      return { cleared: await store.clearReminder(actor, messageId) };
    },

    async listReminders(actor) {
      await requireOn(actor.orgId, "reminder");
      const rows = await store.listReminders(actor);
      return { reminders: rows.map(toReminderDto), max_pending: REMINDER_MAX_PENDING };
    },
  };
}
