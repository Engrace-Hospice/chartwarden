import { HOPE_VALIDATION_RULES, type HopeValidationFindingDescriptor } from "@chartwarden/hope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { runHopeAssessmentValidation } from "../src/modules/10-hope/validation/run-validation";

// The pre-submission validation reads M38 through a seam. A failed read is not an answer: the check it feeds is reported
// "unavailable" (never a blocking "diagnosis not in the value set"), and the failure is logged (value-set id, error class and
// assessment id only), so an M38 outage is visible to an operator instead of only to the clinician's panel.
const ASSESSMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECRET = "patient C34.90 secret value";
const TARGET = "2026-06-08T12:00:00.000Z";

const DATA = {
  I: { primaryDiagnosisIcd10: "C34.90" },
  J: {
    J2030: { screened: "no" },
    J2050: { screened: "no" },
    J2051: { entries: [{ symptomCode: "pain", severity: "mild" }] },
  },
};

/** `null` = the caller supplies no assessment id. */
const validate = (assessmentId: string | null = ASSESSMENT) =>
  runHopeAssessmentValidation({
    assessmentId: assessmentId ?? undefined,
    rfaKind: "01_admission",
    dischargeReason: null,
    data: DATA,
    targetDate: new Date(TARGET),
  });

const rule = (findings: readonly HopeValidationFindingDescriptor[], ruleId: string) =>
  findings.filter((f) => f.ruleId === ruleId);

/** A seam error: a class a log may name, and a message that carries a value no log may carry. */
class TerminologyUnavailableError extends Error {
  constructor() {
    super(SECRET);
    this.name = "TerminologyUnavailableError";
  }
}

/** A provider whose sets are populated (so they count as available); `over` replaces arms to make them fail. */
function registerTerminology(over: { expand?: () => never; isMemberOf?: () => never } = {}): void {
  registerSeam("TerminologyProvider", {
    async *expand(valueSetId: string) {
      if (over.expand) over.expand();
      const codes = valueSetId === "hope_j_codes" ? ["J2030", "J2050", "J2051"] : ["C34.90"];
      for (const code of codes) yield { systemId: "icd10cm", code, display: code, annotations: {} };
    },
    async isMemberOf() {
      if (over.isMemberOf) over.isMemberOf();
      return { isMember: true, source: "platform" as const };
    },
  } as never);
}

const throwUnavailable = (): never => {
  throw new TerminologyUnavailableError();
};

let errors: { mock: { calls: readonly unknown[][] } };
const logged = (): string => errors.mock.calls.map((call) => String(call[0])).join("\n");

beforeEach(() => {
  __resetSeamsForTest();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  __resetSeamsForTest();
  vi.restoreAllMocks();
});

describe("validation — a failed M38 read is unavailable AND logged", () => {
  it("a per-code membership probe that throws marks Section I unavailable, never 'diagnosis not in the value set'", async () => {
    registerTerminology({ isMemberOf: throwUnavailable });

    const findings = await validate();

    // The set exists (it expanded), so before the fix a thrown probe read as "not a member": an ERROR the clinician cannot resolve.
    expect(rule(findings, HOPE_VALIDATION_RULES.SECTION_I_DIAGNOSIS_NOT_IN_VALUE_SET)).toEqual([]);
    const unavailable = rule(findings, HOPE_VALIDATION_RULES.VALUE_SET_UNAVAILABLE);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({ severity: "warning", section: "I" });
  });

  it("logs the failed probe once, with the assessment id, the value-set id and the error class, and never the message", async () => {
    registerTerminology({ isMemberOf: throwUnavailable });

    await validate();

    const lines = errors.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ASSESSMENT);
    expect(lines[0]).toContain("hospice_terminal_diagnosis");
    expect(lines[0]).toContain("TerminologyUnavailableError");
    expect(logged()).not.toContain(SECRET);
    expect(logged()).not.toContain("C34.90");
  });

  it("an expansion that throws marks both sets unavailable and logs each set by id", async () => {
    registerTerminology({ expand: throwUnavailable });

    const findings = await validate();

    expect(rule(findings, HOPE_VALIDATION_RULES.VALUE_SET_UNAVAILABLE)).toHaveLength(2);
    expect(rule(findings, HOPE_VALIDATION_RULES.SECTION_I_DIAGNOSIS_NOT_IN_VALUE_SET)).toEqual([]);
    expect(logged()).toContain("hospice_terminal_diagnosis");
    expect(logged()).toContain("hope_j_codes");
    expect(logged()).not.toContain(SECRET);
  });

  it("an unresolvable TerminologyProvider seam is logged by class, once", async () => {
    // No seam registered: `getSeam` throws a SeamError.
    const findings = await validate();

    expect(rule(findings, HOPE_VALIDATION_RULES.VALUE_SET_UNAVAILABLE)).toHaveLength(2);
    const lines = errors.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TerminologyProvider seam");
    expect(lines[0]).toContain("SeamError");
  });

  it("without an assessment id the line says so instead of printing a placeholder id", async () => {
    registerTerminology({ isMemberOf: throwUnavailable });

    await validate(null);

    expect(logged()).toContain("an assessment");
    expect(logged()).not.toContain("[not-a-uuid]");
  });

  it("a caller-supplied id that is not a uuid is masked in the line, never echoed", async () => {
    registerTerminology({ isMemberOf: throwUnavailable });

    await validate("Jane Doe 1948-02-11");

    expect(logged()).toContain("[not-a-uuid]");
    expect(logged()).not.toContain("Jane Doe");
  });

  it("a healthy seam logs nothing and the diagnosis check runs", async () => {
    registerTerminology();

    const findings = await validate();

    expect(errors.mock.calls).toEqual([]);
    expect(rule(findings, HOPE_VALIDATION_RULES.VALUE_SET_UNAVAILABLE)).toEqual([]);
    expect(rule(findings, HOPE_VALIDATION_RULES.SECTION_I_DIAGNOSIS_NOT_IN_VALUE_SET)).toEqual([]);
  });
});
