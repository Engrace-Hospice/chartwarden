// @chartwarden/inpatient — M37-T07 unit tests for the §2.3 D3 24/7 RN-coverage invariant.
import { describe, expect, it } from "vitest";
import {
  effectiveRnCoverageActive,
  isBreakGlassActive,
  isBreakGlassExpired,
  validateBreakGlassEnd,
} from "../src/domain/rn-coverage/break-glass";
import {
  RN_ACTIVATION_FORWARD_HOURS,
  hasActivationCoverage,
  isCurrentHourUncovered,
  normalizeHorizonHours,
  projectCoverageGap,
} from "../src/domain/rn-coverage/horizon-evaluator";
import {
  type StaffAssignmentFact,
  buildCoverageWindows,
  coveringAssignmentsForHour,
  isCoveringAssignment,
} from "../src/domain/rn-coverage/window-builder";
import { IpuStateError } from "../src/errors";

const HOUR = 3_600_000;
const T0 = 1_000 * HOUR; // an arbitrary hour boundary

const rn = (over: Partial<StaffAssignmentFact> = {}): StaffAssignmentFact => ({
  assignmentId: "a1",
  role: "rn",
  state: "confirmed",
  shiftStartMs: T0,
  shiftEndMs: T0 + 12 * HOUR,
  membershipEligible: true,
  ...over,
});

describe("coverage eligibility (§2.3)", () => {
  it("counts only RN-equivalent, confirmed, eligible assignments", () => {
    expect(isCoveringAssignment(rn())).toBe(true);
    expect(isCoveringAssignment(rn({ role: "cna" }))).toBe(false);
    expect(isCoveringAssignment(rn({ state: "tentative" }))).toBe(false);
    expect(isCoveringAssignment(rn({ membershipEligible: false }))).toBe(false);
    expect(isCoveringAssignment(rn({ role: "charge_rn" }))).toBe(true);
    expect(isCoveringAssignment(rn({ role: "np_in_rn_role" }))).toBe(true);
  });

  it("covers hours inside the shift interval [start, end)", () => {
    const a = [rn({ shiftStartMs: T0, shiftEndMs: T0 + 2 * HOUR })];
    expect(coveringAssignmentsForHour(a, T0)).toEqual(["a1"]);
    expect(coveringAssignmentsForHour(a, T0 + 1 * HOUR)).toEqual(["a1"]);
    expect(coveringAssignmentsForHour(a, T0 + 2 * HOUR)).toEqual([]); // end is exclusive
  });
});

describe("coverage grid + gap projection (§2.3)", () => {
  it("marks covered vs uncovered hours across the grid", () => {
    // Coverage only for the first 3 hours.
    const grid = buildCoverageWindows([rn({ shiftStartMs: T0, shiftEndMs: T0 + 3 * HOUR })], T0, 6);
    expect(grid.map((g) => g.isCovered)).toEqual([true, true, true, false, false, false]);
  });

  it("projects the first forward gap + block-severity current-hour flag", () => {
    const grid = buildCoverageWindows(
      [rn({ shiftStartMs: T0, shiftEndMs: T0 + 2 * HOUR })],
      T0,
      12,
    );
    const p = projectCoverageGap(grid, T0, 8);
    expect(p.currentHourUncovered).toBe(false); // now (T0) is covered
    expect(p.rnCoverageActive).toBe(true);
    expect(p.firstGapMs).toBe(T0 + 2 * HOUR); // first uncovered hour
    expect(p.uncoveredCountInHorizon).toBe(6); // hours 2..7 within an 8h horizon
  });

  it("current hour uncovered → rnCoverageActive false (fail-closed on unbuilt hours)", () => {
    expect(isCurrentHourUncovered([], T0)).toBe(true); // no grid = uncovered
    const grid = buildCoverageWindows(
      [rn({ shiftStartMs: T0 + 5 * HOUR, shiftEndMs: T0 + 9 * HOUR })],
      T0,
      12,
    );
    expect(projectCoverageGap(grid, T0, 8).rnCoverageActive).toBe(false);
  });

  it("clamps the horizon into the schema-legal [8,168] range", () => {
    expect(normalizeHorizonHours(2)).toBe(8);
    expect(normalizeHorizonHours(24)).toBe(24);
    expect(normalizeHorizonHours(500)).toBe(168);
  });
});

describe("activation gate (§2.3 — 168h forward)", () => {
  it("requires a full 168h of forward coverage to activate", () => {
    const fullWeek = buildCoverageWindows(
      [rn({ shiftStartMs: T0, shiftEndMs: T0 + RN_ACTIVATION_FORWARD_HOURS * HOUR })],
      T0,
      RN_ACTIVATION_FORWARD_HOURS,
    );
    expect(hasActivationCoverage(fullWeek, T0)).toBe(true);
    // A one-hour gap fails the gate.
    const short = buildCoverageWindows(
      [rn({ shiftStartMs: T0, shiftEndMs: T0 + 167 * HOUR })],
      T0,
      RN_ACTIVATION_FORWARD_HOURS,
    );
    expect(hasActivationCoverage(short, T0)).toBe(false);
  });
});

describe("break-glass override (§2.3)", () => {
  it("is active within 4h and expires after", () => {
    const bg = { invokedAtMs: T0, endedAtMs: null };
    expect(isBreakGlassActive(bg, T0 + 1 * HOUR)).toBe(true);
    expect(isBreakGlassExpired(bg, T0 + 5 * HOUR)).toBe(true);
    expect(isBreakGlassActive(bg, T0 + 5 * HOUR)).toBe(false);
  });

  it("lets an active override keep coverage active despite an uncovered hour", () => {
    expect(
      effectiveRnCoverageActive(true, { invokedAtMs: T0, endedAtMs: null }, T0 + 1 * HOUR),
    ).toBe(true);
    expect(effectiveRnCoverageActive(true, null, T0)).toBe(false);
    expect(effectiveRnCoverageActive(false, null, T0)).toBe(true); // covered anyway
  });

  it("requires a non-break-glass actor to end the override", () => {
    expect(() => validateBreakGlassEnd(true)).toThrow(IpuStateError);
    expect(validateBreakGlassEnd(false)).toBeUndefined();
  });
});
