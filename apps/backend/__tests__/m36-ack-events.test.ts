// WP 4.2 - the five acknowledgment-request outbox events: catalogued, outbox-only, PHI-free, and the payload the publisher helper
// builds validates against the catalog schema (so the real catalog-validating publisher accepts it).
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  M36_ACK_ACKNOWLEDGED,
  M36_ACK_CANCELLED,
  M36_ACK_REASSIGNED,
  M36_ACK_REQUESTED,
  M36_ACK_RESOLVED,
  ackEventPayload,
} from "../src/modules/36-messaging/ack-requests/ack-events";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";

const U = "11111111-1111-4111-8111-111111111111";
const facts = {
  orgId: U,
  requestId: U,
  messageId: U,
  channelId: U,
  ackClass: "important" as const,
  assignedUserId: U,
  actorUserId: U,
  version: 3,
  at: new Date("2026-10-15T12:00:00.000Z"),
};
const NAMES = [
  M36_ACK_REQUESTED,
  M36_ACK_ACKNOWLEDGED,
  M36_ACK_REASSIGNED,
  M36_ACK_RESOLVED,
  M36_ACK_CANCELLED,
];
const entryOf = (name: string) => M36_OUTBOX_EVENTS.find((e) => e.eventName === name);

describe.each(NAMES)("%s outbox catalog entry", (name) => {
  it("is owned by m36 and outbox-only", () => {
    expect(entryOf(name)).toMatchObject({ moduleOwner: "m36", isOutboxOnly: true });
  });

  it("the payload the helper builds validates against the catalog schema", () => {
    const payload =
      name === M36_ACK_REASSIGNED
        ? { ...ackEventPayload(facts), previousAssignedUserId: U }
        : ackEventPayload(facts);
    expect(Value.Check(entryOf(name)?.payloadSchema as never, payload)).toBe(true);
  });

  it("carries no patient, name or text key and rejects extra keys at the schema boundary", () => {
    const keys = Object.keys(
      (entryOf(name)?.payloadSchema as unknown as { properties: object }).properties,
    );
    for (const forbidden of ["patientId", "patient_id", "text", "body", "displayName", "sbar"]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(
      Value.Check(entryOf(name)?.payloadSchema as never, {
        ...ackEventPayload(facts),
        patientId: U,
      }),
    ).toBe(false);
  });
});

describe("consumers", () => {
  it("only requested and reassigned declare the m36 notification consumer; the rest have none yet", () => {
    expect(entryOf(M36_ACK_REQUESTED)?.declaredConsumers).toEqual(["m36"]);
    expect(entryOf(M36_ACK_REASSIGNED)?.declaredConsumers).toEqual(["m36"]);
    for (const name of [M36_ACK_ACKNOWLEDGED, M36_ACK_RESOLVED, M36_ACK_CANCELLED]) {
      expect(entryOf(name)?.declaredConsumers).toEqual([]);
    }
  });

  it("the payload never carries the patient even if the facts did", () => {
    const payload = ackEventPayload({ ...facts, ackClass: "urgent" });
    expect(JSON.stringify(payload)).not.toMatch(/patient/i);
  });
});
