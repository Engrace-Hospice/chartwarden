// @chartwarden/messaging - M36 WP 4.10 (ADR-0077): a conversation snooze quiets ONLY the out-of-band rows of an allowlisted, non-urgent
// alert. The in-app row is always planned, and no urgent or acknowledgment-bound alert is ever quieted - by construction, whatever the
// snooze set holds. Every instant is a fixed ISO string.
import { describe, expect, it } from "vitest";
import {
  type AlertContext,
  DESIGNATED_EVENT_TYPES,
  type NotificationChannel,
  type RecipientPreferences,
  SNOOZABLE_EVENT_TYPES,
  createAlertEmitter,
  createInMemoryAlertEmitter,
  isSnoozableEvent,
  planFanOutDetailed,
} from "../src/index";

const AT = new Date("2026-10-18T12:00:00Z");
const MENTION: AlertContext = {
  eventType: "m36.message.mentioned",
  category: "clinical_routine",
  severity: "info",
};
const prefs = (over: Partial<RecipientPreferences> = {}): RecipientPreferences => ({
  userId: "u-1",
  routingMap: {},
  quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
  vacationForwardToUserId: null,
  vacationUntil: null,
  ...over,
});
const PUSH_AND_EMAIL: readonly NotificationChannel[] = ["in_app", "push", "email"];

const plan = (
  alert: AlertContext,
  snoozed: readonly string[],
  over: { users?: readonly string[]; prefs?: Map<string, RecipientPreferences> } = {},
) =>
  planFanOutDetailed({
    alert,
    channelsOverride: PUSH_AND_EMAIL,
    recipientUserIds: over.users ?? ["u-1"],
    preferences: over.prefs ?? new Map([["u-1", prefs()]]),
    at: AT,
    snoozedUserIds: new Set(snoozed),
  }).plan;

describe("the allowlist", () => {
  it("is exactly the conversation mention, and shares nothing with the designated routes", () => {
    expect([...SNOOZABLE_EVENT_TYPES]).toEqual(["m36.message.mentioned"]);
    for (const designated of DESIGNATED_EVENT_TYPES)
      expect(isSnoozableEvent(designated)).toBe(false);
  });

  it.each([
    "m36.message.urgent_sent",
    "m36.ack.requested",
    "m36.ack.reassigned",
    "m36.ack.escalated",
    "m36.ack.route_unavailable",
    "m36.ack.ladder_exhausted",
    "m36.ack.failed_unreachable",
    "m36.task.created",
    "m36.handoff.offered",
    "m36.reminder.due",
    "field_safety.sos",
    "",
    "m36.message.mentioned.x",
  ])("%j is not snoozable", (eventType) => {
    expect(isSnoozableEvent(eventType)).toBe(false);
  });
});

describe("a snoozed recipient", () => {
  it("keeps the in-app row and has every out-of-band row skipped with the reason 'snoozed'", () => {
    const rows = plan(MENTION, ["u-1"]);
    expect(rows.find((r) => r.channel === "in_app")).toMatchObject({ status: "pending" });
    for (const channel of ["push", "email"] as const) {
      expect(rows.find((r) => r.channel === channel)).toMatchObject({
        status: "skipped_quiet_hours",
        reason: "snoozed",
      });
    }
  });

  it("is untouched when not in the snoozed set, and a colleague's snooze does not quiet me", () => {
    const rows = plan(MENTION, ["u-2"]);
    expect(rows.filter((r) => r.channel !== "in_app").every((r) => r.status === "pending")).toBe(
      true,
    );
  });

  it("only the snoozed recipient is quieted when several are notified", () => {
    const rows = plan(MENTION, ["u-1"], {
      users: ["u-1", "u-2"],
      prefs: new Map([
        ["u-1", prefs()],
        ["u-2", prefs({ userId: "u-2" })],
      ]),
    });
    const push = (u: string) => rows.find((r) => r.recipientUserId === u && r.channel === "push");
    expect(push("u-1")?.status).toBe("skipped_quiet_hours");
    expect(push("u-2")?.status).toBe("pending");
  });

  it("a recipient on vacation is forwarded as before (the snooze does not speak for the backup)", () => {
    const rows = plan(MENTION, ["u-1"], {
      prefs: new Map([
        [
          "u-1",
          prefs({
            vacationForwardToUserId: "u-2",
            vacationUntil: new Date("2026-10-30T00:00:00Z"),
          }),
        ],
        ["u-2", prefs({ userId: "u-2" })],
      ]),
    });
    expect(rows.some((r) => r.status === "forwarded")).toBe(true);
    expect(rows.some((r) => r.reason === "snoozed")).toBe(false);
  });
});

describe("an urgent item arriving while snoozed still notifies", () => {
  const verified = new Map([["u-1", new Set<NotificationChannel>(["push", "sms", "email"])]]);

  it.each([
    ["m36.message.urgent_sent", "urgent"],
    ["m36.ack.requested", "important"],
    ["m36.ack.reassigned", "urgent"],
    ["m36.ack.escalated", "critical"],
  ] as const)("%s (%s) plans its push at once even for a snoozed user", (eventType, ackClass) => {
    const { plan: rows } = planFanOutDetailed({
      alert: { eventType, category: "clinical_urgent", severity: "warn" },
      channelsOverride: ["in_app"],
      recipientUserIds: ["u-1"],
      preferences: new Map([["u-1", prefs()]]),
      at: AT,
      policy: { ackClass, verifiedChannels: verified },
      snoozedUserIds: new Set(["u-1"]),
    });
    const push = rows.find((r) => r.channel === "push");
    expect(push).toMatchObject({ status: "pending" });
    expect(push?.reason).toBeUndefined();
  });

  it("the plan is identical with and without a snooze, for every non-allowlisted event", () => {
    for (const eventType of [
      "m36.ack.route_unavailable",
      "m36.ack.failed_unreachable",
      "m36.task.created",
      "m36.reminder.due",
    ]) {
      const alert = { ...MENTION, eventType };
      expect(plan(alert, ["u-1"])).toEqual(plan(alert, []));
    }
  });
});

describe("through the emitter", () => {
  const rules = (eventType: string) => [
    {
      category: "clinical_routine" as const,
      severityFloor: "info" as const,
      recipientResolver: "role_set" as const,
      resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserId"] },
      channelsOverride: PUSH_AND_EMAIL,
      eventType,
    },
  ];

  it("asks the snooze port only for an allowlisted alert that carries a channel id", async () => {
    const asked: string[] = [];
    const emitter = createAlertEmitter({
      recipients: {
        careTeamMembers: async () => [],
        onCallMembers: async () => [],
        disciplineMembers: async () => [],
        roleSetMembers: async () => [],
        tenantAdmins: async () => [],
        orgMembers: async () => [],
      },
      rulesFor: async (_org, eventType) => rules(eventType),
      preferencesFor: async () => new Map([["u-1", prefs()]]),
      persist: async () => ({ alertId: "a-1" }),
      snoozedUsersFor: async (_org, channelId, _users, messageId) => {
        asked.push(`${channelId}/${messageId}`);
        return new Set();
      },
      now: () => AT,
    });
    const emit = (eventType: string, payload: Record<string, unknown>, n: number) =>
      emitter.emit("org", { eventType, severity: "info", correlationId: `c-${n}`, payload });
    await emit(
      "m36.message.mentioned",
      { recipientUserId: "u-1", channelId: "ch-1", messageId: "m-1" },
      1,
    );
    await emit("m36.message.mentioned", { recipientUserId: "u-1", messageId: "m-1" }, 2); // no channel id
    await emit("m36.message.mentioned", { recipientUserId: "u-1", channelId: "ch-1" }, 5); // no message id: never snoozed
    await emit("m36.task.created", { recipientUserId: "u-1", channelId: "ch-2" }, 3); // not allowlisted
    await emit("m36.ack.requested", { recipientUserId: "u-1", channelId: "ch-3" }, 4); // designated
    expect(asked).toEqual(["ch-1/m-1"]);
  });

  it("quiets the snoozed user's push and email, not their in-app row", async () => {
    const { emitter, recorded } = createInMemoryAlertEmitter({
      now: () => AT,
      rulesFor: (_org, eventType) => rules(eventType),
      preferences: new Map([["u-1", prefs()]]),
      snoozedUsers: new Set(["u-1"]),
    });
    await emitter.emit("org", {
      eventType: "m36.message.mentioned",
      severity: "info",
      correlationId: "c-2",
      payload: { recipientUserId: "u-1", channelId: "ch-1", messageId: "m-1" },
    });
    const byChannel = Object.fromEntries(
      (recorded[0]?.deliveries ?? []).map((d) => [d.channel, d.status]),
    );
    expect(byChannel).toEqual({
      in_app: "pending",
      push: "skipped_quiet_hours",
      email: "skipped_quiet_hours",
    });
  });

  it("a mention with no channel id in its payload is never looked up (so never quieted)", async () => {
    const { emitter, recorded } = createInMemoryAlertEmitter({
      now: () => AT,
      rulesFor: (_org, eventType) => rules(eventType),
      preferences: new Map([["u-1", prefs()]]),
      snoozedUsers: new Set(["u-1"]),
    });
    await emitter.emit("org", {
      eventType: "m36.message.mentioned",
      severity: "info",
      correlationId: "c-3",
      payload: { recipientUserId: "u-1" },
    });
    const deliveries = recorded[0]?.deliveries ?? [];
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.status === "pending")).toBe(true);
  });
});
