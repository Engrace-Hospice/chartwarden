import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../../../bootstrap/outbox-dispatcher";
import { buildM24MedicarePrimaryAckConsumer } from "./m24-medicare-primary-ack";

const event = (overrides: Partial<DispatchableOutboxEvent> = {}): DispatchableOutboxEvent => ({
  id: "event-1",
  organizationId: "11111111-1111-4111-8111-111111111111",
  eventType: "m23.claim.acknowledged",
  aggregateKind: "claim",
  aggregateId: "claim-1",
  payload: {
    claimId: "claim-1",
    acknowledgmentId: "ack-1",
    payerClaimControlNumber: "synthetic-pcn",
  },
  attemptCount: 1,
  createdAt: new Date("2026-11-19T00:00:00.000Z"),
  ...overrides,
});

describe("M24 Medicare-primary acknowledgment binding", () => {
  it("settles an ACK as evidence only and performs no write or readiness transition", async () => {
    const publish = vi.fn();
    const consumer = buildM24MedicarePrimaryAckConsumer({
      db: {} as never,
      outbox: { publish } as never,
    });

    await expect(consumer.handle(event())).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects an acknowledgment whose aggregate identity does not match its payload", async () => {
    const consumer = buildM24MedicarePrimaryAckConsumer({
      db: {} as never,
      outbox: { publish: vi.fn() } as never,
    });

    await expect(consumer.handle(event({ aggregateId: "other-claim" }))).rejects.toThrow(
      "event aggregate does not match claimId",
    );
  });
});
