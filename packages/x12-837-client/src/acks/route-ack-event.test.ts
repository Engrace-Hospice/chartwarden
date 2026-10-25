import { describe, expect, it } from "vitest";
import type { AckEvent } from "../clearinghouse/types";
import { routeAckEvent } from "./route-ack-event";

// Typed loosely on purpose: the runtime guards exist for vendor JSON the compiler never saw.
const ev = (over: Record<string, unknown>): AckEvent =>
  ({
    eventId: "e1",
    stage: "payer",
    disposition: "accepted",
    controlNumber: "000000001",
    reasonCodes: [],
    occurredAt: "2026-10-09T12:00:00Z",
    ...over,
  }) as AckEvent;

describe("routeAckEvent (ADR-0053 D2)", () => {
  it("routes a payer-stage accept through the 277CA edge", () => {
    expect(routeAckEvent(ev({}))).toEqual({
      kind: "ack_277ca",
      stage: "payer",
      outcome: "accepted",
    });
  });

  it("routes a clearinghouse-stage accept through the 999 edge so it can never reach ack_accepted", () => {
    expect(routeAckEvent(ev({ stage: "clearinghouse" }))).toEqual({
      kind: "ack_999",
      stage: "clearinghouse",
      outcome: "accepted",
    });
  });

  it("keeps the stage on rejections", () => {
    expect(routeAckEvent(ev({ stage: "clearinghouse", disposition: "rejected" }))).toEqual({
      kind: "ack_999",
      stage: "clearinghouse",
      outcome: "rejected",
    });
    expect(routeAckEvent(ev({ disposition: "rejected" })).kind).toBe("ack_277ca");
  });

  it("routes a payer-stage partial through the 277CA edge as a partial outcome", () => {
    expect(routeAckEvent(ev({ disposition: "partial", reasonCodes: ["A7"] }))).toEqual({
      kind: "ack_277ca",
      stage: "payer",
      outcome: "partial",
    });
  });

  it("refuses a clearinghouse-stage partial (a 999 is accepted or rejected)", () => {
    expect(() => routeAckEvent(ev({ stage: "clearinghouse", disposition: "partial" }))).toThrow(
      /payer-stage only/,
    );
  });

  it("fails closed on an unknown stage or disposition", () => {
    expect(() => routeAckEvent(ev({ stage: "bogus" }))).toThrow(/stage/);
    expect(() => routeAckEvent(ev({ disposition: "bogus" as never }))).toThrow(/disposition/);
    expect(() => routeAckEvent(null as never)).toThrow();
  });
});
