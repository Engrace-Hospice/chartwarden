// WP 3.5 - the three handoff outbox events: catalogued, outbox-only, PHI-free, and the payloads handoff-events.ts builds
// validate against the catalog schemas (so the real catalog-validating publisher accepts them).
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import {
  type HandoffEventFacts,
  M36_HANDOFF_EVENTS,
  handoffEventPayload,
} from "../src/modules/36-messaging/handoffs/handoff-events";

const U = "11111111-1111-4111-8111-111111111111";
const AT = new Date("2026-10-14T12:00:00.000Z");
const base = { orgId: U, handoffId: U, fromUserId: U, toUserId: U, at: AT };

const FACTS: Record<keyof typeof M36_HANDOFF_EVENTS, HandoffEventFacts> = {
  offered: { ...base, kind: "offered", itemCount: 3, expiresAt: AT },
  accepted: { ...base, kind: "accepted", acceptedItemCount: 1, pendingItemCount: 2 },
  unaccepted: {
    ...base,
    kind: "unaccepted",
    cause: "expired",
    unacceptedItemCount: 2,
    acceptedItemCount: 1,
  },
};

const entry = (name: string) => M36_OUTBOX_EVENTS.find((e) => e.eventName === name);

describe("m36.handoff.* outbox catalog", () => {
  it("catalogues exactly the three handoff events, owned by m36, outbox-only, consumed by m36", () => {
    const names = M36_OUTBOX_EVENTS.map((e) => e.eventName).filter((n) =>
      n.startsWith("m36.handoff."),
    );
    expect(names.sort()).toEqual(Object.values(M36_HANDOFF_EVENTS).sort());
    for (const name of names) {
      expect(entry(name)).toMatchObject({
        moduleOwner: "m36",
        isOutboxOnly: true,
        declaredConsumers: ["m36"],
      });
    }
  });

  it.each(Object.entries(M36_HANDOFF_EVENTS))(
    "the %s payload built by handoff-events validates against its catalog schema",
    (kind, eventName) => {
      const payload = handoffEventPayload(FACTS[kind as keyof typeof FACTS]);
      expect(Value.Check(entry(eventName)?.payloadSchema as never, payload)).toBe(true);
    },
  );

  it.each(Object.values(M36_HANDOFF_EVENTS))(
    "%s schema carries no patient, item or free-text key",
    (eventName) => {
      const keys = Object.keys(
        (entry(eventName)?.payloadSchema as unknown as { properties: object }).properties,
      );
      for (const forbidden of [
        "patientId",
        "patient_id",
        "patientIds",
        "refId",
        "itemIds",
        "items",
        "note",
        "body",
        "reason",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    },
  );

  it("rejects an extra patientId at the schema boundary and an unknown cause", () => {
    const schema = entry("m36.handoff.unaccepted")?.payloadSchema as never;
    const payload = handoffEventPayload(FACTS.unaccepted);
    expect(Value.Check(schema, { ...payload, patientId: U })).toBe(false);
    expect(Value.Check(schema, { ...payload, cause: "because" })).toBe(false);
  });
});
