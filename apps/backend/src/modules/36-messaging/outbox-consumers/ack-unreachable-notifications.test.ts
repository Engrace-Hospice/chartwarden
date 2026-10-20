// WP 4.5 - the failed_unreachable notifications: a generic in-app alert and an ops notice, never claiming anyone was reached.
import { describe, expect, it, vi } from "vitest";
import type { AckRow } from "../ack-requests/ack-types";
import {
  ACK_UNREACHABLE_NOTIFICATION_TEXT,
  buildM36AckUnreachableNotificationsConsumer,
} from "./ack-unreachable-notifications";

const ORG = "00000000-0000-4000-8000-00000000000a";
const REQUESTER = "00000000-0000-4000-8000-0000000000b1";
const ASSIGNEE = "00000000-0000-4000-8000-0000000000b2";
const REQUEST = "00000000-0000-4000-8000-0000000000f1";
const MESSAGE = "00000000-0000-4000-8000-0000000000f2";
const CHANNEL = "00000000-0000-4000-8000-0000000000e1";
const T0 = new Date("2026-10-15T12:00:00.000Z");

const row = (overrides: Partial<AckRow> = {}): AckRow => ({
  id: REQUEST,
  organizationId: ORG,
  messageId: MESSAGE,
  channelId: CHANNEL,
  patientId: "00000000-0000-4000-8000-0000000000d1",
  ackClass: "urgent",
  status: "failed_unreachable",
  requesterUserId: REQUESTER,
  assignedUserId: ASSIGNEE,
  requestedAt: T0,
  windowStartedAt: T0,
  deadlineAt: T0,
  currentTier: 0,
  acknowledgedAt: null,
  acknowledgedByUserId: null,
  resolvedAt: null,
  resolvedByUserId: null,
  cancelledAt: null,
  version: 1,
  ...overrides,
});
const event = {
  eventType: "m36.ack.failed_unreachable",
  organizationId: ORG,
  payload: {
    organizationId: ORG,
    requestId: REQUEST,
    messageId: MESSAGE,
    channelId: CHANNEL,
    ackClass: "urgent",
    assignedUserId: ASSIGNEE,
    actorUserId: null,
    requestVersion: 1,
    at: T0.toISOString(),
  },
} as never;

function setup(
  current: AckRow | null,
  canView: (u: string) => boolean = () => true,
  outOfBandPlanned = 1,
) {
  const emit = vi.fn(async () => ({ alertId: "a1", resolvedRecipientCount: 2, outOfBandPlanned }));
  const opsNotice = vi.fn();
  const consumer = buildM36AckUnreachableNotificationsConsumer({
    alerts: { emit } as never,
    messaging: { canViewChannel: async (_o: string, u: string) => canView(u) },
    readRequest: async () => current,
    opsNotice,
  });
  return { consumer, emit, opsNotice };
}

describe("m36.ack-unreachable-notifications", () => {
  it("raises the ops notice and one generic alert for the parties and the supervisor rule", async () => {
    const ctx = setup(row());

    await ctx.consumer.handle(event);

    expect(ctx.opsNotice).toHaveBeenCalledOnce();
    expect(ctx.emit).toHaveBeenCalledTimes(2); // the parties, then the supervisor attention alert
    const [org, alert] = ctx.emit.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(org).toBe(ORG);
    expect(alert).toMatchObject({
      eventType: "m36.ack.failed_unreachable",
      correlationId: `ack-unreach:${REQUEST}:1`,
      payload: {
        recipientUserIds: [REQUESTER, ASSIGNEE],
        message: ACK_UNREACHABLE_NOTIFICATION_TEXT,
      },
    });
  });

  it("tells the supervisors through the attention alert (ADR-0079), with a class and a queue link, no channel or message", async () => {
    const ctx = setup(row());

    await ctx.consumer.handle(event);

    const [, attention] = ctx.emit.mock.calls[1] as unknown as [string, Record<string, any>];
    expect(attention).toMatchObject({
      eventType: "m36.ack.supervisor_attention",
      correlationId: `ack-attn:${REQUEST}:1:failed_unreachable`,
      payload: {
        reason: "failed_unreachable",
        ackClass: "urgent",
        deepLink: "/messaging/unacknowledged",
      },
    });
    expect(attention.payload).not.toHaveProperty("channelId");
    expect(attention.payload).not.toHaveProperty("messageId");
  });

  it("degrades visibly: no planned out-of-band route for the supervisors raises an unpaged ops notice", async () => {
    const ctx = setup(row(), () => true, 0);

    await ctx.consumer.handle(event);

    expect(ctx.opsNotice).toHaveBeenCalledTimes(2);
    expect(ctx.opsNotice).toHaveBeenLastCalledWith({
      kind: "m36.ack.supervisor_unpaged",
      summary: expect.stringContaining("in-app only"),
      details: {
        organizationId: ORG,
        requestId: REQUEST,
        ackClass: "urgent",
        reason: "failed_unreachable",
        supervisors: 2,
      },
      correlationId: `unpaged:ack-attn:${REQUEST}:1:failed_unreachable`,
    });
  });

  it("never says anyone was reached", () => {
    expect(ACK_UNREACHABLE_NOTIFICATION_TEXT).toMatch(/could not be delivered/);
    expect(ACK_UNREACHABLE_NOTIFICATION_TEXT).toMatch(/nobody is known to have received/);
    expect(ACK_UNREACHABLE_NOTIFICATION_TEXT).not.toMatch(
      /\b(reached|delivered to you|notified)\b/i,
    );
  });

  it("keeps the ops notice to ids and a class", async () => {
    const ctx = setup(row());

    await ctx.consumer.handle(event);

    expect(ctx.opsNotice).toHaveBeenCalledWith({
      kind: "m36.ack.failed_unreachable",
      summary: expect.any(String),
      details: { organizationId: ORG, requestId: REQUEST, ackClass: "urgent" },
      correlationId: `ack-unreach:${REQUEST}:1`,
    });
  });

  it("raises neither the ops notice nor the alert when the request moved on (the assignee acknowledged): no webhook noise on a retry", async () => {
    const ctx = setup(row({ status: "acknowledged", version: 2 }));

    await ctx.consumer.handle(event);

    expect(ctx.opsNotice).not.toHaveBeenCalled();
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it("a retry after a failed alert does not repeat the ops notice, and the notice is raised before the alert", async () => {
    const ctx = setup(row());
    ctx.emit.mockRejectedValueOnce(new Error("emit blip"));

    await expect(ctx.consumer.handle(event)).rejects.toThrow("emit blip");
    expect(ctx.opsNotice).toHaveBeenCalledOnce(); // not lost although the alert failed
    await ctx.consumer.handle(event); // the outbox retry

    expect(ctx.opsNotice).toHaveBeenCalledOnce();
    expect(ctx.emit).toHaveBeenCalledTimes(3); // failed parties alert, then parties + attention on the retry
  });

  it("takes the channel and message from the stored request, not the payload", async () => {
    const ctx = setup(row());
    const base = event as unknown as { payload: Record<string, unknown> };
    const spoofed = {
      ...base,
      payload: {
        ...base.payload,
        channelId: "00000000-0000-4000-8000-0000000000ee",
        messageId: "00000000-0000-4000-8000-0000000000ef",
      },
    } as never;

    await ctx.consumer.handle(spoofed);

    const alert = (ctx.emit.mock.calls[0] as unknown as [string, Record<string, any>])[1];
    expect(alert.payload.channelId).toBe(CHANNEL);
    expect(alert.payload.messageId).toBe(MESSAGE);
  });

  it("drops a party who can no longer see the channel but still alerts the supervisors", async () => {
    const ctx = setup(row(), (u) => u === REQUESTER);

    await ctx.consumer.handle(event);

    const alert = (ctx.emit.mock.calls[0] as unknown as [string, Record<string, any>])[1];
    expect(alert.payload.recipientUserIds).toEqual([REQUESTER]);
  });
});
