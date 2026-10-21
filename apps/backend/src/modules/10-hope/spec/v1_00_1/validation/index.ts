import { ssnCmsProblem } from "@wardenx/types";
import {
  type HopeRuleFinding,
  type HopeValidationContext,
  type HopeValidationEngine,
  type HopeValidationRule,
  answerValue,
  applicabilityOf,
  daysBetween,
  fingerprint,
  isAnswered,
  isSkipped,
  parseHopeDate,
  sectionOf,
} from "../../validation";

const F_PAIRS = [
  ["-3035", "F2000A", "F2000B"],
  ["-3036", "F2100A", "F2100B"],
  ["-3037", "F2200A", "F2200B"],
  ["-3038", "F3000A", "F3000B"],
] as const;
const J0910_COMPONENTS = [
  "J0910C1",
  "J0910C2",
  "J0910C3",
  "J0910C4",
  "J0910C5",
  "J0910C6",
  "J0910C7",
];
const J2051_ITEMS = [
  "J2051A",
  "J2051B",
  "J2051C",
  "J2051D",
  "J2051E",
  "J2051F",
  "J2051G",
  "J2051H",
];
const J2053_ITEMS = [
  "J2053A",
  "J2053B",
  "J2053C",
  "J2053D",
  "J2053E",
  "J2053F",
  "J2053G",
  "J2053H",
];
const M1195_POSITIVE = [
  "M1195A",
  "M1195B",
  "M1195C",
  "M1195D",
  "M1195E",
  "M1195F",
  "M1195G",
  "M1195H",
];
const M1200_POSITIVE = [
  "M1200A",
  "M1200B",
  "M1200C",
  "M1200D",
  "M1200E",
  "M1200F",
  "M1200G",
  "M1200H",
  "M1200I",
  "M1200J",
];
const ETHNICITY_POSITIVE = ["A1005B", "A1005C", "A1005D", "A1005E"];
const ETHNICITY_EXCLUSIVE = ["A1005A", "A1005X", "A1005Y"];
const RACE_POSITIVE = [
  "A1010A",
  "A1010B",
  "A1010C",
  "A1010D",
  "A1010E",
  "A1010F",
  "A1010G",
  "A1010H",
  "A1010I",
  "A1010J",
  "A1010K",
  "A1010L",
  "A1010M",
  "A1010N",
];
const RACE_EXCLUSIVE = ["A1010X", "A1010Y", "A1010Z"];
const PAYER_ITEMS = [
  "A1400A",
  "A1400B",
  "A1400C",
  "A1400D",
  "A1400G",
  "A1400H",
  "A1400I",
  "A1400J",
  "A1400K",
  "A1400X",
  "A1400Y",
];
const CHECKLIST_GROUP_ITEMS = new Set([
  ...ETHNICITY_POSITIVE,
  ...ETHNICITY_EXCLUSIVE,
  ...RACE_POSITIVE,
  ...RACE_EXCLUSIVE,
  ...PAYER_ITEMS,
]);
const CLINICAL_DATES = [
  "J0900B",
  "J0910B",
  "J2030B",
  "J2040B",
  "J2050B",
  "J2052B",
  "N0500B",
  "N0510B",
  "N0520B",
];
const F_DATES = ["F2000B", "F2100B", "F2200B", "F3000B"];

function finding(
  input: Omit<HopeRuleFinding, "fingerprint" | "section"> & {
    readonly section?: string;
  },
): HopeRuleFinding {
  return {
    ...input,
    section: input.section ?? sectionOf(input.itemCode ?? input.ruleId),
    fingerprint: fingerprint(input.ruleId, input.itemCode),
  };
}

function activeAssessmentItems(ctx: HopeValidationContext): readonly string[] {
  return ctx.activeItems.filter((item) => item.kind === "assessment").map((item) => item.itemCode);
}

/**
 * CMS consistency edits apply only to the members that are active for the
 * record's ISC.  In particular, the demographic checklist items are HA-only;
 * evaluating their edit against a HUV/HD record would require fields that the
 * CMS item set correctly omits from that record.
 */
function activeChecklistItems(
  ctx: HopeValidationContext,
  itemCodes: readonly string[],
): readonly string[] {
  const active = new Set(activeAssessmentItems(ctx));
  return itemCodes.filter((itemCode) => active.has(itemCode));
}

function checked(ctx: HopeValidationContext, itemCode: string): boolean {
  return answerValue(ctx.answers, itemCode) === "1";
}

function required(
  ctx: HopeValidationContext,
  itemCode: string,
  ruleId = "CMS-HOPE-REQUIRED",
): HopeRuleFinding[] {
  if (
    ctx.mode !== "final" ||
    applicabilityOf(ctx, itemCode) !== "applicable" ||
    isAnswered(ctx.answers, itemCode)
  )
    return [];
  return [
    finding({
      ruleId,
      severity: "error",
      findingKind: "missing_required",
      itemCode,
      message: `${itemCode} is required for final HOPE validation.`,
    }),
  ];
}

function requireDate(
  ctx: HopeValidationContext,
  itemCode: string,
  ruleId: string,
): HopeRuleFinding[] {
  const out = required(ctx, itemCode, ruleId);
  const value = answerValue(ctx.answers, itemCode);
  if (value != null && !parseHopeDate(value)) {
    out.push(
      finding({
        ruleId,
        severity: "error",
        findingKind: "inconsistent_value",
        itemCode,
        message: `${itemCode} must be a valid YYYY-MM-DD date.`,
      }),
    );
  }
  return out;
}

function exclusivity(
  ctx: HopeValidationContext,
  ruleId: string,
  noneCode: string,
  positiveCodes: readonly string[],
  message: string,
): HopeRuleFinding[] {
  if (!checked(ctx, noneCode)) return [];
  const positives = positiveCodes.filter((code) => checked(ctx, code));
  if (positives.length === 0) return [];
  return [
    finding({
      ruleId,
      severity: "error",
      findingKind: "mutual_exclusivity",
      itemCode: noneCode,
      message,
      details: { mutuallyExclusiveWith: positives },
    }),
  ];
}

function dateOrder(
  ctx: HopeValidationContext,
  earlierCode: string,
  laterCode: string,
  ruleId = "-3032",
): HopeRuleFinding[] {
  if (
    applicabilityOf(ctx, earlierCode) !== "applicable" ||
    applicabilityOf(ctx, laterCode) !== "applicable"
  )
    return [];
  const earlier = answerValue(ctx.answers, earlierCode);
  const later = answerValue(ctx.answers, laterCode);
  if (!earlier || !later) return [];
  const delta = daysBetween(later, earlier);
  if (delta == null || delta >= 0) return [];
  return [
    {
      ruleId,
      severity: "error",
      findingKind: "date_order",
      section: sectionOf(laterCode),
      itemCode: laterCode,
      message: `${earlierCode} must be on or before ${laterCode}.`,
      details: {
        earlierItemCode: earlierCode,
        earlier,
        laterItemCode: laterCode,
        later,
      },
      fingerprint: fingerprint(ruleId, earlierCode, laterCode),
    },
  ];
}

const WORKFLOW_COMPLETION_ITEMS = new Set(["Z0500B"]);

const OPTIONAL_ASSESSMENT_ITEMS = new Set([
  "A0500B", // Patient Middle Initial
  "A0500D", // Patient Name Suffix

  // Required conditionally from payer coverage in Section A.
  "A0600B", // Patient Medicare number
  "A0700", // Patient Medicaid number
]);

const requirednessRule: HopeValidationRule = {
  id: "hope-v1.00.1-final-requiredness",
  evaluate(ctx) {
    if (ctx.mode !== "final") return [];

    return activeAssessmentItems(ctx)
      .filter(
        (itemCode) =>
          !WORKFLOW_COMPLETION_ITEMS.has(itemCode) &&
          !OPTIONAL_ASSESSMENT_ITEMS.has(itemCode) &&
          !CHECKLIST_GROUP_ITEMS.has(itemCode),
      )
      .flatMap((itemCode) => required(ctx, itemCode));
  },
};

const skipStateRule: HopeValidationRule = {
  id: "hope-v1.00.1-skip-state-consistency",
  evaluate(ctx) {
    const out: HopeRuleFinding[] = [];
    const ethnicityItems = activeChecklistItems(ctx, [
      ...ETHNICITY_POSITIVE,
      ...ETHNICITY_EXCLUSIVE,
    ]);
    if (
      ctx.mode === "final" &&
      ethnicityItems.length > 0 &&
      ethnicityItems.every((code) => !checked(ctx, code))
    ) {
      out.push(
        finding({
          ruleId: "-3080",
          severity: "error",
          findingKind: "missing_required",
          itemCode: "A1005",
          section: "A",
          message: "At least one A1005 ethnicity selection is required.",
        }),
      );
    }
    for (const itemCode of activeAssessmentItems(ctx)) {
      const applicability = applicabilityOf(ctx, itemCode);
      if (applicability === "not_applicable" && isAnswered(ctx.answers, itemCode)) {
        out.push(
          finding({
            ruleId: "CMS-HOPE-SKIP-STATE",
            severity: "error",
            findingKind: "invalid_skip_state",
            itemCode,
            message: `${itemCode} is not applicable and must serialize as skipped.`,
          }),
        );
      }
      if (applicability === "applicable" && isSkipped(ctx.answers, itemCode)) {
        out.push(
          finding({
            ruleId: "CMS-HOPE-SKIP-STATE",
            severity: "error",
            findingKind: "invalid_skip_state",
            itemCode,
            message: `${itemCode} is applicable and cannot remain skipped.`,
          }),
        );
      }
    }
    return out;
  },
};

const sectionFRule: HopeValidationRule = {
  id: "hope-v1.00.1-section-f",
  evaluate(ctx) {
    const out: HopeRuleFinding[] = [];
    for (const [ruleId, parent, dateItem] of F_PAIRS) {
      const value = answerValue(ctx.answers, parent);
      if (value === "0" && isAnswered(ctx.answers, dateItem)) {
        out.push(
          finding({
            ruleId,
            severity: "error",
            findingKind: "invalid_skip_state",
            itemCode: dateItem,
            message: `${dateItem} must be skipped when ${parent}=0.`,
          }),
        );
      }
      if ((value === "1" || value === "2") && ctx.mode === "final")
        out.push(...requireDate(ctx, dateItem, ruleId));
    }
    const admission = answerValue(ctx.answers, "A0220");
    if (admission) {
      for (const itemCode of F_DATES) {
        const value = answerValue(ctx.answers, itemCode);
        const delta = value ? daysBetween(admission, value) : null;
        if (delta != null && delta > 7) {
          out.push(
            finding({
              ruleId: "-3063",
              severity: "warning",
              findingKind: "timing",
              itemCode,
              message: `${itemCode} is more than seven calendar days before A0220.`,
              details: {
                admissionDate: admission,
                discussionDate: value,
                daysBeforeAdmission: delta,
              },
            }),
          );
        }
      }
    }
    return out;
  },
};

const sectionARule: HopeValidationRule = {
  id: "hope-v1.00.1-section-a-consistency",
  evaluate(ctx) {
    const out: HopeRuleFinding[] = [];
    // A0600A SSN — the CMS fatal format edits -3015 / -3001 / -3002 / -3003 (iQIES rejects the record).
    const ssn = answerValue(ctx.answers, "A0600A");
    const ssnProblem = typeof ssn === "string" ? ssnCmsProblem(ssn, { asStored: true }) : null;
    if (ssnProblem) {
      out.push(
        finding({
          ruleId: ssnProblem.ruleId,
          severity: "error",
          findingKind: "inconsistent_value",
          itemCode: "A0600A",
          section: "A",
          message: `A0600A: ${ssnProblem.message}`,
        }),
      );
    }
    const ethnicityPositive = activeChecklistItems(ctx, ETHNICITY_POSITIVE);
    const ethnicityExclusive = activeChecklistItems(ctx, ETHNICITY_EXCLUSIVE);
    const racePositive = activeChecklistItems(ctx, RACE_POSITIVE);
    const raceExclusive = activeChecklistItems(ctx, RACE_EXCLUSIVE);
    const payerItems = activeChecklistItems(ctx, PAYER_ITEMS);
    if (
      ethnicityExclusive.some((code) => checked(ctx, code)) &&
      ethnicityPositive.some((code) => checked(ctx, code))
    ) {
      out.push(
        finding({
          ruleId: "-3080",
          severity: "error",
          findingKind: "mutual_exclusivity",
          itemCode: "A1005",
          section: "A",
          message:
            "A1005 exclusive ethnicity selections cannot be combined with Hispanic/Latino selections.",
        }),
      );
    }
    if (
      ctx.mode === "final" &&
      racePositive.length + raceExclusive.length > 0 &&
      [...racePositive, ...raceExclusive].every((code) => !checked(ctx, code))
    ) {
      out.push(
        finding({
          ruleId: "-3090",
          severity: "error",
          findingKind: "missing_required",
          itemCode: "A1010",
          section: "A",
          message: "At least one A1010 race selection is required.",
        }),
      );
    }
    if (
      raceExclusive.some((code) => checked(ctx, code)) &&
      racePositive.some((code) => checked(ctx, code))
    ) {
      out.push(
        finding({
          ruleId: "-3090",
          severity: "error",
          findingKind: "mutual_exclusivity",
          itemCode: "A1010",
          section: "A",
          message: "A1010 exclusive race selections cannot be combined with race selections.",
        }),
      );
    }
    if (
      ctx.mode === "final" &&
      payerItems.length > 0 &&
      payerItems.every((code) => !checked(ctx, code))
    ) {
      out.push(
        finding({
          ruleId: "-3081",
          severity: "error",
          findingKind: "missing_required",
          itemCode: "A1400",
          section: "A",
          message: "At least one A1400 payer source must be selected.",
        }),
      );
    }
    if (
      payerItems.includes("A1400A") &&
      payerItems.includes("A1400B") &&
      checked(ctx, "A1400A") &&
      checked(ctx, "A1400B")
    ) {
      out.push(
        finding({
          ruleId: "-3083",
          severity: "error",
          findingKind: "mutual_exclusivity",
          itemCode: "A1400",
          section: "A",
          message: "Medicare FFS and Medicare Advantage payer selections are mutually exclusive.",
        }),
      );
    }
    if (
      payerItems.includes("A1400C") &&
      payerItems.includes("A1400D") &&
      checked(ctx, "A1400C") &&
      checked(ctx, "A1400D")
    ) {
      out.push(
        finding({
          ruleId: "-3084",
          severity: "error",
          findingKind: "mutual_exclusivity",
          itemCode: "A1400",
          section: "A",
          message:
            "Medicaid FFS and Medicaid managed care payer selections are mutually exclusive.",
        }),
      );
    }

    return out;
  },
};

const sectionJRule: HopeValidationRule = {
  id: "hope-v1.00.1-section-j",
  evaluate(ctx) {
    const out: HopeRuleFinding[] = [];
    const j0900a = answerValue(ctx.answers, "J0900A");
    if (j0900a === "0") {
      for (const child of ["J0900B", "J0900C", "J0900D"])
        if (isAnswered(ctx.answers, child)) {
          out.push(
            finding({
              ruleId: "-3066",
              severity: "error",
              findingKind: "invalid_skip_state",
              itemCode: child,
              message: `${child} must be skipped when J0900A=0.`,
            }),
          );
        }
    }
    if (
      ["1", "2", "3"].includes(answerValue(ctx.answers, "J0900C") ?? "") &&
      answerValue(ctx.answers, "J0905") !== "1"
    ) {
      out.push(
        finding({
          ruleId: "-3076",
          severity: "error",
          findingKind: "inconsistent_value",
          itemCode: "J0905",
          message: "J0905 must indicate active pain when J0900C reports pain severity 1, 2, or 3.",
        }),
      );
    }
    out.push(
      ...exclusivity(
        ctx,
        "-3041",
        "J0910C9",
        J0910_COMPONENTS,
        "J0910C9 None is mutually exclusive with positive pain assessment components.",
      ),
    );
    out.push(...dateOrder(ctx, "J0900B", "J0910B"));
    const j2040a = answerValue(ctx.answers, "J2040A");
    if ((j2040a === "0" || j2040a === "1") && isAnswered(ctx.answers, "J2040B")) {
      out.push(
        finding({
          ruleId: "-3047",
          severity: "error",
          findingKind: "invalid_skip_state",
          itemCode: "J2040B",
          message: "J2040B must be skipped unless J2040A indicates treatment was initiated.",
        }),
      );
    }
    const trigger = J2051_ITEMS.some((code) =>
      ["2", "3"].includes(answerValue(ctx.answers, code) ?? ""),
    );
    const allFalse = J2051_ITEMS.every((code) =>
      ["0", "1", "9"].includes(answerValue(ctx.answers, code) ?? ""),
    );
    if (trigger && ctx.mode === "final") out.push(...required(ctx, "J2052A", "-3108"));
    if (allFalse) {
      for (const child of ["J2052A", "J2052B", "J2052C", ...J2053_ITEMS])
        if (isAnswered(ctx.answers, child)) {
          out.push(
            finding({
              ruleId: "-3108",
              severity: "error",
              findingKind: "invalid_skip_state",
              itemCode: child,
              message: `${child} must be skipped when no J2051 symptom impact is moderate or severe.`,
            }),
          );
        }
    }
    const j2052a = answerValue(ctx.answers, "J2052A");
    if (j2052a === "1") {
      if (ctx.mode === "final") {
        out.push(...requireDate(ctx, "J2052B", "-3092"));
        for (const code of J2053_ITEMS) out.push(...required(ctx, code, "-3109"));
      }
      if (isAnswered(ctx.answers, "J2052C"))
        out.push(
          finding({
            ruleId: "-3106",
            severity: "error",
            findingKind: "invalid_skip_state",
            itemCode: "J2052C",
            message: "J2052C must be skipped when J2052A=1.",
          }),
        );
    }
    if (j2052a === "0") {
      if (ctx.mode === "final") out.push(...required(ctx, "J2052C", "-3106"));
      if (isAnswered(ctx.answers, "J2052B"))
        out.push(
          finding({
            ruleId: "-3092",
            severity: "error",
            findingKind: "invalid_skip_state",
            itemCode: "J2052B",
            message: "J2052B must be skipped when J2052A=0.",
          }),
        );
      for (const code of J2053_ITEMS)
        if (isAnswered(ctx.answers, code))
          out.push(
            finding({
              ruleId: "-3109",
              severity: "error",
              findingKind: "invalid_skip_state",
              itemCode: code,
              message: `${code} must be skipped when SFV was not completed.`,
            }),
          );
    }
    const j2050b = answerValue(ctx.answers, "J2050B");
    const j2052b = answerValue(ctx.answers, "J2052B");
    const sfvLag = j2050b && j2052b ? daysBetween(j2052b, j2050b) : null;
    if (sfvLag != null && sfvLag > 2) {
      out.push(
        finding({
          ruleId: "-3105",
          severity: "warning",
          findingKind: "timing",
          itemCode: "J2052B",
          message: "J2052B is more than two calendar days after J2050B.",
          details: { symptomImpactDate: j2050b, sfvDate: j2052b, days: sfvLag },
        }),
      );
    }
    return out;
  },
};

const sectionMRule: HopeValidationRule = {
  id: "hope-v1.00.1-section-m",
  evaluate(ctx) {
    return [
      ...exclusivity(
        ctx,
        "-3094",
        "M1195Z",
        M1195_POSITIVE,
        "M1195Z None is mutually exclusive with positive skin condition selections.",
      ),
      ...exclusivity(
        ctx,
        "-3095",
        "M1200Z",
        M1200_POSITIVE,
        "M1200Z None is mutually exclusive with positive skin treatment selections.",
      ),
    ];
  },
};

const sectionNRule: HopeValidationRule = {
  id: "hope-v1.00.1-section-n",
  evaluate(ctx) {
    const out: HopeRuleFinding[] = [];
    if (answerValue(ctx.answers, "N0500A") === "1" && ctx.mode === "final")
      out.push(...requireDate(ctx, "N0500B", "-3049"));
    if (answerValue(ctx.answers, "N0510A") === "1" && ctx.mode === "final")
      out.push(...requireDate(ctx, "N0510B", "-3050"));
    if (answerValue(ctx.answers, "N0520A") === "2" && ctx.mode === "final")
      out.push(...requireDate(ctx, "N0520B", "-3051"));
    if (
      (answerValue(ctx.answers, "N0500A") === "1" || answerValue(ctx.answers, "N0510A") === "1") &&
      ctx.mode === "final"
    ) {
      out.push(...required(ctx, "N0520A", "-3059"));
    }
    if (answerValue(ctx.answers, "N0500A") === "0" && answerValue(ctx.answers, "N0510A") === "0") {
      for (const code of ["N0520A", "N0520B"])
        if (isAnswered(ctx.answers, code)) {
          out.push(
            finding({
              ruleId: "-3060",
              severity: "error",
              findingKind: "invalid_skip_state",
              itemCode: code,
              message: `${code} must be skipped when scheduled and PRN opioid items both indicate no opioid use.`,
            }),
          );
        }
    }
    if (
      (answerValue(ctx.answers, "N0500A") === "1" || answerValue(ctx.answers, "N0510A") === "1") &&
      answerValue(ctx.answers, "J0905") === "0"
    ) {
      out.push(
        finding({
          ruleId: "-3077",
          severity: "warning",
          findingKind: "inconsistent_value",
          itemCode: "N0500A",
          message:
            "Opioid use is present while J0905 indicates no active pain; confirm non-pain symptom use as appropriate.",
        }),
      );
    }
    return out;
  },
};

const dateOrderRule: HopeValidationRule = {
  id: "hope-v1.00.1-date-order",
  evaluate(ctx) {
    const out: HopeRuleFinding[] = [];
    out.push(...dateOrder(ctx, "A0900", "A0220"));
    out.push(...dateOrder(ctx, "A0220", "Z0350"));
    out.push(...dateOrder(ctx, "Z0350", "A0270"));
    out.push(...dateOrder(ctx, "A0270", "Z0500B"));
    out.push(...dateOrder(ctx, "A0220", "Z0500B"));
    for (const code of CLINICAL_DATES) {
      out.push(...dateOrder(ctx, "A0220", code));
      out.push(...dateOrder(ctx, code, "Z0500B"));
    }
    for (const code of F_DATES) out.push(...dateOrder(ctx, code, "Z0500B"));
    if (ctx.submissionDate) {
      const admission = answerValue(ctx.answers, "A0220");
      const lag = admission ? daysBetween(ctx.submissionDate, admission) : null;
      if (
        ctx.assessment.rfaKind === "01_admission" &&
        answerValue(ctx.answers, "A0050") === "1" &&
        lag != null &&
        lag > 30
      ) {
        out.push(
          finding({
            ruleId: "-3034",
            severity: "warning",
            findingKind: "timing",
            itemCode: "A0220",
            message: "Admission submission is more than 30 days after A0220.",
            details: {
              admissionDate: admission,
              submissionDate: ctx.submissionDate,
              days: lag,
            },
          }),
        );
      }
    }
    const admission = answerValue(ctx.answers, "A0220");
    const completed = answerValue(ctx.answers, "Z0350");
    if (admission && completed && ctx.assessment.isc === "HUV") {
      const lag = daysBetween(completed, admission);
      const reason = answerValue(ctx.answers, "A0250");
      const min = reason === "2" ? 6 : reason === "3" ? 16 : null;
      const max = reason === "2" ? 15 : reason === "3" ? 30 : null;
      if (lag != null && min != null && max != null && (lag < min || lag > max)) {
        out.push(
          finding({
            ruleId: "-3110",
            severity: "warning",
            findingKind: "timing",
            itemCode: "Z0350",
            message: `HUV assessment completion date is outside the expected A0220 + ${min}-${max} day window.`,
            details: {
              admissionDate: admission,
              completedDate: completed,
              days: lag,
              reasonForRecord: reason,
            },
          }),
        );
      }
    }
    return out;
  },
};

const recordConsistencyRule: HopeValidationRule = {
  id: "wardenx-hope-record-consistency",
  evaluate(ctx) {
    const a0050 = answerValue(ctx.answers, "A0050");
    const a0250 = answerValue(ctx.answers, "A0250");
    const expected =
      ctx.assessment.rfaKind === "01_admission"
        ? { isc: "HA", a0250: "1" }
        : ctx.assessment.rfaKind === "02_huv1"
          ? { isc: "HUV", a0250: "2" }
          : ctx.assessment.rfaKind === "03_huv2"
            ? { isc: "HUV", a0250: "3" }
            : ctx.assessment.rfaKind === "05_discharge"
              ? { isc: "HD", a0250: "9" }
              : null;
    const out: HopeRuleFinding[] = [];
    if (a0050 === "3") {
      if (ctx.assessment.isc !== "XX" || !ctx.assessment.correctsAssessmentId) {
        out.push(
          finding({
            ruleId: "WX-HOPE-RECORD-003",
            severity: "error",
            findingKind: "record_consistency",
            itemCode: "A0050",
            section: "A",
            message: "HOPE inactivation records must use ISC XX and target a signed source record.",
            details: {
              correctsAssessmentId: ctx.assessment.correctsAssessmentId,
              isc: ctx.assessment.isc,
              a0050,
            },
          }),
        );
      }
      if (expected && a0250 !== expected.a0250) {
        out.push(
          finding({
            ruleId: "WX-HOPE-RECORD-001",
            severity: "error",
            findingKind: "record_consistency",
            itemCode: "A0250",
            section: "A",
            message:
              "HOPE inactivation reason does not match the M10 workflow kind being inactivated.",
            details: {
              rfaKind: ctx.assessment.rfaKind,
              isc: ctx.assessment.isc,
              a0250,
              expected,
            },
          }),
        );
      }
      return out;
    }
    if (expected && (ctx.assessment.isc !== expected.isc || a0250 !== expected.a0250)) {
      out.push(
        finding({
          ruleId: "WX-HOPE-RECORD-001",
          severity: "error",
          findingKind: "record_consistency",
          itemCode: "A0250",
          section: "A",
          message: "HOPE record identity does not match the M10 workflow kind.",
          details: {
            rfaKind: ctx.assessment.rfaKind,
            isc: ctx.assessment.isc,
            a0250,
            expected,
          },
        }),
      );
    }
    const expectedA0050 = ctx.assessment.correctsAssessmentId ? "2" : "1";
    if (expected && a0050 !== expectedA0050) {
      out.push(
        finding({
          ruleId: "WX-HOPE-RECORD-002",
          severity: "error",
          findingKind: "record_consistency",
          itemCode: "A0050",
          section: "A",
          message: "A0050 does not match the ChartWarden correction/add lifecycle.",
          details: {
            correctsAssessmentId: ctx.assessment.correctsAssessmentId,
            a0050,
            expectedA0050,
          },
        }),
      );
    }
    return out;
  },
};

export const HOPE_V1_00_1_VALIDATION_RULES: readonly HopeValidationRule[] = [
  requirednessRule,
  skipStateRule,
  sectionARule,
  sectionFRule,
  sectionJRule,
  sectionMRule,
  sectionNRule,
  dateOrderRule,
  recordConsistencyRule,
];

export function createHopeV1_00_1ValidationEngine(): HopeValidationEngine {
  return {
    specVersionCode: "1.00.1",
    rules: HOPE_V1_00_1_VALIDATION_RULES,
    evaluate(ctx) {
      return HOPE_V1_00_1_VALIDATION_RULES.flatMap((rule) => rule.evaluate(ctx));
    },
  };
}
