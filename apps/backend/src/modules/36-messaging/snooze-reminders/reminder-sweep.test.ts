// WP 4.10 (ADR-0077) - the reminder sweep: what it raises, what it drops, what it leaves for the next tick, and that the alert carries
// no message text. Pure over fakes; the live suite proves the same against the database.
import { REMINDER_ALERT_EVENT } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { REMINDER_ALERT_TEXT, reminderDeepLink, sweepRemindersForOrg } from "./reminder-sweep";
import type { DueReminder, ReminderSweepStore } from "./snooze-reminder-store-db";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-18T12:00:00.000Z");
const row = (over: Partial<DueReminder> = {}): DueReminder => ({
  id: "r-1",
  userId: "u-1",
  channelId: "ch-1",
  messageId: "m-1",
  remindAt: new Date(NOW.getTime() - 60_000),
  ...over,
});

function harness(
  rows: DueReminder[],
  opts: {
    enabled?: boolean;
    live?: boolean;
    canView?: boolean;
    emitFails?: boolean;
    failIds?: string[];
    recipients?: number;
  } = {},
) {
  const emitted: Array<{
    eventType: string;
    correlationId: string;
    payload: Record<string, unknown>;
  }> = [];
  const removed: string[] = [];
  const store: ReminderSweepStore = {
    listDue: async (_org, _limit, offset = 0) =>
      rows.filter((r) => !removed.includes(r.id)).slice(offset),
    messageLive: async () => opts.live !== false,
    remove: async (_org, r) => {
      removed.push(r.id);
    },
  };
  const deps = {
    isEnabled: async () => opts.enabled !== false,
    store,
    canViewChannel: async () => opts.canView !== false,
    now: () => NOW,
    alerts: {
      emit: async (_org: string, input: (typeof emitted)[number] & { severity: string }) => {
        if (
          opts.emitFails ||
          opts.failIds?.includes((input.payload as { messageId: string }).messageId)
        ) {
          throw new Error("emitter down");
        }
        emitted.push(input);
        return { alertId: "a-1", resolvedRecipientCount: opts.recipients ?? 1 };
      },
    },
  };
  return { deps, emitted, removed };
}

describe("the reminder sweep", () => {
  it("raises one alert to the owner with ids and fixed generic text, then deletes the row", async () => {
    const h = harness([row()]);
    const summary = await sweepRemindersForOrg(h.deps, ORG);
    expect(summary).toEqual({ raised: 1, dropped: 0, failed: 0 });
    expect(h.removed).toEqual(["r-1"]);
    expect(h.emitted).toHaveLength(1);
    const alert = h.emitted[0];
    expect(alert?.eventType).toBe(REMINDER_ALERT_EVENT);
    expect(alert?.correlationId).toBe("reminder:r-1");
    expect(alert?.payload).toEqual({
      recipientUserId: "u-1",
      channelId: "ch-1",
      messageId: "m-1",
      message: REMINDER_ALERT_TEXT,
      deepLink: reminderDeepLink(row()),
    });
  });

  it("carries no message text, patient or sender: the payload keys are an allowlist", async () => {
    const h = harness([row()]);
    await sweepRemindersForOrg(h.deps, ORG);
    expect(Object.keys(h.emitted[0]?.payload ?? {}).sort()).toEqual([
      "channelId",
      "deepLink",
      "message",
      "messageId",
      "recipientUserId",
    ]);
    expect(REMINDER_ALERT_TEXT).not.toMatch(/patient|mrn|dob|[0-9]{3}/i);
  });

  it("the link is an in-app path with encoded ids (never an absolute URL or a script)", () => {
    const link = reminderDeepLink(row({ channelId: "a b&c", messageId: "x/../y" }));
    expect(link.startsWith("/messaging?")).toBe(true);
    expect(link).not.toMatch(/\s|\/\.\.\//);
  });

  it("drops a reminder whose message was deleted, or whose owner lost the conversation, without raising", async () => {
    const gone = harness([row()], { live: false });
    expect(await sweepRemindersForOrg(gone.deps, ORG)).toEqual({
      raised: 0,
      dropped: 1,
      failed: 0,
    });
    expect(gone.emitted).toEqual([]);
    expect(gone.removed).toEqual(["r-1"]);
    const noAccess = harness([row()], { canView: false });
    expect(await sweepRemindersForOrg(noAccess.deps, ORG)).toEqual({
      raised: 0,
      dropped: 1,
      failed: 0,
    });
    expect(noAccess.emitted).toEqual([]);
  });

  it("drops a reminder overdue by more than 7 days, but raises one overdue by exactly 7 days", async () => {
    const day = 24 * 60 * 60 * 1000;
    const edge = harness([row({ remindAt: new Date(NOW.getTime() - 7 * day) })]);
    expect((await sweepRemindersForOrg(edge.deps, ORG)).raised).toBe(1);
    const stale = harness([row({ remindAt: new Date(NOW.getTime() - 7 * day - 1) })]);
    expect(await sweepRemindersForOrg(stale.deps, ORG)).toEqual({
      raised: 0,
      dropped: 1,
      failed: 0,
    });
    expect(stale.emitted).toEqual([]);
  });

  it("leaves the row in place when the emit fails, counts it, and carries on with the others", async () => {
    const h = harness([row(), row({ id: "r-2" })], { emitFails: true });
    const summary = await sweepRemindersForOrg(h.deps, ORG);
    expect(summary).toEqual({ raised: 0, dropped: 0, failed: 2 });
    expect(h.removed).toEqual([]);
  });

  it("a crash between the emit and the delete re-emits the SAME correlation id (the emitter absorbs it)", async () => {
    const first = harness([row()]);
    await sweepRemindersForOrg(first.deps, ORG);
    const retry = harness([row()]);
    await sweepRemindersForOrg(retry.deps, ORG);
    expect(retry.emitted[0]?.correlationId).toBe(first.emitted[0]?.correlationId);
  });

  it("does nothing, and deletes nothing, while the tenant flag is off", async () => {
    const h = harness([row()], { enabled: false });
    expect(await sweepRemindersForOrg(h.deps, ORG)).toEqual({ raised: 0, dropped: 0, failed: 0 });
    expect(h.emitted).toEqual([]);
    expect(h.removed).toEqual([]);
  });

  it("an empty tick is a no-op", async () => {
    const h = harness([]);
    expect(await sweepRemindersForOrg(h.deps, ORG)).toEqual({ raised: 0, dropped: 0, failed: 0 });
  });

  it("a row that fails every tick does not starve newer due rows (failures are skipped within the tick)", async () => {
    const day = 60_000;
    const stuck = Array.from({ length: 205 }, (_, i) =>
      row({
        id: `stuck-${i}`,
        messageId: `bad-${i}`,
        remindAt: new Date(NOW.getTime() - 10 * day - i),
      }),
    );
    const fresh = row({ id: "fresh", messageId: "good", remindAt: new Date(NOW.getTime() - day) });
    const h = harness([...stuck, fresh], { failIds: stuck.map((r) => r.messageId) });
    const summary = await sweepRemindersForOrg(h.deps, ORG);
    expect(summary).toEqual({ raised: 1, dropped: 0, failed: 205 });
    expect(h.removed).toEqual(["fresh"]);
  });

  it("an alert that reached nobody is a counted, logged drop and the row is deleted", async () => {
    const h = harness([row()], { recipients: 0 });
    const dropped: unknown[] = [];
    const summary = await sweepRemindersForOrg(
      { ...h.deps, onDropped: (e) => dropped.push(e) },
      ORG,
    );
    expect(summary).toEqual({ raised: 0, dropped: 1, failed: 0 });
    expect(dropped).toEqual([{ organizationId: ORG, reminderId: "r-1", reason: "no_recipient" }]);
    expect(h.removed).toEqual(["r-1"]);
  });
});
