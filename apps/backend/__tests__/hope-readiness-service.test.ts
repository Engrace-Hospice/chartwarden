import { describe, expect, it } from "vitest";
import {
  effectiveHopeJ2051TriggerStateForReview,
  isCompletedSfvRegulatoryState,
} from "../src/modules/10-hope/hope-readiness-service";
import { buildCompletedSfvRegulatoryAnswerPlan } from "../src/modules/10-hope/hope-route-service-db";
import { deriveHopeJ2051TriggerState } from "../src/modules/10-hope/hope-sfv-service";
import { createHopeApplicabilityEngine } from "../src/modules/10-hope/spec/applicability-registry";
import type { HopeValidationContext } from "../src/modules/10-hope/spec/validation";
import { createHopeValidationEngine } from "../src/modules/10-hope/spec/validation-registry";

function answerMap(values: Record<string, string | number>) {
  return new Map(
    Object.entries(values).map(([itemCode, value]) => [
      itemCode,
      { state: "answered" as const, value },
    ]),
  );
}

function completedSfvRegulatoryAnswers(
  overrides: Record<string, { state: "answered" | "skipped"; value: unknown | null }> = {},
) {
  return new Map<string, { state: "answered" | "skipped"; value: unknown | null }>([
    ["J2052A", { state: "answered", value: "1" }],
    ["J2052B", { state: "answered", value: "2026-09-09" }],
    ["J2052C", { state: "skipped", value: null }],
    ["J2053A", { state: "answered", value: "0" }],
    ["J2053B", { state: "answered", value: "1" }],
    ["J2053C", { state: "answered", value: "0" }],
    ["J2053D", { state: "answered", value: "1" }],
    ["J2053E", { state: "answered", value: "0" }],
    ["J2053F", { state: "answered", value: "1" }],
    ["J2053G", { state: "answered", value: "0" }],
    ["J2053H", { state: "answered", value: "1" }],
    ...Object.entries(overrides),
  ]);
}

function completeRfa04Data(overrides: Record<string, unknown> = {}) {
  return {
    J: {
      J2053: {
        J2053A: "0",
        J2053B: "1",
        J2053C: "0",
        J2053D: "1",
        J2053E: "0",
        J2053F: "1",
        J2053G: "0",
        J2053H: "1",
        ...overrides,
      },
    },
  };
}

function ctx(values: Record<string, string>): HopeValidationContext {
  const answers = answerMap(values);
  const activeItems = Object.keys(values).map((itemCode) => ({
    itemCode,
    sectionLabel: itemCode.slice(0, 1),
    kind: "assessment" as const,
    cmsItemTypeCode:
      itemCode.endsWith("B") || itemCode === "A0220" || itemCode === "A0900" ? "Date" : "Code",
  }));
  return {
    mode: "final",
    assessment: {
      id: "hope-1",
      rfaKind: "01_admission",
      status: "draft",
      targetDate: "2025-10-01",
      specVersionId: "spec-1",
      specVersionCode: "1.00.1",
      isc: "HA",
      correctsAssessmentId: null,
    },
    activeItems,
    answers,
    applicability: createHopeApplicabilityEngine("1.00.1").evaluate({
      isc: "HA",
      activeItemCodes: activeItems.map((item) => item.itemCode),
      answers,
    }),
  };
}

describe("HOPE Admission readiness validation candidate", () => {
  it("evaluates fatal date-order rules against candidate Z0500B before signature persistence", () => {
    const findings = createHopeValidationEngine("1.00.1").evaluate(
      ctx({
        A0050: "1",
        A0220: "2025-10-10",
        A0250: "1",
        A0900: "1950-01-01",
        Z0500B: "2025-10-09",
      }),
    );

    expect(findings.map((finding) => finding.ruleId)).toContain("-3032");
  });

  it("allows warnings to remain nonblocking validation findings", () => {
    const findings = createHopeValidationEngine("1.00.1").evaluate(
      ctx({
        A0050: "1",
        A0220: "2025-10-10",
        A0250: "1",
        F2000A: "1",
        F2000B: "2025-10-01",
        Z0500B: "2025-10-11",
      }),
    );

    expect(findings.find((finding) => finding.ruleId === "-3063")?.severity).toBe("warning");
  });
});

describe("HOPE Admission readiness SFV review state", () => {
  it("keeps review.sfv.required true once a completed SFV exists for a pending J2051 projection", () => {
    const trigger = deriveHopeJ2051TriggerState(answerMap({ J2050A: "1", J2051A: "1" }));
    const effective = effectiveHopeJ2051TriggerStateForReview(trigger, { status: "completed" });

    expect(trigger.state).toBe("pending");
    expect(effective.triggerFired).toBe(true);
    expect(effective.state === "pending" ? null : effective.triggerFired).toBe(true);
  });

  it("keeps review.sfv.status completed when a completed SFV exists", () => {
    const sfv = { status: "completed" } as const;
    const effective = effectiveHopeJ2051TriggerStateForReview(
      deriveHopeJ2051TriggerState(answerMap({ J2050A: "1", J2051A: "1" })),
      sfv,
    );

    expect(effective.state).toBe("true");
    expect(sfv.status).toBe("completed");
  });

  it("prevents the J2051 incomplete blocker condition once a completed SFV proves the trigger fired", () => {
    const effective = effectiveHopeJ2051TriggerStateForReview(
      deriveHopeJ2051TriggerState(answerMap({ J2050A: "1", J2051A: "1" })),
      { status: "completed" },
    );

    expect(effective.state).not.toBe("pending");
  });

  it("reports required=false for definitive J2051 answers with no moderate or severe impact", () => {
    const trigger = effectiveHopeJ2051TriggerStateForReview(
      deriveHopeJ2051TriggerState(
        answerMap({
          J2050A: "1",
          J2051A: "0",
          J2051B: "1",
          J2051C: "9",
          J2051D: "0",
          J2051E: "1",
          J2051F: "0",
          J2051G: "9",
          J2051H: "1",
        }),
      ),
      undefined,
    );

    expect(trigger.state).toBe("false");
    expect(trigger.state === "pending" ? null : trigger.triggerFired).toBe(false);
  });

  it("leaves a truly incomplete J2051 branch pending when no SFV exists", () => {
    const trigger = effectiveHopeJ2051TriggerStateForReview(
      deriveHopeJ2051TriggerState(answerMap({ J2050A: "1", J2051A: "1" })),
      undefined,
    );

    expect(trigger.state).toBe("pending");
    expect(trigger.state === "pending" ? null : trigger.triggerFired).toBeNull();
  });

  it("recognizes J2052A persisted as numeric 1 canonically", () => {
    expect(
      isCompletedSfvRegulatoryState(
        completedSfvRegulatoryAnswers({
          J2052A: { state: "answered", value: 1 },
        }),
      ),
    ).toBe(true);
  });

  it("treats completed J2052/J2053 regulatory state as complete", () => {
    expect(isCompletedSfvRegulatoryState(completedSfvRegulatoryAnswers())).toBe(true);
  });

  it("keeps the regulatory state incomplete when one J2053 item is missing", () => {
    const answers = completedSfvRegulatoryAnswers();
    answers.delete("J2053H");

    expect(isCompletedSfvRegulatoryState(answers)).toBe(false);
  });

  it("keeps the regulatory state incomplete when J2052C is not skipped", () => {
    expect(
      isCompletedSfvRegulatoryState(
        completedSfvRegulatoryAnswers({
          J2052C: { state: "answered", value: "0" },
        }),
      ),
    ).toBe(false);
  });

  it("builds the legacy completed-SFV reconciliation rows from complete signed RFA-04 data", () => {
    const plan = buildCompletedSfvRegulatoryAnswerPlan("2026-09-09", completeRfa04Data());

    expect(plan?.answered.get("J2052A")).toBe("1");
    expect(plan?.answered.get("J2052B")).toBe("2026-09-09");
    expect(plan?.skipped.has("J2052C")).toBe(true);
    expect([...Array(8)].every((_, i) => plan?.answered.has(`J2053${String.fromCharCode(65 + i)}`))).toBe(
      true,
    );
  });

  it("does not fabricate missing J2053 values for legacy completed SFVs", () => {
    expect(
      buildCompletedSfvRegulatoryAnswerPlan("2026-09-09", completeRfa04Data({ J2053H: null })),
    ).toBeNull();
  });

  it("builds the same reconciliation plan each time so repeated repair is idempotent", () => {
    const first = buildCompletedSfvRegulatoryAnswerPlan("2026-09-09", completeRfa04Data());
    const second = buildCompletedSfvRegulatoryAnswerPlan("2026-09-09", completeRfa04Data());

    expect(first && [...first.answered]).toEqual(second && [...second.answered]);
    expect(first && [...first.skipped]).toEqual(second && [...second.skipped]);
  });
});
