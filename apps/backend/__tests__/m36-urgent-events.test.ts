// WP 4.1 - the one urgent outbox event: catalogued, outbox-only, PHI-free, and the payload the publisher helper builds
// validates against the catalog schema (so the real catalog-validating publisher accepts it).
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import {
  M36_URGENT_MESSAGE_SENT,
  urgentSentPayload,
} from "../src/modules/36-messaging/urgent/urgent-events";

const U = "11111111-1111-4111-8111-111111111111";
const facts = {
  orgId: U,
  channelId: U,
  messageId: U,
  authorUserId: U,
  recipientUserId: U,
  at: new Date("2026-10-14T12:00:00.000Z"),
};
const entry = M36_OUTBOX_EVENTS.find((e) => e.eventName === M36_URGENT_MESSAGE_SENT);

describe("m36.message.urgent_sent outbox catalog entry", () => {
  it("is owned by m36, outbox-only and declares only the m36 consumer", () => {
    expect(entry).toMatchObject({
      moduleOwner: "m36",
      isOutboxOnly: true,
      declaredConsumers: ["m36"],
    });
  });

  it("the payload the helper builds validates against the catalog schema", () => {
    expect(Value.Check(entry?.payloadSchema as never, urgentSentPayload(facts))).toBe(true);
  });

  it("carries no patient, name or text key and rejects extra keys at the schema boundary", () => {
    const keys = Object.keys(
      (entry?.payloadSchema as unknown as { properties: object }).properties,
    );
    for (const forbidden of ["patientId", "patient_id", "text", "body", "displayName", "sbar"]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(
      Value.Check(entry?.payloadSchema as never, { ...urgentSentPayload(facts), patientId: U }),
    ).toBe(false);
  });
});
