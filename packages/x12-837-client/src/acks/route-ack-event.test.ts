import { describe, expect, it } from "vitest";
import type { AckEvent } from "../clearinghouse/types";
import { routeAckEvent } from "./route-ack-event";

const ev = (over: Partial<AckEvent>): AckEvent => ({
  eventId: "e1",
  stage: "payer",
  disposition: "accepted",
  controlNumber: "000000001",
  reasonCodes: [],
  occurredAt: "2026-10-09T12:00:00Z",
  ...over,
});

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

  it("fails closed on an unknown stage or disposition", () => {
    expect(() => routeAckEvent(ev({ stage: "bogus" as never }))).toThrow(/stage/);
    expect(() => routeAckEvent(ev({ disposition: "partial" as never }))).toThrow(/disposition/);
    expect(() => routeAckEvent(null as never)).toThrow();
  });
});
