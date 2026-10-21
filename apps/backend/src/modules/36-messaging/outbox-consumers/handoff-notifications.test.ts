import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  HANDOFF_NOTIFICATION_TEXT,
  M36_HANDOFF_NOTIFICATION_CONSUMER,
  buildM36HandoffNotificationsConsumer,
} from "./handoff-notifications";

const ORG = "11111111-1111-4111-8111-111111111111";
const event = (id: string, eventType: string, payload: Record<string, unknown>) =>
  ({
    id,
    eventType,
    organizationId: ORG,
    payload: { organizationId: "attacker-copy-is-ignored", handoffId: "h-1", ...payload },
  }) as never;

function setup(opts: { supervisors?: number; stillOffered?: boolean; active?: boolean } = {}) {
  const emit = vi.fn(async (_org: string, input: { eventType: string }) => ({
    alertId: "a",
    resolvedRecipientCount:
      input.eventType === "m36.handoff.supervisor_review" ? (opts.supervisors ?? 1) : 1,
  }));
  const stillOffered = vi.fn().mockResolvedValue(opts.stillOffered ?? true);
  const markNeedsAttention = vi.fn().mockResolvedValue(undefined);
  const isActiveUser = vi.fn().mockResolvedValue(opts.active ?? true);
  const consumer = buildM36HandoffNotificationsConsumer({
    alerts: { emit } as unknown as AlertEmitter,
    stillOffered,
    markNeedsAttention,
    isActiveUser,
  });
  return { emit, stillOffered, markNeedsAttention, isActiveUser, consumer };
}

const unaccepted = (id = "evt-1", cause = "expired") =>
  event(id, "m36.handoff.unaccepted", {
    fromUserId: "u-1",
    toUserId: "u-2",
    cause,
    unacceptedItemCount: 2,
    acceptedItemCount: 0,
  });

describe("M36 handoff notifications consumer", () => {
  it("subscribes to the three handoff events under its own name", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_HANDOFF_NOTIFICATION_CONSUMER);
    expect(consumer.consumerModule).toBe("m36");
    expect([...consumer.eventTypes].sort()).toEqual([
      "m36.handoff.accepted",
      "m36.handoff.offered",
      "m36.handoff.unaccepted",
    ]);
  });

  it("alerts the receiver of a still-offered handoff with fixed generic text", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(
      event("evt-1", "m36.handoff.offered", { fromUserId: "u-1", toUserId: "u-2" }),
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        eventType: "m36.handoff.offered",
        correlationId: "handoff:h-1:evt-1:m36.handoff.offered",
        payload: {
          toUserId: "u-2",
          handoffId: "h-1",
          message: HANDOFF_NOTIFICATION_TEXT.offered,
          deepLink: "/notifications?tab=handoffs",
        },
      }),
    );
  });

  it("does not alert for a stale offered event or an inactive receiver", async () => {
    const stale = setup({ stillOffered: false });
    await stale.consumer.handle(
      event("evt-1", "m36.handoff.offered", { fromUserId: "u-1", toUserId: "u-2" }),
    );
    const gone = setup({ active: false });
    await gone.consumer.handle(
      event("evt-1", "m36.handoff.offered", { fromUserId: "u-1", toUserId: "u-2" }),
    );
    expect(stale.emit).not.toHaveBeenCalled();
    expect(gone.emit).not.toHaveBeenCalled();
  });

  it("tells the sender a partial acceptance differently from a complete one", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(
      event("evt-1", "m36.handoff.accepted", {
        fromUserId: "u-1",
        toUserId: "u-2",
        acceptedItemCount: 1,
        pendingItemCount: 2,
      }),
    );
    await consumer.handle(
      event("evt-2", "m36.handoff.accepted", {
        fromUserId: "u-1",
        toUserId: "u-2",
        acceptedItemCount: 2,
        pendingItemCount: 0,
      }),
    );
    const messages = emit.mock.calls.map(
      (c) => (c[1] as unknown as { payload: { message: string } }).payload.message,
    );
    expect(messages).toEqual([
      HANDOFF_NOTIFICATION_TEXT.partlyAccepted,
      HANDOFF_NOTIFICATION_TEXT.accepted,
    ]);
  });

  it("alerts the sender and the supervisor audience when items go unaccepted", async () => {
    const { emit, markNeedsAttention, consumer } = setup();
    await consumer.handle(unaccepted());
    const types = emit.mock.calls.map((c) => (c[1] as { eventType: string }).eventType);
    expect(types).toEqual(["m36.handoff.unaccepted", "m36.handoff.supervisor_review"]);
    const supervisor = emit.mock.calls[1]?.[1] as unknown as { severity: string };
    expect(supervisor.severity).toBe("warn");
    expect(markNeedsAttention).not.toHaveBeenCalled();
  });

  it("records needs_attention and tells the sender when no supervisor can be reached", async () => {
    const { emit, markNeedsAttention, consumer } = setup({ supervisors: 0 });
    await consumer.handle(unaccepted());
    expect(markNeedsAttention).toHaveBeenCalledWith(ORG, "h-1");
    const types = emit.mock.calls.map((c) => (c[1] as { eventType: string }).eventType);
    expect(types).toEqual([
      "m36.handoff.unaccepted",
      "m36.handoff.supervisor_review",
      "m36.handoff.no_supervisor",
    ]);
  });

  it("still alerts supervisors but not the departed sender", async () => {
    const { emit, consumer } = setup({ active: false });
    await consumer.handle(unaccepted("evt-1", "sender_left"));
    const types = emit.mock.calls.map((c) => (c[1] as { eventType: string }).eventType);
    expect(types).toEqual(["m36.handoff.supervisor_review"]);
  });

  it("does not tell supervisors the patients stay with a sender who has left", async () => {
    const { emit, consumer } = setup({ active: false });
    await consumer.handle(unaccepted("evt-1", "sender_left"));
    const messages = emit.mock.calls.map(
      (c) => (c[1] as unknown as { payload: { message: string } }).payload.message,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toMatch(/stay with the sender/);
    expect(messages[0]).toMatch(/has left/);
  });

  it("uses distinct correlation ids for two unaccepted events of the same handoff", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(unaccepted("evt-1", "sender_left"));
    await consumer.handle(unaccepted("evt-2", "expired"));
    const ids = emit.mock.calls.map(
      (c) => (c[1] as unknown as { correlationId: string }).correlationId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("takes the tenant from the envelope and throws on a missing id so the dispatcher retries", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(unaccepted());
    expect(emit.mock.calls.every((c) => c[0] === ORG)).toBe(true);
    await expect(
      consumer.handle(event("evt-3", "m36.handoff.accepted", { toUserId: "u-2" })),
    ).rejects.toThrow(/missing/);
  });

  it("never puts a name, patient or item in any alert", async () => {
    const { emit, consumer } = setup({ supervisors: 0 });
    await consumer.handle(
      event("evt-1", "m36.handoff.unaccepted", {
        fromUserId: "u-1",
        toUserId: "u-2",
        cause: "declined",
        patientName: "Mrs Smith",
        patientId: "p-77",
      }),
    );
    const text = JSON.stringify(emit.mock.calls);
    expect(text).not.toContain("Smith");
    expect(text).not.toContain("p-77");
    expect(text).not.toMatch(/acknowledg/i);
  });
});
