// @chartwarden/emar — §2.11 D11 IV continuous administration — M13-T06. W-EMAR-10 (start → titrate → stop).
import { describe, expect, it } from "vitest";
import {
  IV_SESSION_GRAPH,
  type IvContinuousPolicy,
  type IvSegment,
  assertIvSegmentLegal,
  checkIvRateBounds,
  composeIvSession,
  deriveIvSessionState,
  planIvSegment,
} from "../src/iv";

const POLICY: IvContinuousPolicy = { minRate: 0.5, maxRate: 10 }; // W-EMAR-10 morphine drip bounds

describe("§2.11 deriveIvSessionState", () => {
  it("an empty sequence is the 'none' genesis state", () => {
    expect(deriveIvSessionState([])).toBe("none");
  });
  it("derives state from the last segment (start→running, pause→paused, stop→stopped)", () => {
    expect(
      deriveIvSessionState([
        { mode: "iv_continuous_start", administeredAt: "2026-06-22T00:00:00.000Z" },
      ]),
    ).toBe("running");
    expect(
      deriveIvSessionState([
        { mode: "iv_continuous_start", administeredAt: "2026-06-22T00:00:00.000Z" },
        { mode: "iv_continuous_pause", administeredAt: "2026-06-22T01:00:00.000Z" },
      ]),
    ).toBe("paused");
  });
});

describe("§2.11 assertIvSegmentLegal — the ordering graph", () => {
  it("only 'start' is legal at genesis", () => {
    expect(() => assertIvSegmentLegal("none", "iv_continuous_start")).not.toThrow();
    expect(() => assertIvSegmentLegal("none", "iv_continuous_rate_change")).toThrow(
      expect.objectContaining({ code: "ILLEGAL_IV_SESSION_TRANSITION" }),
    );
  });
  it("a stopped session is terminal — no further segment is legal", () => {
    expect(IV_SESSION_GRAPH.stopped).toEqual([]);
    expect(() => assertIvSegmentLegal("stopped", "iv_continuous_resume")).toThrow(
      expect.objectContaining({ code: "ILLEGAL_IV_SESSION_TRANSITION" }),
    );
  });
  it("resume is legal only from paused; pause/rate_change/stop only from running", () => {
    expect(() => assertIvSegmentLegal("paused", "iv_continuous_resume")).not.toThrow();
    expect(() => assertIvSegmentLegal("running", "iv_continuous_resume")).toThrow();
    expect(() => assertIvSegmentLegal("paused", "iv_continuous_rate_change")).toThrow();
  });
});

describe("§2.11 titration bounds", () => {
  it("accepts a rate inside [minRate, maxRate] inclusive", () => {
    expect(checkIvRateBounds(POLICY, 3).ok).toBe(true); // W-EMAR-10 titrate up to 3 mg/hr
    expect(checkIvRateBounds(POLICY, 0.5).ok).toBe(true);
    expect(checkIvRateBounds(POLICY, 10).ok).toBe(true);
  });
  it("rejects a rate outside the bounds and echoes them", () => {
    const r = checkIvRateBounds(POLICY, 12);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ minRate: 0.5, maxRate: 10 });
  });
});

describe("§2.11 D11 planIvSegment — W-EMAR-10", () => {
  it("start mints the session and (controlled) requires a witness", () => {
    const p = planIvSegment("none", { mode: "iv_continuous_start", isControlled: true });
    expect(p).toEqual({
      nextState: "running",
      mintsSession: true,
      requiresWitness: true,
      hasControlledWastage: false,
    });
  });
  it("rate_change validates the bounds and (controlled) requires a witness", () => {
    const p = planIvSegment("running", {
      mode: "iv_continuous_rate_change",
      isControlled: true,
      newRate: 3,
      policy: POLICY,
    });
    expect(p.nextState).toBe("running");
    expect(p.requiresWitness).toBe(true);
    expect(p.mintsSession).toBe(false);
  });
  it("rate_change out of range is rejected", () => {
    expect(() =>
      planIvSegment("running", {
        mode: "iv_continuous_rate_change",
        isControlled: true,
        newRate: 12,
        policy: POLICY,
      }),
    ).toThrow(expect.objectContaining({ code: "IV_RATE_OUT_OF_RANGE" }));
  });
  it("rate_change without bounds/new-rate is rejected", () => {
    expect(() =>
      planIvSegment("running", { mode: "iv_continuous_rate_change", isControlled: true }),
    ).toThrow(expect.objectContaining({ code: "IV_RATE_OUT_OF_RANGE" }));
  });
  it("a controlled stop with wastage drives the controlled_wasted flag", () => {
    const p = planIvSegment("running", {
      mode: "iv_continuous_stop",
      isControlled: true,
      wastageAmount: 87, // W-EMAR-10: ~87 mL wasted at stop
    });
    expect(p.nextState).toBe("stopped");
    expect(p.requiresWitness).toBe(true);
    expect(p.hasControlledWastage).toBe(true);
  });
  it("pause/resume on a non-controlled order require no witness and never waste", () => {
    const pause = planIvSegment("running", { mode: "iv_continuous_pause", isControlled: false });
    expect(pause).toMatchObject({
      nextState: "paused",
      requiresWitness: false,
      hasControlledWastage: false,
    });
    const resume = planIvSegment("paused", { mode: "iv_continuous_resume", isControlled: false });
    expect(resume.nextState).toBe("running");
  });
  it("an out-of-sequence segment is rejected before any bounds check", () => {
    expect(() => planIvSegment("none", { mode: "iv_continuous_stop", isControlled: true })).toThrow(
      expect.objectContaining({ code: "ILLEGAL_IV_SESSION_TRANSITION" }),
    );
  });
});

describe("§2.11 composeIvSession — the seam projection", () => {
  const SEGMENTS: IvSegment[] = [
    {
      mode: "iv_continuous_start",
      administeredAt: "2026-06-22T00:00:00.000Z",
      rate: 2,
      rateUnit: "mg/hr",
    },
    {
      mode: "iv_continuous_rate_change",
      administeredAt: "2026-06-22T06:00:00.000Z",
      rate: 3,
      rateUnit: "mg/hr",
    },
    { mode: "iv_continuous_stop", administeredAt: "2026-06-22T20:00:00.000Z" },
  ];
  it("composes the 3-row sequence into a closed session with effectivePeriod start/end", () => {
    const proj = composeIvSession("iv-1", "ord-mor", SEGMENTS, null);
    expect(proj.startedAt).toBe("2026-06-22T00:00:00.000Z");
    expect(proj.endedAt).toBe("2026-06-22T20:00:00.000Z");
    expect(proj.state).toBe("stopped");
    expect(proj.segments).toHaveLength(3);
    expect(proj.pumpVerifiedByMembershipId).toBeNull(); // Phase 1 — M37 column null
  });
  it("an open session has a null end", () => {
    const proj = composeIvSession("iv-1", "ord-mor", SEGMENTS.slice(0, 2), null);
    expect(proj.endedAt).toBeNull();
    expect(proj.state).toBe("running");
  });
  it("a sequence not beginning with start is rejected", () => {
    expect(() => composeIvSession("iv-1", "ord-mor", SEGMENTS.slice(1), null)).toThrow(
      expect.objectContaining({ code: "ILLEGAL_IV_SESSION_TRANSITION" }),
    );
  });
});
