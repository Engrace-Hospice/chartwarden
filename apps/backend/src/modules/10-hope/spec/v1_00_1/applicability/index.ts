import {
  answerValue,
  assertAcyclicApplicabilityRules,
  createRule,
  evaluateRules,
  type HopeAnswerMap,
  type HopeApplicabilityEngine,
  type HopeApplicabilityRule,
  type HopeApplicabilityState,
} from "../../applicability";

const J0910_ITEMS = ["J0910A", "J0910B", "J0910C1", "J0910C2", "J0910C3", "J0910C4", "J0910C5", "J0910C6", "J0910C7", "J0910C9"];
const J0910_DETAIL_ITEMS = J0910_ITEMS.slice(1);
const J2051_ITEMS = ["J2051A", "J2051B", "J2051C", "J2051D", "J2051E", "J2051F", "J2051G", "J2051H"];
const J2052_2053_ITEMS = ["J2052A", "J2052B", "J2052C", "J2053A", "J2053B", "J2053C", "J2053D", "J2053E", "J2053F", "J2053G", "J2053H"];
const J2053_ITEMS = ["J2053A", "J2053B", "J2053C", "J2053D", "J2053E", "J2053F", "J2053G", "J2053H"];
const M_SKIN_ITEMS = [
  "M1195A", "M1195B", "M1195C", "M1195D", "M1195E", "M1195F", "M1195G", "M1195H", "M1195Z",
  "M1200A", "M1200B", "M1200C", "M1200D", "M1200E", "M1200F", "M1200G", "M1200H", "M1200I", "M1200J", "M1200Z",
];

function oneToMany(
  id: string,
  cmsRuleId: string,
  parent: string,
  children: readonly string[],
  yesValues: readonly string[],
  noValues: readonly string[],
  description: string,
): HopeApplicabilityRule {
  return createRule({
    id,
    cmsRuleId,
    description,
    dependsOn: [parent],
    affects: children,
    evaluate(answers) {
      const value = answerValue(answers, parent);
      const state: HopeApplicabilityState = value == null ? "pending" : noValues.includes(value) ? "not_applicable" : yesValues.includes(value) ? "applicable" : "pending";
      return Object.fromEntries(children.map((child) => [child, state]));
    },
  });
}

function j2051Trigger(answers: HopeAnswerMap): "true" | "false" | "pending" {
  const values = J2051_ITEMS.map((item) => answerValue(answers, item));
  if (values.some((value) => value === "2" || value === "3")) return "true";
  if (values.every((value) => value === "0" || value === "1" || value === "9")) return "false";
  return "pending";
}

export const HOPE_V1_00_1_APPLICABILITY_RULES: readonly HopeApplicabilityRule[] = [
  oneToMany("hope-v1.00.1-f2000-date", "-3035", "F2000A", ["F2000B"], ["1", "2"], ["0"], "CPR preference date follows F2000A."),
  oneToMany("hope-v1.00.1-f2100-date", "-3036", "F2100A", ["F2100B"], ["1", "2"], ["0"], "Other life-sustaining treatment preference date follows F2100A."),
  oneToMany("hope-v1.00.1-f2200-date", "-3037", "F2200A", ["F2200B"], ["1", "2"], ["0"], "Hospitalization preference date follows F2200A."),
  oneToMany("hope-v1.00.1-f3000-date", "-3038", "F3000A", ["F3000B"], ["1", "2"], ["0"], "Spiritual concern date follows F3000A."),

  oneToMany("hope-v1.00.1-j0900-pain-screen", "-3066", "J0900A", ["J0900B", "J0900C", "J0900D"], ["1"], ["0"], "Pain screening details follow J0900A."),
  oneToMany("hope-v1.00.1-j0905-active-pain", "-3067", "J0905", J0910_ITEMS, ["1"], ["0"], "Comprehensive pain assessment branch follows active pain."),
  oneToMany("hope-v1.00.1-j0910-comprehensive-pain", "-3040", "J0910A", J0910_DETAIL_ITEMS, ["1"], ["0"], "Pain assessment details follow J0910A."),

  oneToMany("hope-v1.00.1-j2030-screen", "-3043", "J2030A", ["J2030B", "J2030C", "J2040A", "J2040B"], ["1"], ["0"], "Shortness-of-breath branch follows J2030A."),
  oneToMany("hope-v1.00.1-j2030-positive", "-3045", "J2030C", ["J2040A", "J2040B"], ["1"], ["0"], "Shortness-of-breath treatment branch follows J2030C."),
  oneToMany("hope-v1.00.1-j2040-treatment-date", "-3047", "J2040A", ["J2040B"], ["2"], ["0", "1"], "Shortness-of-breath treatment date follows J2040A."),

  oneToMany("hope-v1.00.1-j2050-symptom-impact", "-3091", "J2050A", ["J2050B", ...J2051_ITEMS, ...J2052_2053_ITEMS], ["1"], ["0"], "Symptom impact screening branch follows J2050A."),
  createRule({
    id: "hope-v1.00.1-j2051-sfv-trigger",
    cmsRuleId: "-3108",
    description: "J2052/J2053 branch follows any moderate/severe J2051 symptom impact.",
    dependsOn: J2051_ITEMS,
    affects: J2052_2053_ITEMS,
    evaluate(answers) {
      const trigger = j2051Trigger(answers);
      const state: HopeApplicabilityState = trigger === "true" ? "applicable" : trigger === "false" ? "not_applicable" : "pending";
      return Object.fromEntries(J2052_2053_ITEMS.map((item) => [item, state]));
    },
  }),
  oneToMany("hope-v1.00.1-j2052-date", "-3092", "J2052A", ["J2052B"], ["1"], ["0"], "SFV date follows completed SFV flag."),
  oneToMany("hope-v1.00.1-j2052-reason", "-3106", "J2052A", ["J2052C"], ["0"], ["1"], "SFV not-completed reason follows completed SFV flag."),
  oneToMany("hope-v1.00.1-j2053-reassessment", "-3109", "J2052A", J2053_ITEMS, ["1"], ["0"], "SFV reassessment symptom impacts follow completed SFV flag."),

  oneToMany("hope-v1.00.1-m1190-skin-branch", "-3093", "M1190", M_SKIN_ITEMS, ["1"], ["0"], "Skin condition and treatment branch follows M1190."),

  oneToMany("hope-v1.00.1-n0500-date", "-3049", "N0500A", ["N0500B"], ["1"], ["0"], "Scheduled opioid date follows N0500A."),
  oneToMany("hope-v1.00.1-n0510-date", "-3050", "N0510A", ["N0510B"], ["1"], ["0"], "PRN opioid date follows N0510A."),
  createRule({
    id: "hope-v1.00.1-n0520-opioid-bowel-branch",
    cmsRuleId: "-3060",
    description: "Bowel regimen branch follows scheduled or PRN opioid use.",
    dependsOn: ["N0500A", "N0510A"],
    affects: ["N0520A", "N0520B"],
    evaluate(answers) {
      const scheduled = answerValue(answers, "N0500A");
      const prn = answerValue(answers, "N0510A");
      const state: HopeApplicabilityState =
        scheduled === "1" || prn === "1"
          ? "applicable"
          : scheduled === "0" && prn === "0"
            ? "not_applicable"
            : "pending";
      return { N0520A: state, N0520B: state };
    },
  }),
  oneToMany("hope-v1.00.1-n0520-date", "-3051", "N0520A", ["N0520B"], ["2"], ["0", "1"], "Bowel regimen date follows N0520A."),
];

assertAcyclicApplicabilityRules(HOPE_V1_00_1_APPLICABILITY_RULES);

export function createHopeV1_00_1ApplicabilityEngine(): HopeApplicabilityEngine {
  return {
    specVersionCode: "1.00.1",
    rules: HOPE_V1_00_1_APPLICABILITY_RULES,
    evaluate(input) {
      return evaluateRules({ ...input, rules: HOPE_V1_00_1_APPLICABILITY_RULES });
    },
  };
}
