// apps/backend/__tests__/hope-presubmission-validation.test.ts — F-057. The CMS HOPE pre-submission
// rule set, driven through its IO runner `runHopeAssessmentValidation` (validation/run-validation.ts).
//
// `validateHopeAssessment` (@chartwarden/hope) is a pure rule set with its own unit suite. What this suite
// proves is the layer above it: the projection from the stored `data` jsonb to the engine's typed
// inputs, and the M38 availability/membership oracle resolved through the `TerminologyProvider` seam.
//
// Recovery merge (2026-09-25): this suite originally asserted through `POST .../sign` +
// `GET /hope/assessments/:id/validation`. The legacy F-057 route wiring (running this validator at sign
// and in `getValidation` over the old `data` blob) was deliberately NOT restored — main's spec-registry
// validation service replaces it — see audit/FORCE_PUSH_RECOVERY_AUDIT_2026-09-25.md. The runner itself
// is still exported and used (jobs/cron-workers.ts), so every case now calls it directly.
import { HOPE_VALIDATION_RULES, type HopeValidationFindingDescriptor } from "@chartwarden/hope";
import { PLATFORM_VALUE_SET_MEMBERS } from "@chartwarden/terminology";
import type { HopeDischargeReason, HopeRfaKind } from "@chartwarden/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { runHopeAssessmentValidation } from "../src/modules/10-hope/validation/run-validation";

const NOW = "2026-06-08T12:00:00.000Z";

/** Every A–Z section the comprehensive instrument requires, each carrying something. */
const COMPLETE_SECTIONS: Record<string, unknown> = {
  A: { dateOfBirth: "1948-02-11" },
  B: { hearing: "adequate" },
  C: { bims: 13 },
  D: { phq2: 1 },
  E: { behaviors: "none" },
  F: { codeStatus: "dnr" },
  G: { adlBathing: "dependent" },
  H: { continence: "occasionally_incontinent" },
  I: { primaryDiagnosisIcd10: "C34.90" },
  J: {
    J2030: { screened: "no" },
    J2050: { screened: "no" },
    J2051: { entries: [{ symptomCode: "pain", severity: "mild" }] },
  },
  K: { swallowing: "no_impairment" },
  M: { pressureUlcers: "none" },
  N: { opioidPrescribed: false },
  O: { oxygen: true },
  Q: { participation: "patient" },
  X: { preferredPlaceOfDeath: "home" },
  Z: { completionDate: "2026-06-08" },
};

type ApiFinding = HopeValidationFindingDescriptor;

interface Subject {
  rfaKind: HopeRfaKind;
  targetDate: string;
  dischargeReason?: HopeDischargeReason;
  data: Record<string, unknown>;
  admissionTargetDate?: string;
}

/** Run the pre-submission runner over one assessment-shaped subject. */
async function validate(subject: Subject): Promise<readonly ApiFinding[]> {
  return runHopeAssessmentValidation({
    rfaKind: subject.rfaKind,
    dischargeReason: subject.dischargeReason ?? null,
    data: subject.data,
    targetDate: new Date(subject.targetDate),
    admissionTargetDate: subject.admissionTargetDate ?? null,
  });
}

const admissionBody = (data: Record<string, unknown>): Subject => ({
  rfaKind: "01_admission",
  targetDate: NOW,
  data,
});

const rules = (findings: readonly ApiFinding[], ruleId: string): ApiFinding[] =>
  findings.filter((f) => f.ruleId === ruleId);

// No TerminologyProvider is registered unless a case registers one — the deployment the availability
// branch exists for.
beforeEach(() => {
  __resetSeamsForTest();
});
afterEach(() => {
  __resetSeamsForTest();
});

describe("F-057 — required-items matrix (§2.3)", () => {
  it("an Admission RFA signed with an EMPTY payload reports one blocking error per missing section", async () => {
    const findings = await validate(admissionBody({}));
    const missing = rules(findings, HOPE_VALIDATION_RULES.REQUIRED_SECTION_MISSING);
    // The comprehensive instrument is all 17 CMS-used letters. This is the case that made the defect
    // legible: an assessment carrying NONE of them used to report a clean bill of health.
    expect(missing.length).toBe(17);
    expect(missing.every((f) => f.severity === "error")).toBe(true);
  });

  it("a section present but EMPTY counts as missing — an opened tab is not a completed section", async () => {
    const findings = await validate(admissionBody({ ...COMPLETE_SECTIONS, M: {} }));
    const missing = rules(findings, HOPE_VALIDATION_RULES.REQUIRED_SECTION_MISSING);
    expect(missing.map((f) => f.message)).toEqual([
      "Required Section M is missing for RFA 01_admission.",
    ]);
  });

  it("a complete comprehensive payload reports NO blocking error", async () => {
    const findings = await validate(admissionBody(COMPLETE_SECTIONS));
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });
});

describe("F-057 — Section J cross-field rules (§86)", () => {
  it("J2030 screened Yes with no pain characteristics is a blocking error", async () => {
    const findings = await validate(
      admissionBody({
        ...COMPLETE_SECTIONS,
        J: { ...(COMPLETE_SECTIONS.J as object), J2030: { screened: "yes" } },
      }),
    );
    const f = rules(findings, HOPE_VALIDATION_RULES.J2030_PAIN_CHARACTERISTICS_MISSING);
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe("error");
  });

  it("J2030 screened Yes WITH characteristics is clean — the rule reads the characteristics, not the screen", async () => {
    const findings = await validate(
      admissionBody({
        ...COMPLETE_SECTIONS,
        J: {
          ...(COMPLETE_SECTIONS.J as object),
          J2030: { screened: "yes", characteristics: { frequency: "daily" } },
        },
      }),
    );
    expect(rules(findings, HOPE_VALIDATION_RULES.J2030_PAIN_CHARACTERISTICS_MISSING)).toEqual([]);
  });

  it("J2050 screened Yes with an EMPTY characteristics object still fires — a half-filled form is the case", async () => {
    const findings = await validate(
      admissionBody({
        ...COMPLETE_SECTIONS,
        J: {
          ...(COMPLETE_SECTIONS.J as object),
          J2050: { screened: "yes", characteristics: {} },
        },
      }),
    );
    expect(
      rules(findings, HOPE_VALIDATION_RULES.J2050_DYSPNEA_CHARACTERISTICS_MISSING).length,
    ).toBe(1);
  });
});

describe("F-057 — Section N advisory rule (§2.3)", () => {
  it("an opioid with no bowel regimen and no documented contraindication is a WARNING, not a blocker", async () => {
    const findings = await validate(
      admissionBody({ ...COMPLETE_SECTIONS, N: { opioidPrescribed: true } }),
    );
    const f = rules(findings, HOPE_VALIDATION_RULES.SECTION_N_BOWEL_REGIMEN_MISSING);
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe("warning");
    expect(findings.filter((x) => x.severity === "error")).toEqual([]);
  });

  it("a documented contraindication satisfies it without a scheduled regimen", async () => {
    const findings = await validate(
      admissionBody({
        ...COMPLETE_SECTIONS,
        N: { opioidPrescribed: true, bowelRegimenContraindication: "complete bowel obstruction" },
      }),
    );
    expect(rules(findings, HOPE_VALIDATION_RULES.SECTION_N_BOWEL_REGIMEN_MISSING)).toEqual([]);
  });
});

describe("F-057 — value-set availability (the rule that must NOT become a blocker)", () => {
  it("an unresolvable M38 value set reports 'could not be checked', never 'diagnosis invalid'", async () => {
    const findings = await validate(admissionBody(COMPLETE_SECTIONS));
    // M38's `hospice_terminal_diagnosis` / `hope_j_codes` ship as DEFINITIONS with no curated members
    // until the per-system loaders run, and the seam is a deny-stub here. `isMemberOf` cannot tell "not
    // a member" from "no members exist" — so a naive wiring would have made rule 2 (an ERROR) fire on
    // every assessment carrying a terminal diagnosis, which is an outage reported as a data defect.
    const unavailable = rules(findings, HOPE_VALIDATION_RULES.VALUE_SET_UNAVAILABLE);
    expect(unavailable.length).toBe(2); // one for Section I, one for Section J
    expect(unavailable.every((f) => f.severity === "warning")).toBe(true);
    expect(rules(findings, HOPE_VALIDATION_RULES.SECTION_I_DIAGNOSIS_NOT_IN_VALUE_SET)).toEqual([]);
    expect(rules(findings, HOPE_VALIDATION_RULES.SECTION_J_CODE_NOT_IN_VALUE_SET)).toEqual([]);
  });

  it("no diagnosis and no J ITEMS means nothing to check — no unavailability finding either", async () => {
    const findings = await validate(
      admissionBody({
        ...COMPLETE_SECTIONS,
        I: { note: "deferred" },
        // Section J documented, but carrying no `J####` item — so there is nothing for the §86
        // membership rule to ask about, and "could not check" would be a finding about nothing.
        // (Before F-059 this case used `J2030`, which the projection then read as a symptom-code
        // source rather than as the ITEM it is.)
        J: { note: "screening deferred to the next visit" },
      }),
    );
    expect(rules(findings, HOPE_VALIDATION_RULES.VALUE_SET_UNAVAILABLE)).toEqual([]);
  });
});

describe("F-057 — cross-RFA temporal order (§2.3)", () => {
  // The route used to resolve the sibling Admission timepoint; the runner takes it as data, so the
  // Admission's target date is handed in explicitly here.
  it("a HUV1 dated on or before the signed Admission timepoint is a blocking error", async () => {
    // The Admission RFA targets NOW; the HUV1 then targets the SAME instant, which is not strictly
    // after it.
    const findings = await validate({
      rfaKind: "02_huv1",
      targetDate: NOW,
      data: COMPLETE_SECTIONS,
      admissionTargetDate: NOW,
    });
    const f = rules(findings, HOPE_VALIDATION_RULES.CROSS_RFA_TEMPORAL_ORDER);
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe("error");
  });

  it("a HUV1 dated after the Admission timepoint is clean", async () => {
    const findings = await validate({
      rfaKind: "02_huv1",
      targetDate: NOW,
      data: COMPLETE_SECTIONS,
      admissionTargetDate: "2026-06-07T12:00:00.000Z",
    });
    expect(rules(findings, HOPE_VALIDATION_RULES.CROSS_RFA_TEMPORAL_ORDER)).toEqual([]);
  });
});

// "F-057 — the report is available BEFORE the signature" (GET /validation on a DRAFT) deleted: the
// legacy F-057 route wiring was not restored — see audit/FORCE_PUSH_RECOVERY_AUDIT_2026-09-25.md. The
// runner is status-agnostic, so the 17-missing-sections case above already covers an unsigned payload.

describe("F-057 — the D9 Section-Q divergence the record gate cannot see", () => {
  it("a live discharge whose Section Q is an EMPTY object passes the record gate and fails the CMS rule", async () => {
    // `assertSectionQForDischarge` (record time) asks whether the key EXISTS; the CMS rule asks whether
    // the section was COMPLETED. `{ Q: {} }` satisfies the first and not the second — an opened tab.
    const findings = await validate({
      rfaKind: "05_discharge",
      targetDate: NOW,
      dischargeReason: "live_discharge",
      data: {
        A: { dob: "1948-02-11" },
        I: { primaryDiagnosisIcd10: "C34.90" },
        J: { J2030: { screened: "no" } },
        X: { pref: "home" },
        Z: { completionDate: "2026-06-08" },
        Q: {},
      },
    });
    const f = rules(findings, HOPE_VALIDATION_RULES.SECTION_Q_REQUIRED);
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe("error");
  });
});

// ── F-059: the Section-J value-set rule, once M38 can actually answer ────────────────────────────────
//
// The cases above run with NO TerminologyProvider registered, which is the deployment the availability
// branch exists for. These register one over the real curated seed, so the rule RUNS — which is the
// point of the F-059 decision: `hope_j_codes` holds the instrument's ITEM identifiers (J2030 / J2050 /
// J2051, now curated under the `cms_hope` code system), so an unrecognised item is catchable. Had the
// set held the J2051 SYMPTOM codes instead, this rule could never fail: `symptomCode` is closed to the
// eight `HOPE_J2051_SYMPTOM_CODES` at the route boundary, so every stored value is already a member.
describe("F-059 — Section J items are checked against the CMS roster", () => {
  /** A minimal TerminologyProvider over the real `PLATFORM_VALUE_SET_MEMBERS` curation. */
  function registerSeededTerminology(): void {
    registerSeam("TerminologyProvider", {
      // eslint-disable-next-line require-yield
      async *expand(valueSetId: string) {
        for (const m of PLATFORM_VALUE_SET_MEMBERS.filter((x) => x.valueSetId === valueSetId)) {
          yield { systemId: m.systemId, code: m.code, display: m.display, annotations: {} };
        }
      },
      async isMemberOf(valueSetId: string, system: string, code: string) {
        return {
          isMember: PLATFORM_VALUE_SET_MEMBERS.some(
            (m) => m.valueSetId === valueSetId && m.systemId === system && m.code === code,
          ),
          source: "platform" as const,
        };
      },
    } as never);
  }

  afterEach(() => {
    __resetSeamsForTest();
  });

  it("the three curated items pass — no unavailability finding, no membership warning", async () => {
    registerSeededTerminology();
    const findings = await validate(admissionBody(COMPLETE_SECTIONS));
    const j = findings.filter((f) => f.message.startsWith("Section J"));
    expect(j).toEqual([]);
    expect(rules(findings, HOPE_VALIDATION_RULES.SECTION_J_CODE_NOT_IN_VALUE_SET)).toEqual([]);
  });

  it("an item the CMS roster does not carry WARNS — the rule can now actually fail", async () => {
    registerSeededTerminology();
    const findings = await validate(
      admissionBody({
        ...COMPLETE_SECTIONS,
        // A transposed item number: you transpose the DIGITS of J2050, which is exactly the
        // correction M10-F07 describes and what the value set exists to catch.
        J: { ...(COMPLETE_SECTIONS.J as object), J2005: { screened: "no" } },
      }),
    );
    const warn = rules(findings, HOPE_VALIDATION_RULES.SECTION_J_CODE_NOT_IN_VALUE_SET);
    expect(warn.length).toBe(1);
    expect(warn[0].severity).toBe("warning");
    expect(warn[0].message).toContain("J2005");
    // Advisory only: an unrecognised item is a data-quality signal, never a submission blocker.
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("a J2051 SYMPTOM code is never checked against the value set — it is an answer, not an item", async () => {
    registerSeededTerminology();
    const findings = await validate(admissionBody(COMPLETE_SECTIONS));
    // `pain` is a member of no value set and never will be; the boundary already closed that
    // vocabulary. If it were being checked here, this assertion would fail.
    expect(findings.some((f) => f.message.includes("'PAIN'"))).toBe(false);
  });
});
