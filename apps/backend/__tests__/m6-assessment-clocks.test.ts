/**
 * 42 CFR 418.54 assessment clocks (M6). PURE unit tests for `certification/window-math.ts`'s assessment
 * deadlines and the readmission plan's `requirementsForBenefitPeriod` dates, pinned on both sides of each edge.
 *
 *   • 418.54(a) — initial assessment "within 48 hours after the election": an HOUR clock (election + 48h); as
 *     a date, the latest day those hours reach (election + 2).
 *   • 418.54(b) — comprehensive assessment "no later than 5 calendar days after the election". CMS SOM
 *     Appendix M (L523) counts the election date as DAY 0: elected Wednesday ⇒ Monday is day 5 (on time),
 *     Tuesday is day 6 (late).
 */
import { describe, expect, it } from "vitest";
import {
  COMPREHENSIVE_ASSESSMENT_DAYS,
  INITIAL_ASSESSMENT_HOURS,
  comprehensiveAssessmentDueOn,
  computeAssessmentWindowDeadline,
  isAssessmentWindowKind,
} from "../src/modules/06-admission/certification/window-math";
import { requirementsForBenefitPeriod } from "../src/modules/06-admission/intake/benefit-period";

const TZ = "America/Los_Angeles";
/** 2026-10-07 is a Wednesday. */
const WEDNESDAY = "2026-10-07";

describe("418.54(b) comprehensive assessment — election date is day 0", () => {
  it("elected Wednesday ⇒ due Monday (day 5)", () => {
    expect(new Date(`${WEDNESDAY}T12:00:00Z`).getUTCDay()).toBe(3);
    expect(comprehensiveAssessmentDueOn(WEDNESDAY)).toBe("2026-10-12");
    expect(new Date("2026-10-12T12:00:00Z").getUTCDay()).toBe(1);
    expect(COMPREHENSIVE_ASSESSMENT_DAYS).toBe(5);
  });

  it("the window deadline is the END of day 5 org-local: day 5 is on time, day 6 is late", () => {
    // Elected Wed 2026-10-07 09:30 PDT (16:30Z).
    const electedAt = new Date("2026-10-07T16:30:00.000Z");
    const due = computeAssessmentWindowDeadline("comprehensive_assessment_5d", electedAt, TZ);
    // Mon 2026-10-12 23:59:59.999 PDT = Tue 06:59:59.999Z.
    expect(due.toISOString()).toBe("2026-10-13T06:59:59.999Z");
    const onTime = new Date("2026-10-12T23:00:00-07:00"); // Monday evening, day 5
    const late = new Date("2026-10-13T00:00:00-07:00"); // Tuesday 00:00, day 6
    expect(onTime.getTime() <= due.getTime()).toBe(true);
    expect(late.getTime() > due.getTime()).toBe(true);
  });

  it("anchors on the ORG-LOCAL election date, not the UTC date", () => {
    // Wed 2026-10-07 20:00 PDT is already Thursday in UTC; the election day is still Wednesday.
    const electedAt = new Date("2026-10-08T03:00:00.000Z");
    const due = computeAssessmentWindowDeadline("comprehensive_assessment_5d", electedAt, TZ);
    expect(due.toISOString()).toBe("2026-10-13T06:59:59.999Z");
  });

  it("the readmission plan's due DATE is election + 5 (day 5 on time, day 6 late)", () => {
    const r = requirementsForBenefitPeriod(2, WEDNESDAY);
    expect(r.comprehensiveAssessmentDueBy).toBe("2026-10-12");
    expect("2026-10-12" <= r.comprehensiveAssessmentDueBy).toBe(true);
    expect("2026-10-13" <= r.comprehensiveAssessmentDueBy).toBe(false);
  });
});

describe("418.54(a) initial assessment — 48 hours after the election", () => {
  it("the window deadline is exactly election + 48 hours", () => {
    const electedAt = new Date("2026-10-07T16:30:00.000Z");
    const due = computeAssessmentWindowDeadline("initial_assessment_48h", electedAt, TZ);
    expect(INITIAL_ASSESSMENT_HOURS).toBe(48);
    expect(due.toISOString()).toBe("2026-10-09T16:30:00.000Z");
    expect(due.getTime() - electedAt.getTime()).toBe(48 * 3_600_000);
  });

  it("the readmission plan shows the latest DATE 48 hours reach: election + 2 (Wed ⇒ Fri)", () => {
    expect(requirementsForBenefitPeriod(1, WEDNESDAY).initialAssessmentDueBy).toBe("2026-10-09");
  });
});

describe("isAssessmentWindowKind", () => {
  it("names only the two 418.54 windows", () => {
    expect(isAssessmentWindowKind("initial_assessment_48h")).toBe(true);
    expect(isAssessmentWindowKind("comprehensive_assessment_5d")).toBe(true);
    expect(isAssessmentWindowKind("care_plan_5d")).toBe(false);
    expect(isAssessmentWindowKind("notice_of_rights")).toBe(false);
  });
});
