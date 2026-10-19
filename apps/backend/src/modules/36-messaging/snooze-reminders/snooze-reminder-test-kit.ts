// apps/backend/src/modules/36-messaging/snooze-reminders/snooze-reminder-test-kit.ts - WP 4.10: an in-memory store for the unit tests
// (the sibling of handoffs/handoff-test-kit.ts). It keys every row by organisation AND user exactly like the owner-strict RLS does, and
// it models the two store-side refusals (an open request voids a snooze; an urgent message refuses a reminder) so the service's error
// mapping is exercised against the same outcomes the database trigger produces. The live suite proves the real thing.
import type {
  Actor,
  MessageFacts,
  ReminderRow,
  SnoozeReminderStore,
} from "./snooze-reminder-service";

export interface MemoryStoreSeed {
  /** orgId:messageId -> facts, plus whether the message is urgent. */
  readonly messages?: ReadonlyMap<string, MessageFacts & { readonly urgent?: boolean }>;
  /** orgId:userId:channelId combinations that have an OPEN acknowledgment request. */
  readonly openRequests?: Set<string>;
}

export function createMemorySnoozeReminderStore(seed: MemoryStoreSeed = {}) {
  const snoozes = new Map<string, { at: Date; until: Date }>();
  const reminders = new Map<string, ReminderRow & { userId: string; orgId: string }>();
  const messages = new Map(seed.messages ?? []);
  const openRequests = seed.openRequests ?? new Set<string>();
  let nextId = 1;
  const snoozeKey = (a: Actor, channelId: string) => `${a.orgId}:${a.userId}:${channelId}`;

  const store: SnoozeReminderStore = {
    async activeSnooze(a, channelId, at) {
      const row = snoozes.get(snoozeKey(a, channelId));
      return row && row.until.getTime() > at.getTime() ? row.until : null;
    },
    async hasOpenRequest(a, channelId) {
      return openRequests.has(snoozeKey(a, channelId));
    },
    async setSnooze(a, channelId, window) {
      if (openRequests.has(snoozeKey(a, channelId))) return "blocked";
      snoozes.set(snoozeKey(a, channelId), { at: window.at, until: window.until });
      return "ok";
    },
    async clearSnooze(a, channelId) {
      return snoozes.delete(snoozeKey(a, channelId));
    },
    async messageFacts(a, messageId) {
      const m = messages.get(`${a.orgId}:${messageId}`);
      return m ? { channelId: m.channelId } : null;
    },
    async setReminder(a, input) {
      const m = messages.get(`${a.orgId}:${input.messageId}`);
      if (!m || m.urgent) return { outcome: "urgent" };
      const key = `${a.orgId}:${a.userId}:${input.messageId}`;
      const others = [...reminders.values()].filter(
        (r) => r.orgId === a.orgId && r.userId === a.userId && r.messageId !== input.messageId,
      ).length;
      if (others >= input.max) return { outcome: "limit" };
      const id = reminders.get(key)?.id ?? `reminder-${nextId++}`;
      const row = {
        id,
        channelId: input.channelId,
        messageId: input.messageId,
        remindAt: input.remindAt,
        userId: a.userId,
        orgId: a.orgId,
      };
      reminders.set(key, row);
      return { outcome: "ok", reminder: row };
    },
    async clearReminder(a, messageId) {
      return reminders.delete(`${a.orgId}:${a.userId}:${messageId}`);
    },
    async listReminders(a) {
      return [...reminders.values()]
        .filter((r) => r.orgId === a.orgId && r.userId === a.userId)
        .sort((x, y) => x.remindAt.getTime() - y.remindAt.getTime());
    },
  };
  return { store, snoozes, reminders, openRequests, messages };
}
