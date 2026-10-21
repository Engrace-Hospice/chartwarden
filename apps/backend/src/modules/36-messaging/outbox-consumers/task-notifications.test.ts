import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  M36_TASK_NOTIFICATION_CONSUMER,
  TASK_NOTIFICATION_TEXT,
  buildM36TaskNotificationsConsumer,
} from "./task-notifications";

const ORG = "11111111-1111-4111-8111-111111111111";
const event = (eventType: string, payload: Record<string, unknown>) =>
  ({
    id: "evt-1",
    eventType,
    organizationId: ORG,
    payload: {
      organizationId: "attacker-copy-is-ignored",
      taskId: "task-1",
      channelId: "ch-1",
      ...payload,
    },
  }) as never;

function setup(canView = true) {
  const emit = vi.fn().mockResolvedValue({ alertId: "a", resolvedRecipientCount: 1 });
  const canViewChannel = vi.fn().mockResolvedValue(canView);
  const consumer = buildM36TaskNotificationsConsumer({
    alerts: { emit } as unknown as AlertEmitter,
    messaging: { canViewChannel },
  });
  return { emit, canViewChannel, consumer };
}

describe("M36 task notifications consumer", () => {
  it("subscribes to the three notifying task events under its own name", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_TASK_NOTIFICATION_CONSUMER);
    expect(consumer.consumerModule).toBe("m36");
    expect([...consumer.eventTypes].sort()).toEqual([
      "m36.task.created",
      "m36.task.needs_owner",
      "m36.task.reassigned",
    ]);
  });

  it("alerts the assignee of a new task after re-checking access, with fixed generic text", async () => {
    const { emit, canViewChannel, consumer } = setup();
    await consumer.handle(
      event("m36.task.created", {
        messageId: "m-1",
        assigneeUserId: "u-2",
        createdByUserId: "u-1",
      }),
    );
    expect(canViewChannel).toHaveBeenCalledWith(ORG, "u-2", "ch-1");
    expect(emit).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        eventType: "m36.task.created",
        severity: "info",
        correlationId: "task:task-1:evt-1:u-2",
        payload: {
          assigneeUserId: "u-2",
          channelId: "ch-1",
          messageId: "m-1",
          message: TASK_NOTIFICATION_TEXT.assigned,
          deepLink: "/notifications?tab=tasks",
        },
      }),
    );
  });

  it("alerts only the new assignee of a reassignment", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(
      event("m36.task.reassigned", { fromUserId: "u-1", toUserId: "u-3", source: "offboarding" }),
    );
    const [, alert] = emit.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(alert.payload.toUserId).toBe("u-3");
    expect(alert.payload.message).toBe(TASK_NOTIFICATION_TEXT.assigned);
  });

  it("tells the creator when a task needs a new owner", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(event("m36.task.needs_owner", { creatorUserId: "u-1" }));
    const [, alert] = emit.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(alert.payload).toMatchObject({
      creatorUserId: "u-1",
      message: TASK_NOTIFICATION_TEXT.needsOwner,
    });
  });

  it("does not alert a recipient who lost access to the channel", async () => {
    const { emit, consumer } = setup(false);
    await consumer.handle(
      event("m36.task.created", {
        messageId: "m-1",
        assigneeUserId: "u-2",
        createdByUserId: "u-1",
      }),
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not alert a user who assigned the task to themselves", async () => {
    const { emit, canViewChannel, consumer } = setup();
    await consumer.handle(
      event("m36.task.created", {
        messageId: "m-1",
        assigneeUserId: "u-1",
        createdByUserId: "u-1",
      }),
    );
    expect(canViewChannel).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("throws on a missing id so the dispatcher retries instead of dropping silently", async () => {
    const { consumer } = setup();
    await expect(consumer.handle(event("m36.task.created", { messageId: "m-1" }))).rejects.toThrow(
      /missing/,
    );
  });

  it("never puts names, patient or message text in the alert", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(
      event("m36.task.created", {
        messageId: "m-1",
        assigneeUserId: "u-2",
        createdByUserId: "u-1",
        patientName: "Mrs Smith",
        body: "MRN 123",
      }),
    );
    const text = JSON.stringify(emit.mock.calls);
    expect(text).not.toContain("Smith");
    expect(text).not.toContain("MRN");
  });
});
