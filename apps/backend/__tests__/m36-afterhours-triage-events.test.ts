// ADR-0082 slice S1 - the id-only `m36.afterhours_triage.requested` catalog entry (frozen contract): aggregate message, four fields,
// no text, no extra key, consumed by M19 only.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";

const U = "11111111-1111-4111-8111-111111111111";
const valid = { messageId: U, requestId: U, patientId: U, occurredAt: "2026-10-19T12:00:00.000Z" };
const entry = M36_OUTBOX_EVENTS.find((e) => e.eventName === "m36.afterhours_triage.requested");
const check = (v: unknown) => Value.Check(entry?.payloadSchema as never, v);

describe("m36.afterhours_triage.requested catalog entry", () => {
  it("is owned by m36, outbox-only and declares only m19", () => {
    expect(entry).toMatchObject({
      moduleOwner: "m36",
      isOutboxOnly: true,
      declaredConsumers: ["m19"],
    });
  });

  it("accepts the frozen payload", () => {
    expect(check(valid)).toBe(true);
  });

  it("rejects any extra key, including text-bearing ones", () => {
    for (const extra of ["body", "text", "organizationId", "channelId", "anything"]) {
      expect(check({ ...valid, [extra]: "x" })).toBe(false);
    }
  });

  it.each(["messageId", "requestId", "patientId", "occurredAt"])("rejects a payload missing %s", (key) => {
    const { [key]: _omitted, ...rest } = valid as Record<string, string>;
    expect(check(rest)).toBe(false);
  });

  it("rejects non-uuid ids", () => {
    expect(check({ ...valid, patientId: "not-a-uuid" })).toBe(false);
  });
});
