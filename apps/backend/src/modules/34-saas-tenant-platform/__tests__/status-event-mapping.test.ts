// The platform status route addresses a transition by TARGET status; the lifecycle machine is event-driven and
// several events share a target (active is reached by reactivate from suspended but resolveAtRisk from at_risk).
import { describe, expect, it } from "vitest";
import { lifecycleEventForStatus } from "../routes/platform/service-drizzle";

const REASON = "ops decision";

describe("lifecycleEventForStatus", () => {
  it.each([
    { from: "active", to: "suspended", type: "suspend" },
    { from: "suspended", to: "active", type: "reactivate" },
    { from: "active", to: "at_risk", type: "flagAtRisk" },
    { from: "at_risk", to: "active", type: "resolveAtRisk" },
    { from: "at_risk", to: "suspended", type: "suspendFromAtRisk" },
  ] as const)("$from → $to is a $type event", ({ from, to, type }) => {
    const event = lifecycleEventForStatus(from, to, REASON);

    expect(event.type).toBe(type);
    expect(event.transitionReason).toBe(REASON);
  });

  it("refuses a target no platform-ops event reaches", () => {
    expect(() => lifecycleEventForStatus("active", "destroyed", REASON)).toThrow(/no platform-ops/);
  });
});
