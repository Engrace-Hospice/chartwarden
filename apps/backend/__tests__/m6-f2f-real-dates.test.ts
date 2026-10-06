/**
 * F-226 — the F2F window is computed from the REAL encounter date against the REAL (expected) period start.
 * PURE unit tests for `certification/f2f-window.ts`, `checkF2fWindow`, the F2F state machine and the
 * `strict` adequacy basis. Boundaries are pinned on both sides of every edge of [start-30, start-1].
 */
import { describe, expect, it } from "vitest";
import {
  type AdequacyF2fFact,
  type AdequacyInput,
  evaluatePeriodAdequacy,
} from "../src/modules/06-admission/certification/adequacy";
import {
  F2F_MAX_ENCOUNTER_AGE_DAYS,
  assertPlausibleEncounterDate,
  expectedStartFromPriorEnd,
  resolveF2fWindowStart,
} from "../src/modules/06-admission/certification/f2f-window";
import { addCalendarDays } from "../src/modules/06-admission/certification/window-math";
import { electionPeriodScheduledEnd } from "../src/modules/06-admission/state-machines/election-period";
import type { AdmissionStateError } from "../src/modules/06-admission/state-machines/errors";
import { transitionFaceToFace } from "../src/modules/06-admission/state-machines/face-to-face";
import { checkF2fWindow } from "../src/modules/06-admission/state-machines/validation";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as AdmissionStateError).code;
  }
  return undefined;
};

describe("F-226 checkF2fWindow — boundaries against a real start", () => {
  const START = "2026-07-01";
  it.each([
    ["start-31", "2026-05-31", false],
    ["start-30", "2026-06-01", true],
    ["start-29", "2026-06-02", true],
    ["start-2", "2026-06-29", true],
    ["start-1", "2026-06-30", true],
    ["start (same day)", "2026-07-01", false],
    ["start+1", "2026-07-02", false],
  ])("%s", (_label, encounterDate, within) => {
    if (within) {
      expect(checkF2fWindow({ periodStart: START, encounterDate, hasOverride: false })).toEqual({
        withinWindow: true,
      });
    } else {
      expect(
        code(() => checkF2fWindow({ periodStart: START, encounterDate, hasOverride: false })),
      ).toBe("F2F_OUTSIDE_WINDOW");
      // with an override the completion proceeds and the HONEST verdict (false) is what is persisted
      expect(checkF2fWindow({ periodStart: START, encounterDate, hasOverride: true })).toEqual({
        withinWindow: false,
      });
    }
  });

  it("a leap-day span: start 2028-03-01 -> window [2028-01-31, 2028-02-29]", () => {
    expect(
      checkF2fWindow({ periodStart: "2028-03-01", encounterDate: "2028-02-29", hasOverride: false })
        .withinWindow,
    ).toBe(true);
    expect(
      checkF2fWindow({ periodStart: "2028-03-01", encounterDate: "2028-01-31", hasOverride: false })
        .withinWindow,
    ).toBe(true);
    expect(
      code(() =>
        checkF2fWindow({
          periodStart: "2028-03-01",
          encounterDate: "2028-01-30",
          hasOverride: false,
        }),
      ),
    ).toBe("F2F_OUTSIDE_WINDOW");
    // non-leap year: one day earlier edge
    expect(
      checkF2fWindow({ periodStart: "2027-03-01", encounterDate: "2027-01-30", hasOverride: false })
        .withinWindow,
    ).toBe(true);
    expect(
      code(() =>
        checkF2fWindow({
          periodStart: "2027-03-01",
          encounterDate: "2027-01-29",
          hasOverride: false,
        }),
      ),
    ).toBe("F2F_OUTSIDE_WINDOW");
  });

  it("year boundary and DST-change weeks use calendar days (no 23/25 hour drift)", () => {
    // US DST starts 2026-03-08 and ends 2026-11-01: a window straddling either must still be exactly 30 days.
    expect(
      checkF2fWindow({ periodStart: "2026-03-20", encounterDate: "2026-02-18", hasOverride: false })
        .withinWindow,
    ).toBe(true);
    expect(
      code(() =>
        checkF2fWindow({
          periodStart: "2026-03-20",
          encounterDate: "2026-02-17",
          hasOverride: false,
        }),
      ),
    ).toBe("F2F_OUTSIDE_WINDOW");
    expect(
      checkF2fWindow({ periodStart: "2026-11-15", encounterDate: "2026-10-16", hasOverride: false })
        .withinWindow,
    ).toBe(true);
    expect(
      code(() =>
        checkF2fWindow({
          periodStart: "2026-11-15",
          encounterDate: "2026-10-15",
          hasOverride: false,
        }),
      ),
    ).toBe("F2F_OUTSIDE_WINDOW");
    expect(
      checkF2fWindow({ periodStart: "2027-01-05", encounterDate: "2026-12-06", hasOverride: false })
        .withinWindow,
    ).toBe(true);
    expect(
      code(() =>
        checkF2fWindow({
          periodStart: "2027-01-05",
          encounterDate: "2026-12-05",
          hasOverride: false,
        }),
      ),
    ).toBe("F2F_OUTSIDE_WINDOW");
  });

  it("an undeterminable start is unverifiable: refused, or unverified (null) under an override", () => {
    expect(
      code(() =>
        checkF2fWindow({ periodStart: null, encounterDate: "2026-06-15", hasOverride: false }),
      ),
    ).toBe("F2F_PERIOD_START_UNKNOWN");
    expect(
      checkF2fWindow({ periodStart: null, encounterDate: "2026-06-15", hasOverride: true }),
    ).toEqual({
      withinWindow: null,
    });
  });
});

describe("F-226 expected start = previous period end + 1 (90/90/60 contiguity)", () => {
  it("sequence 1 (90d) -> 2 (90d) -> 3 (60d) -> 4 (60d) chain contiguously from an election start", () => {
    const e1 = electionPeriodScheduledEnd("2026-01-01", "ninety_day");
    expect(e1).toBe("2026-03-31");
    const s2 = expectedStartFromPriorEnd(e1);
    expect(s2).toBe("2026-04-01");
    const e2 = electionPeriodScheduledEnd(s2 as string, "ninety_day");
    expect(e2).toBe("2026-06-29");
    const s3 = expectedStartFromPriorEnd(e2);
    expect(s3).toBe("2026-06-30");
    const e3 = electionPeriodScheduledEnd(s3 as string, "sixty_day");
    expect(e3).toBe("2026-08-28");
    const s4 = expectedStartFromPriorEnd(e3);
    expect(s4).toBe("2026-08-29");
    // the F2F window for period 3 is [2026-05-31, 2026-06-29]: the LAST day of period 2 is in, its first day of 3 is out
    expect(
      checkF2fWindow({ periodStart: s3 as string, encounterDate: "2026-06-29", hasOverride: false })
        .withinWindow,
    ).toBe(true);
    expect(
      code(() =>
        checkF2fWindow({
          periodStart: s3 as string,
          encounterDate: "2026-06-30",
          hasOverride: false,
        }),
      ),
    ).toBe("F2F_OUTSIDE_WINDOW");
  });

  it("crosses a leap day and a year end", () => {
    expect(expectedStartFromPriorEnd("2028-02-28")).toBe("2028-02-29");
    expect(expectedStartFromPriorEnd("2028-02-29")).toBe("2028-03-01");
    expect(expectedStartFromPriorEnd("2026-12-31")).toBe("2027-01-01");
  });

  it("null in -> null out", () => {
    expect(expectedStartFromPriorEnd(null)).toBeNull();
  });
});

describe("F-226 resolveF2fWindowStart — order of authority", () => {
  it("stored expected_start wins", () => {
    expect(
      resolveF2fWindowStart({
        expectedStart: "2026-07-01",
        priorScheduledEnd: "2026-06-10",
        effectiveAt: "2026-06-20",
      }),
    ).toEqual({ start: "2026-07-01", source: "expected_start" });
  });
  it("else the preceding period's end + 1 (legacy pending period)", () => {
    expect(
      resolveF2fWindowStart({
        expectedStart: null,
        priorScheduledEnd: "2026-06-10",
        effectiveAt: null,
      }),
    ).toEqual({
      start: "2026-06-11",
      source: "prior_period_end",
    });
  });
  it("else the period's own effective_at (activated period)", () => {
    expect(
      resolveF2fWindowStart({
        expectedStart: null,
        priorScheduledEnd: null,
        effectiveAt: "2026-06-20",
      }),
    ).toEqual({
      start: "2026-06-20",
      source: "effective_at",
    });
  });
  it("else unknown", () => {
    expect(
      resolveF2fWindowStart({ expectedStart: null, priorScheduledEnd: null, effectiveAt: null }),
    ).toBeNull();
  });
});

describe("F-226 assertPlausibleEncounterDate", () => {
  const TODAY = "2026-09-30";
  it("today and the past pass", () => {
    expect(code(() => assertPlausibleEncounterDate("2026-09-30", TODAY))).toBeUndefined();
    expect(code(() => assertPlausibleEncounterDate("2026-09-01", TODAY))).toBeUndefined();
  });
  it("tomorrow is refused", () => {
    expect(code(() => assertPlausibleEncounterDate("2026-10-01", TODAY))).toBe(
      "F2F_ENCOUNTER_DATE_INVALID",
    );
  });
  it("exactly 365 days back passes, 366 is refused", () => {
    expect(F2F_MAX_ENCOUNTER_AGE_DAYS).toBe(365);
    expect(
      code(() => assertPlausibleEncounterDate(addCalendarDays(TODAY, -365), TODAY)),
    ).toBeUndefined();
    expect(code(() => assertPlausibleEncounterDate(addCalendarDays(TODAY, -366), TODAY))).toBe(
      "F2F_ENCOUNTER_DATE_INVALID",
    );
  });
  it("malformed / impossible dates are refused", () => {
    expect(code(() => assertPlausibleEncounterDate("2026-13-40", TODAY))).toBe(
      "F2F_ENCOUNTER_DATE_INVALID",
    );
    expect(code(() => assertPlausibleEncounterDate("yesterday", TODAY))).toBe(
      "F2F_ENCOUNTER_DATE_INVALID",
    );
    expect(code(() => assertPlausibleEncounterDate("", TODAY))).toBe("F2F_ENCOUNTER_DATE_INVALID");
  });
});

describe("F-226 F2F state machine", () => {
  const base = {
    type: "recordCompletion",
    performerRole: "hospice_md",
    encounterLocation: "patient_home",
    telehealthEligibility: null,
  } as const;
  it("records the honest verdict as the set_flag effect (true / false / unknown)", () => {
    const flag = (periodStart: string | null, encounterDate: string, hasOverride: boolean) =>
      transitionFaceToFace("scheduled", {
        ...base,
        periodStart,
        encounterDate,
        hasOverride,
      }).effects.find((e) => e.kind === "set_flag");
    expect(flag("2026-07-01", "2026-06-15", false)).toMatchObject({ field: "within_window_true" });
    expect(flag("2026-07-01", "2026-07-01", true)).toMatchObject({ field: "within_window_false" });
    expect(flag(null, "2026-06-15", true)).toMatchObject({ field: "within_window_unknown" });
  });
  it("same-day completion without override is refused (R-F2F-02)", () => {
    expect(
      code(() =>
        transitionFaceToFace("scheduled", {
          ...base,
          periodStart: "2026-07-01",
          encounterDate: "2026-07-01",
          hasOverride: false,
        }),
      ),
    ).toBe("F2F_OUTSIDE_WINDOW");
  });
  it("a window override is legal from `scheduled` (so it can precede an outside-window completion) and from `completed`", () => {
    const reason = "Patient hospitalised; the visit could not be done inside the window.";
    expect(
      transitionFaceToFace("scheduled", {
        type: "requestWindowOverride",
        isMedicalDirector: true,
        reason,
      }).to,
    ).toBe("scheduled");
    expect(
      transitionFaceToFace("completed", {
        type: "requestWindowOverride",
        isMedicalDirector: true,
        reason,
      }).to,
    ).toBe("completed");
    expect(
      code(() =>
        transitionFaceToFace("attested", {
          type: "requestWindowOverride",
          isMedicalDirector: true,
          reason,
        }),
      ),
    ).toBe("ILLEGAL_TRANSITION");
    expect(
      code(() =>
        transitionFaceToFace("scheduled", {
          type: "requestWindowOverride",
          isMedicalDirector: true,
          reason: "short",
        }),
      ),
    ).toBe("F2F_OVERRIDE_REASON_TOO_SHORT");
  });
});

describe("F-226 adequacy — the `strict` basis (what the activation gate uses)", () => {
  const PERIOD = "pppppppp-0000-4000-8000-000000000001";
  const MD = "mmmmmmmm-0000-4000-8000-000000000001";
  const EXPECTED_START = "2026-07-01";
  const ACTIVATION_DAY = "2026-06-20"; // the day `setActive` would stamp - NOT the window anchor
  const f2f = (o: Partial<AdequacyF2fFact> = {}): AdequacyF2fFact => ({
    electionPeriodId: PERIOD,
    status: "attested",
    performerRole: "hospice_np",
    encounterDate: "2026-06-15",
    withinWindow: true,
    windowOverride: false,
    windowOverrideReason: null,
    windowOverrideBy: null,
    attestationSignedAt: "2026-06-16T18:00:00.000Z",
    ...o,
  });
  const run = (
    f: Partial<AdequacyF2fFact>,
    start: string | null | undefined = EXPECTED_START,
    seq = 3,
  ) => {
    const input: AdequacyInput = {
      period: {
        electionPeriodId: PERIOD,
        sequenceNumber: seq,
        periodKind: seq <= 2 ? "ninety_day" : "sixty_day",
        startDate: ACTIVATION_DAY,
        ...(start === undefined ? {} : { f2fWindowStart: start }),
      },
      admissionHospicePhysicianId: MD,
      timeZone: "America/Los_Angeles",
      windowBasis: "strict",
      ctis: [
        {
          electionPeriodId: PERIOD,
          status: "signed",
          hospiceMdId: MD,
          hospiceMdSignedAt: "2026-06-20T18:00:00.000Z",
          attendingMdId: null,
          attendingMdSignedAt: null,
          narrative: "n".repeat(200),
          signedLate: false,
          lateReason: null,
        },
      ],
      f2fs: [f2f(f)],
    };
    return evaluatePeriodAdequacy(input).f2f.reasonCodes;
  };

  it("in window + persisted true -> adequate", () => {
    expect(run({})).toEqual([]);
  });
  it.each([
    ["start-31", "2026-05-31", ["F2F_OUTSIDE_WINDOW"]],
    ["start-30", "2026-06-01", []],
    ["start-1", "2026-06-30", []],
    ["start", "2026-07-01", ["F2F_OUTSIDE_WINDOW"]],
    ["start+1", "2026-07-02", ["F2F_OUTSIDE_WINDOW"]],
  ])(
    "encounter at %s (persisted flag true - the F-217 bug shape)",
    (_l, encounterDate, expected) => {
      expect(run({ encounterDate })).toEqual(expected);
    },
  );
  it("anchors to the expected start, not the activation day (window would differ)", () => {
    // 2026-06-01 is start-30 of the expected start but only start-19 of... (activation day 06-20 -> window [05-21, 06-19]);
    // 2026-06-25 is inside the expected-start window yet AFTER the activation-day window end.
    expect(run({ encounterDate: "2026-06-25" })).toEqual([]);
  });
  it("persisted false but recomputed inside -> disagreement, unverified", () => {
    expect(run({ withinWindow: false })).toEqual(["F2F_WINDOW_UNVERIFIED"]);
  });
  it("persisted NULL fails closed even when the dates are inside", () => {
    expect(run({ withinWindow: null })).toEqual(["F2F_WINDOW_UNVERIFIED"]);
  });
  it("missing encounter date fails closed", () => {
    expect(run({ encounterDate: null })).toEqual(["F2F_ENCOUNTER_DATE_MISSING"]);
  });
  it("an undeterminable start (null) fails closed; undefined falls back to startDate", () => {
    expect(run({}, null)).toEqual(["F2F_WINDOW_UNVERIFIED"]);
    // startDate 2026-06-20: encounter 06-15 is 5 days before -> inside
    expect(run({}, undefined)).toEqual([]);
  });
  it("a valid override still passes (flagged) regardless of the dates", () => {
    const r = evaluatePeriodAdequacy({
      period: {
        electionPeriodId: PERIOD,
        sequenceNumber: 3,
        periodKind: "sixty_day",
        startDate: ACTIVATION_DAY,
        f2fWindowStart: EXPECTED_START,
      },
      admissionHospicePhysicianId: MD,
      timeZone: "America/Los_Angeles",
      windowBasis: "strict",
      ctis: [],
      f2fs: [
        f2f({
          encounterDate: "2026-07-01",
          withinWindow: false,
          windowOverride: true,
          windowOverrideReason: "Patient hospitalised; visit done the day the period began.",
          windowOverrideBy: MD,
        }),
      ],
    });
    expect(r.f2f.reasonCodes).toEqual([]);
    expect(r.flags).toContain("F2F_WINDOW_OVERRIDDEN");
  });
  it("sequences 1 and 2 need no F2F at all", () => {
    expect(run({ encounterDate: "2020-01-01", withinWindow: null }, null, 2)).toEqual([]);
  });
  it("the `recorded` and `dates` bases keep their F-217 behaviour", () => {
    const mk = (windowBasis: "recorded" | "dates", o: Partial<AdequacyF2fFact>) =>
      evaluatePeriodAdequacy({
        period: {
          electionPeriodId: PERIOD,
          sequenceNumber: 3,
          periodKind: "sixty_day",
          startDate: EXPECTED_START,
        },
        admissionHospicePhysicianId: MD,
        timeZone: "America/Los_Angeles",
        windowBasis,
        ctis: [],
        f2fs: [f2f(o)],
      }).f2f.reasonCodes;
    expect(mk("recorded", { withinWindow: true, encounterDate: "2020-01-01" })).toEqual([]);
    expect(mk("recorded", { withinWindow: null })).toEqual(["F2F_WINDOW_UNVERIFIED"]);
    expect(mk("dates", { withinWindow: null })).toEqual([]);
    expect(mk("dates", { encounterDate: "2026-07-01" })).toEqual(["F2F_OUTSIDE_WINDOW"]);
  });
});
