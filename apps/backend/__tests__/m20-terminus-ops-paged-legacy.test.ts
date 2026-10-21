// chartwardenOpsPaged replaced wardenxOpsPaged; persisted outbox rows keep the legacy key forever.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/events-by-m20";

const schema = M20_OUTBOX_EVENTS.find(
  (e) => e.eventName === "m20.safety.sos_terminus_reached",
)!.payloadSchema;

const ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-08T12:00:00.000Z";
const base = {
  orgId: ID,
  providerEntityId: ID,
  occurredAt: AT,
  sosAlertId: ID,
  terminusReachedAt: AT,
  loopIteration: 0,
  emergencyContactCallInitiated: false,
  psapJurisdictionId: null,
};
const readOpsPaged = (p: { chartwardenOpsPaged?: boolean; wardenxOpsPaged?: boolean }) =>
  p.chartwardenOpsPaged ?? p.wardenxOpsPaged;

describe("sos_terminus_reached ops-paged field rename", () => {
  it("accepts a legacy row carrying only wardenxOpsPaged and reads it", () => {
    const legacy = { ...base, wardenxOpsPaged: true };
    expect(Value.Check(schema, legacy)).toBe(true);
    expect(readOpsPaged(legacy)).toBe(true);
  });

  it("accepts a new row carrying only chartwardenOpsPaged and reads it", () => {
    const next = { ...base, chartwardenOpsPaged: false };
    expect(Value.Check(schema, next)).toBe(true);
    expect(readOpsPaged(next)).toBe(false);
  });
});
