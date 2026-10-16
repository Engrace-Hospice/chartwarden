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

function setup(current: AckRow | null, canView: (u: string) => boolean = () => true) {
  const emit = vi.fn(async () => undefined);
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
    expect(ctx.emit).toHaveBeenCalledOnce();
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

  it("still pages ops but alerts nobody when the request moved on (the assignee acknowledged)", async () => {
    const ctx = setup(row({ status: "acknowledged", version: 2 }));

    await ctx.consumer.handle(event);

    expect(ctx.opsNotice).toHaveBeenCalledOnce();
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it("drops a party who can no longer see the channel but still alerts the supervisor rule", async () => {
    const ctx = setup(row(), (u) => u === REQUESTER);

    await ctx.consumer.handle(event);

    const alert = (ctx.emit.mock.calls[0] as unknown as [string, Record<string, any>])[1];
    expect(alert.payload.recipientUserIds).toEqual([REQUESTER]);
  });
});
