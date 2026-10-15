// WP 3.7 - the m36.promotion.requested outbox event: catalogued, outbox-only, PHI-free, and the payload promotion-events.ts
// builds validates against the catalog schema (so the real catalog-validating publisher accepts it).
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import {
  M36_PROMOTION_EVENTS,
  promotionRequestedPayload,
} from "../src/modules/36-messaging/promotions/promotion-events";

const U = "11111111-1111-4111-8111-111111111111";
const AT = new Date("2026-10-14T12:00:00.000Z");
const entry = M36_OUTBOX_EVENTS.find((e) => e.eventName === M36_PROMOTION_EVENTS.requested);
const payload = promotionRequestedPayload({
  orgId: U,
  promotionRequestId: U,
  targetModule: "m8",
  targetKind: "encounter_addendum",
  requestedByUserId: U,
  at: AT,
});

describe("m36.promotion.requested outbox catalog", () => {
  it("is owned by m36, outbox-only and consumed by m36", () => {
    expect(entry).toMatchObject({
      moduleOwner: "m36",
      isOutboxOnly: true,
      declaredConsumers: ["m36"],
    });
  });

  it("accepts the payload promotion-events builds", () => {
    expect(Value.Check(entry?.payloadSchema as never, payload)).toBe(true);
  });

  it("carries no patient, message, hash or text key", () => {
    const keys = Object.keys(
      (entry?.payloadSchema as unknown as { properties: object }).properties,
    );
    for (const forbidden of [
      "patientId",
      "messageId",
      "channelId",
      "sha256",
      "bodySha256",
      "body",
      "text",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("rejects an extra patientId, an order target and an unknown module at the schema boundary", () => {
    const schema = entry?.payloadSchema as never;
    expect(Value.Check(schema, { ...payload, patientId: U })).toBe(false);
    expect(Value.Check(schema, { ...payload, targetModule: "m11" })).toBe(false);
    expect(Value.Check(schema, { ...payload, targetKind: "order" })).toBe(false);
  });
});
