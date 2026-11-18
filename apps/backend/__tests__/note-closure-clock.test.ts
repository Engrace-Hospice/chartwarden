// apps/backend/__tests__/note-closure-clock.test.ts — visit-note 24h closure clock (slice 1).
//
// The pure clock: from the clinician's arrival (`clockStartedAt`) a note is `ok` until T-6h, `at_risk`
// from T-6h, `overdue` from T and `escalated` from T+12h. `enforceFrom` (set when a tenant moves to
// `block`) pushes only the BLOCK instant out, never the alert stage. No DB, no clock reads: every
// instant is injected, so each boundary is walked with a fixed `asOf`.
import { describe, expect, it } from "vitest";
import {
  AT_RISK_LEAD_HOURS,
  ESCALATION_LAG_HOURS,
  type NoteClosureAlertStage,
  type NoteClosureDecision,
  type NoteClosureStage,
  closureVerdict,
  decideNoteClosure,
  stageBeginsAt,
} from "../src/modules/08-encounters/closure/note-clock";

const DEFAULT_THRESHOLD_HOURS = 24;
const MS_PER_HOUR = 3_600_000;
const CLOCK_START = new Date("2026-03-10T12:00:00.000Z");

/** The instant `hours` after the fixture clock start (negative = before). */
function hoursAfterStart(hours: number): Date {
  return new Date(CLOCK_START.getTime() + hours * MS_PER_HOUR);
}

/** Decide at `elapsedHours` after the clock start with the 24h default unless overridden. */
function decideAt(
  elapsedHours: number,
  overrides: {
    readonly thresholdHours?: number;
    readonly enforceFrom?: Date | null;
  } = {},
): NoteClosureDecision {
  return decideNoteClosure({
    clockStartedAt: CLOCK_START,
    asOf: hoursAfterStart(elapsedHours),
    thresholdHours: overrides.thresholdHours ?? DEFAULT_THRESHOLD_HOURS,
    enforceFrom: overrides.enforceFrom ?? null,
  });
}

describe("stage offsets", () => {
  it("pins the alert offsets: at-risk 6h before the threshold, escalation 12h after", () => {
    expect(AT_RISK_LEAD_HOURS).toBe(6);
    expect(ESCALATION_LAG_HOURS).toBe(12);
  });
});

describe("decideNoteClosure stages (24h default)", () => {
  it.each<[number, NoteClosureStage]>([
    [0, "ok"],
    [17.99, "ok"],
    [18, "at_risk"],
    [23.99, "at_risk"],
    [24, "overdue"],
    [35.99, "overdue"],
    [36, "escalated"],
    [1000, "escalated"],
  ])("at %sh elapsed the stage is %s", (elapsedHours, expectedStage) => {
    expect(decideAt(elapsedHours).stage).toBe(expectedStage);
  });

  it("treats an asOf before the clock start (device skew) as ok with nothing overdue", () => {
    const decision = decideAt(-3);

    expect(decision.stage).toBe("ok");
    expect(decision.hoursOverdue).toBe(0);
  });
});

describe("decideNoteClosure non-default thresholds", () => {
  it.each<[number, NoteClosureStage]>([
    [5.99, "ok"],
    [6, "at_risk"],
    [11.99, "at_risk"],
    [12, "overdue"],
    [23.99, "overdue"],
    [24, "escalated"],
  ])("with a 12h threshold, %sh elapsed is %s", (elapsedHours, expectedStage) => {
    expect(decideAt(elapsedHours, { thresholdHours: 12 }).stage).toBe(expectedStage);
  });

  it.each<[number, NoteClosureStage]>([
    [161.99, "ok"],
    [162, "at_risk"],
    [167.99, "at_risk"],
    [168, "overdue"],
    [179.99, "overdue"],
    [180, "escalated"],
  ])("with a 168h threshold, %sh elapsed is %s", (elapsedHours, expectedStage) => {
    expect(decideAt(elapsedHours, { thresholdHours: 168 }).stage).toBe(expectedStage);
  });

  it("moves the deadline with the threshold", () => {
    expect(decideAt(0, { thresholdHours: 12 }).deadlineAt).toEqual(hoursAfterStart(12));
    expect(decideAt(0, { thresholdHours: 168 }).deadlineAt).toEqual(hoursAfterStart(168));
  });
});

describe("decideNoteClosure deadline and hours overdue", () => {
  it("sets deadlineAt to clockStartedAt plus the threshold", () => {
    expect(decideAt(5).deadlineAt).toEqual(hoursAfterStart(24));
  });

  it("reports zero hours overdue before the deadline", () => {
    expect(decideAt(20).hoursOverdue).toBe(0);
    expect(decideAt(23.99).hoursOverdue).toBe(0);
  });

  it("reports hours past the deadline once overdue", () => {
    expect(decideAt(24).hoursOverdue).toBe(0);
    expect(decideAt(30).hoursOverdue).toBe(6);
    expect(decideAt(36).hoursOverdue).toBe(12);
    expect(decideAt(48.5).hoursOverdue).toBe(24.5);
  });
});

describe("decideNoteClosure enforceFrom", () => {
  it("defaults blockFrom to the deadline when enforceFrom is null or undefined", () => {
    const withNull = decideAt(0, { enforceFrom: null });
    const withUndefined = decideNoteClosure({
      clockStartedAt: CLOCK_START,
      asOf: hoursAfterStart(0),
      thresholdHours: DEFAULT_THRESHOLD_HOURS,
      enforceFrom: undefined,
    });

    expect(withNull.blockFrom).toEqual(hoursAfterStart(24));
    expect(withUndefined.blockFrom).toEqual(hoursAfterStart(24));
  });

  it("moves blockFrom to enforceFrom plus the threshold when enforceFrom is later than the clock start", () => {
    const decision = decideAt(0, { enforceFrom: hoursAfterStart(30) });

    expect(decision.blockFrom).toEqual(hoursAfterStart(54));
  });

  it("does not move the deadline or the alert stage when enforceFrom is later", () => {
    const decision = decideAt(40, { enforceFrom: hoursAfterStart(30) });

    expect(decision.deadlineAt).toEqual(hoursAfterStart(24));
    expect(decision.stage).toBe("escalated");
    expect(decision.hoursOverdue).toBe(16);
    expect(decision.blockFrom).toEqual(hoursAfterStart(54));
  });

  it("ignores an enforceFrom earlier than the clock start", () => {
    const decision = decideAt(0, { enforceFrom: hoursAfterStart(-10) });

    expect(decision.blockFrom).toEqual(hoursAfterStart(24));
  });

  it("treats enforceFrom equal to the clock start as no grace", () => {
    const decision = decideAt(0, { enforceFrom: CLOCK_START });

    expect(decision.blockFrom).toEqual(hoursAfterStart(24));
  });
});

describe("decideNoteClosure null clock (legacy note)", () => {
  it("returns ok with no deadline and no block instant, however late asOf is", () => {
    const decision = decideNoteClosure({
      clockStartedAt: null,
      asOf: hoursAfterStart(10_000),
      thresholdHours: DEFAULT_THRESHOLD_HOURS,
      enforceFrom: hoursAfterStart(-5),
    });

    expect(decision).toEqual({
      stage: "ok",
      deadlineAt: null,
      hoursOverdue: 0,
      blockFrom: null,
    });
  });
});

describe("decideNoteClosure input validation", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a threshold of %s hours",
    (thresholdHours) => {
      expect(() => decideAt(1, { thresholdHours })).toThrow(RangeError);
    },
  );

  it("rejects an invalid asOf instead of failing open to ok", () => {
    expect(() =>
      decideNoteClosure({
        clockStartedAt: CLOCK_START,
        asOf: new Date("not a date"),
        thresholdHours: DEFAULT_THRESHOLD_HOURS,
        enforceFrom: null,
      }),
    ).toThrow(RangeError);
  });

  it("rejects an invalid clockStartedAt instead of failing open to ok", () => {
    expect(() =>
      decideNoteClosure({
        clockStartedAt: new Date("not a date"),
        asOf: CLOCK_START,
        thresholdHours: DEFAULT_THRESHOLD_HOURS,
        enforceFrom: null,
      }),
    ).toThrow(RangeError);
  });

  it("does not mutate its inputs and returns fresh Date instances", () => {
    const clockStartedAt = new Date(CLOCK_START.getTime());
    const asOf = hoursAfterStart(30);
    const enforceFrom = hoursAfterStart(10);

    const decision = decideNoteClosure({
      clockStartedAt,
      asOf,
      thresholdHours: DEFAULT_THRESHOLD_HOURS,
      enforceFrom,
    });

    expect(clockStartedAt.getTime()).toBe(CLOCK_START.getTime());
    expect(asOf.getTime()).toBe(hoursAfterStart(30).getTime());
    expect(enforceFrom.getTime()).toBe(hoursAfterStart(10).getTime());
    expect(decision.deadlineAt).not.toBe(clockStartedAt);
    expect(decision.blockFrom).not.toBe(enforceFrom);
  });
});

describe("closureVerdict", () => {
  const OVERRIDE_ACTIVE = true;
  const NO_OVERRIDE = false;

  describe("mode off", () => {
    it.each<[number, NoteClosureStage]>([
      [0, "ok"],
      [20, "at_risk"],
      [30, "overdue"],
      [40, "escalated"],
    ])("is clear at %sh (%s) with or without an override", (elapsedHours) => {
      const decision = decideAt(elapsedHours);
      const asOf = hoursAfterStart(elapsedHours);

      expect(closureVerdict("off", decision, NO_OVERRIDE, asOf)).toBe("clear");
      expect(closureVerdict("off", decision, OVERRIDE_ACTIVE, asOf)).toBe("clear");
    });
  });

  describe("mode warn", () => {
    it.each<[number, NoteClosureStage, "clear" | "warn"]>([
      [0, "ok", "clear"],
      [20, "at_risk", "clear"],
      [30, "overdue", "warn"],
      [40, "escalated", "warn"],
    ])("at %sh (%s) the verdict is %s and never blocked", (elapsedHours, _stage, expected) => {
      const decision = decideAt(elapsedHours);
      const asOf = hoursAfterStart(elapsedHours);

      expect(closureVerdict("warn", decision, NO_OVERRIDE, asOf)).toBe(expected);
      expect(closureVerdict("warn", decision, OVERRIDE_ACTIVE, asOf)).toBe(expected);
    });
  });

  describe("mode block", () => {
    it("is clear while ok and while at risk", () => {
      expect(closureVerdict("block", decideAt(0), NO_OVERRIDE, hoursAfterStart(0))).toBe("clear");
      expect(closureVerdict("block", decideAt(20), NO_OVERRIDE, hoursAfterStart(20))).toBe("clear");
    });

    it("is blocked when overdue and when escalated, with no override", () => {
      expect(closureVerdict("block", decideAt(24), NO_OVERRIDE, hoursAfterStart(24))).toBe(
        "blocked",
      );
      expect(closureVerdict("block", decideAt(30), NO_OVERRIDE, hoursAfterStart(30))).toBe(
        "blocked",
      );
      expect(closureVerdict("block", decideAt(40), NO_OVERRIDE, hoursAfterStart(40))).toBe(
        "blocked",
      );
    });

    it("blocks exactly at blockFrom and not a millisecond before", () => {
      const decision = decideAt(0);
      const atBlockFrom = hoursAfterStart(24);
      const justBefore = new Date(atBlockFrom.getTime() - 1);

      expect(closureVerdict("block", decision, NO_OVERRIDE, atBlockFrom)).toBe("blocked");
      expect(closureVerdict("block", decision, NO_OVERRIDE, justBefore)).toBe("clear");
    });

    it("downgrades to warn when an override is active (the note is still overdue)", () => {
      expect(closureVerdict("block", decideAt(30), OVERRIDE_ACTIVE, hoursAfterStart(30))).toBe(
        "warn",
      );
      expect(closureVerdict("block", decideAt(40), OVERRIDE_ACTIVE, hoursAfterStart(40))).toBe(
        "warn",
      );
    });

    it("warns but does not block an overdue note inside the enforceFrom grace window", () => {
      const enforceFrom = hoursAfterStart(30);
      const decision = decideAt(40, { enforceFrom });

      expect(closureVerdict("block", decision, NO_OVERRIDE, hoursAfterStart(40))).toBe("warn");
      expect(closureVerdict("block", decision, NO_OVERRIDE, hoursAfterStart(54))).toBe("blocked");
    });

    it("is clear for a legacy note with no clock, however late", () => {
      const legacy = decideNoteClosure({
        clockStartedAt: null,
        asOf: hoursAfterStart(10_000),
        thresholdHours: DEFAULT_THRESHOLD_HOURS,
        enforceFrom: null,
      });

      expect(closureVerdict("block", legacy, NO_OVERRIDE, hoursAfterStart(10_000))).toBe("clear");
      expect(closureVerdict("warn", legacy, NO_OVERRIDE, hoursAfterStart(10_000))).toBe("clear");
    });
  });
});

describe("stageBeginsAt (the instant a stage starts, for the alert sweep's lookback)", () => {
  it("places each stage boundary where decideNoteClosure flips to it (24h default)", () => {
    expect(stageBeginsAt(CLOCK_START, DEFAULT_THRESHOLD_HOURS, "at_risk")).toEqual(
      hoursAfterStart(18),
    );
    expect(stageBeginsAt(CLOCK_START, DEFAULT_THRESHOLD_HOURS, "overdue")).toEqual(
      hoursAfterStart(24),
    );
    expect(stageBeginsAt(CLOCK_START, DEFAULT_THRESHOLD_HOURS, "escalated")).toEqual(
      hoursAfterStart(36),
    );
  });

  it.each<[number, NoteClosureAlertStage]>([
    [1, "at_risk"],
    [6, "at_risk"],
    [24, "at_risk"],
    [72, "overdue"],
    [168, "escalated"],
  ])("agrees with decideNoteClosure at its own boundary (T=%sh, %s)", (thresholdHours, stage) => {
    const begins = stageBeginsAt(CLOCK_START, thresholdHours, stage);
    const at = (asOf: Date) =>
      decideNoteClosure({ clockStartedAt: CLOCK_START, asOf, thresholdHours, enforceFrom: null })
        .stage;

    expect(at(begins)).toBe(stage);
    if (begins.getTime() > CLOCK_START.getTime()) {
      expect(at(new Date(begins.getTime() - 1))).not.toBe(stage);
    }
  });

  it("starts at_risk at the clock itself when the threshold is shorter than the lead", () => {
    // T=4h: elapsed 0 is already >= T-6h, so decideNoteClosure says at_risk from the first instant.
    expect(stageBeginsAt(CLOCK_START, 4, "at_risk")).toEqual(CLOCK_START);
    expect(decideAt(0, { thresholdHours: 4 }).stage).toBe("at_risk");
  });

  it("is absolute elapsed hours with no DST arithmetic (clock inside a spring-forward night)", () => {
    const clock = new Date("2026-03-07T20:00:00.000Z");
    expect(stageBeginsAt(clock, DEFAULT_THRESHOLD_HOURS, "overdue")).toEqual(
      new Date("2026-03-08T20:00:00.000Z"),
    );
  });

  it("rejects the ok stage and an invalid instant or threshold with RangeError", () => {
    expect(() => stageBeginsAt(CLOCK_START, DEFAULT_THRESHOLD_HOURS, "ok" as never)).toThrow(
      RangeError,
    );
    expect(() => stageBeginsAt(new Date(Number.NaN), DEFAULT_THRESHOLD_HOURS, "overdue")).toThrow(
      RangeError,
    );
    expect(() => stageBeginsAt(CLOCK_START, 0, "overdue")).toThrow(RangeError);
  });
});
