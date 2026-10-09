// apps/backend/__tests__/m5-wristband-plan.test.ts -- GAP-020: the pure issue / void planner behind the M5
// wristband routes (the DB transaction around it is proven live in m5-patient-wristband.live.test.ts).
import { describe, expect, it } from "vitest";
import { planWristbandIssue, planWristbandVoid } from "../src/modules/05-patient/wristband-plan";

const gen = (generation: number, state: "active" | "superseded" | "voided" = "active") => ({
  generation,
  supersededAt: state === "superseded" ? new Date() : null,
  voidedAt: state === "voided" ? new Date() : null,
});

describe("planWristbandIssue", () => {
  it("first print: no generations, expects null, issues generation 1", () => {
    expect(
      planWristbandIssue({
        generations: [],
        expectedCurrentGeneration: null,
        reason: "first_issue",
      }),
    ).toEqual({ ok: true, nextGeneration: 1, supersedeGeneration: null });
  });

  it("reprint supersedes the active generation and numbers after the highest ever issued", () => {
    expect(
      planWristbandIssue({
        generations: [gen(1, "superseded"), gen(2, "voided"), gen(3)],
        expectedCurrentGeneration: 3,
        reason: "reprint_lost",
      }),
    ).toEqual({ ok: true, nextGeneration: 4, supersedeGeneration: 3 });
  });

  it("after a void with nothing active the caller expects null and nothing is superseded", () => {
    expect(
      planWristbandIssue({
        generations: [gen(1, "voided")],
        expectedCurrentGeneration: null,
        reason: "identity_correction",
      }),
    ).toEqual({ ok: true, nextGeneration: 2, supersedeGeneration: null });
  });

  it("a stale expectedCurrentGeneration is a conflict (double-click / two nurses cannot mint two bands)", () => {
    expect(
      planWristbandIssue({
        generations: [gen(1)],
        expectedCurrentGeneration: null,
        reason: "first_issue",
      }),
    ).toEqual({ ok: false, code: "WRISTBAND_GENERATION_CONFLICT", currentGeneration: 1 });
    expect(
      planWristbandIssue({
        generations: [gen(1, "superseded"), gen(2)],
        expectedCurrentGeneration: 1,
        reason: "reprint_damaged",
      }),
    ).toEqual({ ok: false, code: "WRISTBAND_GENERATION_CONFLICT", currentGeneration: 2 });
  });

  it("first_issue is only for a patient who never had a band; a reprint reason needs one", () => {
    expect(
      planWristbandIssue({
        generations: [],
        expectedCurrentGeneration: null,
        reason: "reprint_lost",
      }),
    ).toMatchObject({ ok: false, code: "WRISTBAND_REASON_INVALID" });
    expect(
      planWristbandIssue({
        generations: [gen(1)],
        expectedCurrentGeneration: 1,
        reason: "first_issue",
      }),
    ).toMatchObject({ ok: false, code: "WRISTBAND_REASON_INVALID" });
  });
});

describe("planWristbandVoid", () => {
  it("voids an active or superseded generation", () => {
    expect(planWristbandVoid({ generations: [gen(1)], generation: 1 })).toEqual({ ok: true });
    expect(planWristbandVoid({ generations: [gen(1, "superseded")], generation: 1 })).toEqual({
      ok: true,
    });
  });
  it("an unknown generation is not found; an already-voided one is a conflict", () => {
    expect(planWristbandVoid({ generations: [gen(1)], generation: 9 })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(planWristbandVoid({ generations: [gen(1, "voided")], generation: 1 })).toEqual({
      ok: false,
      code: "WRISTBAND_ALREADY_VOIDED",
    });
  });
});
