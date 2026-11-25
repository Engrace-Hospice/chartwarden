// @chartwarden/types — dyspnea assessment at a hospice visit and the advisory prompt to review the plan of care.
//
// ONE place for the codes and rules behind the visit-note composer's "Dyspnea assessment" helper, which hangs off the
// "dyspnea limiting function" statement the way the pain helper hangs off the pain statements, and for the statements the
// narrative corpus ships (`packages/narrative-vocab/src/dyspnea-assessment-entries.ts`; a test there pins the two together).
// The pain helper's constants it shares (`PAIN_SCORE_MAX`, `PAIN_SFV_WINDOW_DAYS`, `PAIN_PLAN_REVIEW_MAX_DAYS`,
// `PAIN_PLAN_DECISIONS`) come from `pain-assessment.ts`; the reason, reference and basis types are reused from there.
//
// ADVISORY ONLY. Nothing here is read by the finalize or sign gate, nothing blocks a note, and nothing changes a plan of care:
// a prompt names its reasons and points the clinician at the Plan of care step. The clinician and the IDG decide.
//
// NO SOURCE DEFINES A DYSPNEA SEVERITY BAND, A RISE THRESHOLD OR A TRIGGER, SO NONE EXISTS HERE. There is no numeric cut-off of any
// kind: no "severe" range on the 0 to 10 score, no rise that prompts a call, no heart rate, respiratory rate or oxygen saturation
// trigger, no behavioural-scale (RDOS or other) score or cut-off, no dose, oxygen, opioid or titration suggestion, no required
// count, no timing hint, no auto-filled value and no HOPE impact category computed from a score. A score is only ever compared
// with the patient's own acceptable level, as the clinician typed it. The "n of 8" count is a count of documented items, never a
// benchmark. Every number in a reason is one the clinician typed (apart from the scale's own "of 10"). ESAS-calibration values do
// exist for the dyspnea item (Selby 2010, second-hand; Yamaguchi 2016, which its authors call unreliable), but they calibrate the
// patient's own mild, moderate and severe words and are not action thresholds, so none of them is used.
//
// EVERY REASON CITES ITS SOURCE and its type (regulation, CMS guidance, guideline, common practice). The sources, the retrieval
// date and where they differ are in docs/research/DYSPNEA_ASSESSMENT_AND_PLAN_OF_CARE_RESEARCH.md. The sign-off sheet's section 7 was
// signed off by Lora, RN on 2026-11-25 as a whole (per-row boxes left blank); do not read anything here as a clinical rule beyond its
// stated source.
import {
  PAIN_PLAN_DECISIONS,
  PAIN_PLAN_REVIEW_MAX_DAYS,
  PAIN_SCORE_MAX,
  PAIN_SFV_WINDOW_DAYS,
  type PainSelection,
  type PlanReviewReason,
  type PlanReviewReference,
} from "./pain-assessment";

/** The existing "dyspnea limiting function" statement the helper hangs off. It is unchanged; the helper adds statements beside it. */
export const DYSPNEA_STATEMENT_CODE = "nv.sym.dyspnea_impact";

/** The statements of the helper, one per recorded item. A slot name is a `${slot}` in the corpus phrase. */
export const DYSPNEA_ASSESSMENT_CODES = {
  score: "nv.sym.dyspnea_score",
  onset: "nv.sym.dyspnea_onset",
  setting: "nv.sym.dyspnea_setting",
  triggers: "nv.sym.dyspnea_triggers",
  relievedBy: "nv.sym.dyspnea_relieved_by",
  quality: "nv.sym.dyspnea_quality",
  distress: "nv.sym.dyspnea_distress",
  function: "nv.sym.dyspnea_function",
  nonDrug: "nv.sym.dyspnea_nondrug",
  response: "nv.sym.dyspnea_response",
  goal: "nv.sym.dyspnea_goal",
  lastScore: "nv.sym.dyspnea_last_score",
  change: "nv.sym.dyspnea_change",
  nonverbal: "nv.sym.dyspnea_nonverbal",
  planDecision: "nv.sym.dyspnea_plan_decision",
} as const;

export type DyspneaAssessmentCode =
  (typeof DYSPNEA_ASSESSMENT_CODES)[keyof typeof DYSPNEA_ASSESSMENT_CODES];

const DYSPNEA_ASSESSMENT_CODE_SET: ReadonlySet<string> = new Set(
  Object.values(DYSPNEA_ASSESSMENT_CODES),
);

/** Whether a corpus code is one of the helper's statements (the composer lists those in the helper, not in the flat menu). */
export function isDyspneaAssessmentCode(code: string): boolean {
  return DYSPNEA_ASSESSMENT_CODE_SET.has(code);
}

/** The `${slot}` name each helper statement fills (one slot per statement). */
export const DYSPNEA_SLOTS = {
  score: "dyspnea_score",
  onset: "dyspnea_onset",
  setting: "dyspnea_setting",
  triggers: "dyspnea_triggers",
  relievedBy: "dyspnea_relieved_by",
  quality: "dyspnea_quality",
  distress: "dyspnea_distress",
  function: "dyspnea_function",
  nonDrug: "dyspnea_nondrug",
  response: "dyspnea_response",
  goal: "dyspnea_goal",
  lastScore: "dyspnea_last_score",
  change: "dyspnea_change",
  nonverbal: "dyspnea_nonverbal",
  planDecision: "dyspnea_plan_decision",
} as const;

/** What the clinician may pick where the corpus offers a choice. The corpus carries the same strings (a test pins them). */
export const DYSPNEA_SETTING_OPTIONS = [
  "at rest",
  "on exertion",
  "at rest and on exertion",
  "at other times",
] as const;
export const DYSPNEA_RESPONSE_OPTIONS = [
  "complete relief",
  "partial relief",
  "no relief",
  "no measures tried",
] as const;
/** Not `PAIN_CHANGE_OPTIONS`: its fourth choice reads "new pain". */
export const DYSPNEA_CHANGE_OPTIONS = ["improved", "unchanged", "worsened", "new dyspnea"] as const;
/** The same four decisions the pain helper offers; the corpus phrase says "dyspnea", the choice strings do not. */
export const DYSPNEA_PLAN_DECISIONS = PAIN_PLAN_DECISIONS;

// ── the eight characteristics ───────────────────────────────────────────────────────────────────────────────────
// Each counts once its value is filled in. None of the sources gives a number of characteristics that must be documented, so the
// count is shown and never judged. The sources are listed here as a group, NOT mapped one to one to the characteristics: the
// research doc lists the National Consensus Project sections 2.1.1 to 2.3.10 together, and "when it occurs" has no source read.
//   - ATS statement: Parshall et al., Am J Respir Crit Care Med 2012;185:435-452 (the sensory, affective-distress and impact
//     dimensions of dyspnea: intensity and quality, distress, effect on function);
//   - National Consensus Project guidelines 4th ed. 2.1.1, 2.2.2, 2.2.4, 2.2.5, 2.3.4 and 2.3.10;
//   - CMS HOPE Guidance Manual v1.03, J2030, J2040 and J2051;
//   - ESMO: Crawford et al., ESMO Open 2021;6:100225;
//   - NHPCO Care Planning Primer (2023).

export const DYSPNEA_CHARACTERISTICS = [
  "intensity",
  "onset",
  "setting",
  "triggers",
  "relieved_by",
  "quality",
  "distress",
  "function",
] as const;

export type DyspneaCharacteristic = (typeof DYSPNEA_CHARACTERISTICS)[number];

export const DYSPNEA_CHARACTERISTIC_LABELS: Readonly<Record<DyspneaCharacteristic, string>> = {
  intensity: "Intensity",
  onset: "Onset",
  setting: "When it occurs",
  triggers: "What brings it on or worsens it",
  relieved_by: "What relieves it",
  quality: "Quality (what it feels like)",
  distress: "Distress or anxiety",
  function: "Effect on function",
};

// ── reading the selections ──────────────────────────────────────────────────────────────────────────────────────

/** A selected statement as the composer holds it (a value is a string typed in the form, or a number from a stored note). */
export type DyspneaSelection = PainSelection;

const NUMERIC = /^-?\d+(\.\d+)?$/;

function textOf(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function numberOf(value: string | number | undefined): number | null {
  const text = textOf(value);
  if (text === null || !NUMERIC.test(text)) return null;
  const n = Number(text);
  return n >= 0 && n <= PAIN_SCORE_MAX ? n : null;
}

function choiceOf<T extends string>(
  options: readonly T[],
  value: string | number | undefined,
): T | null {
  const text = textOf(value);
  return options.find((o) => o === text) ?? null;
}

/** The value a selected statement holds for one slot (undefined when the statement is not selected or the slot is empty). */
function slotValue(
  selections: readonly DyspneaSelection[],
  code: string,
  slot: string,
): string | number | undefined {
  return selections.find((s) => s.code === code)?.params?.[slot];
}

function isSelected(selections: readonly DyspneaSelection[], code: string): boolean {
  return selections.some((s) => s.code === code);
}

/** What the recorded statements say about the dyspnea, in the terms the rules below use. `null` is "not recorded". */
export interface DyspneaFacts {
  readonly hasDyspneaStatement: boolean;
  readonly score: number | null;
  readonly goal: number | null;
  readonly change: (typeof DYSPNEA_CHANGE_OPTIONS)[number] | null;
  readonly response: (typeof DYSPNEA_RESPONSE_OPTIONS)[number] | null;
}

const C = DYSPNEA_ASSESSMENT_CODES;
const S = DYSPNEA_SLOTS;

export function dyspneaFactsFrom(selections: readonly DyspneaSelection[]): DyspneaFacts {
  const value = (code: string, slot: string) => slotValue(selections, code, slot);
  return {
    hasDyspneaStatement: isSelected(selections, DYSPNEA_STATEMENT_CODE),
    score: numberOf(value(C.score, S.score)),
    goal: numberOf(value(C.goal, S.goal)),
    change: choiceOf(DYSPNEA_CHANGE_OPTIONS, value(C.change, S.change)),
    response: choiceOf(DYSPNEA_RESPONSE_OPTIONS, value(C.response, S.response)),
  };
}

// ── completeness: how many of the eight are documented ─────────────────────────────────────────────────────────

/** The statement and slot whose filled-in text documents each characteristic that is plain text (intensity and function differ). */
const TEXT_SOURCES: Readonly<
  Record<Exclude<DyspneaCharacteristic, "intensity" | "function">, readonly [string, string]>
> = {
  onset: [C.onset, S.onset],
  setting: [C.setting, S.setting],
  triggers: [C.triggers, S.triggers],
  relieved_by: [C.relievedBy, S.relievedBy],
  quality: [C.quality, S.quality],
  distress: [C.distress, S.distress],
};

export interface DyspneaCompleteness {
  readonly documented: readonly DyspneaCharacteristic[];
  readonly missing: readonly DyspneaCharacteristic[];
  readonly count: number;
  readonly total: number;
}

/**
 * Intensity counts when the dyspnea score statement holds a valid score OR the nonverbal ("signs observed") text is filled in (a
 * patient who cannot self-report would otherwise always show intensity missing). Effect on function counts when the "dyspnea
 * limiting function" statement is picked OR the function text is filled in. The rest are one statement each. A count only: no
 * source gives a number that is enough, so there is no benchmark flag.
 */
export function dyspneaCompleteness(selections: readonly DyspneaSelection[]): DyspneaCompleteness {
  const facts = dyspneaFactsFrom(selections);
  const filled = (code: string, slot: string): boolean =>
    textOf(slotValue(selections, code, slot)) !== null;
  const done = (characteristic: DyspneaCharacteristic): boolean => {
    if (characteristic === "intensity") {
      return facts.score !== null || filled(C.nonverbal, S.nonverbal);
    }
    if (characteristic === "function") {
      return facts.hasDyspneaStatement || filled(C.function, S.function);
    }
    return filled(...TEXT_SOURCES[characteristic]);
  };
  const documented = DYSPNEA_CHARACTERISTICS.filter(done);
  return {
    documented,
    missing: DYSPNEA_CHARACTERISTICS.filter((c) => !documented.includes(c)),
    count: documented.length,
    total: DYSPNEA_CHARACTERISTICS.length,
  };
}

// ── the advisory prompt to review the plan of care ─────────────────────────────────────────────────────────────

export type DyspneaPlanReviewReasonId =
  | "function_limit"
  | "above_goal"
  | "worsening"
  | "new_dyspnea"
  | "not_relieved";

/** A pain prompt's reason with the dyspnea ids (`PlanReviewReasonId` has no `new_dyspnea`); basis and source work the same way. */
export interface DyspneaPlanReviewReason extends Omit<PlanReviewReason, "id"> {
  readonly id: DyspneaPlanReviewReasonId;
}

/** Shared by worsening and new dyspnea. CMS guidance, not a rule: 418.54(d) and 418.56(d) set only a general duty. */
const RE_EVALUATE_SOURCE =
  "CMS State Operations Manual, Appendix M, 418.56(c)(1) (re-evaluate the current plan of care); 42 CFR 418.54(d) and 418.56(d) set only a general duty to update as often as the condition requires";

const FUNCTION_LIMIT: DyspneaPlanReviewReason = {
  id: "function_limit",
  text: "Dyspnea is limiting function, so any comfort and function goal in the plan of care may not be met.",
  basis: "guideline",
  source:
    "National Consensus Project guidelines 4th ed. 2.1.1 and 2.3.4; CMS State Operations Manual, Appendix M, 418.56(c)(1) (re-evaluate the current plan of care)",
};

const WORSENING: DyspneaPlanReviewReason = {
  id: "worsening",
  text: "Dyspnea is worse than at the last visit.",
  basis: "cms_guidance",
  source: RE_EVALUATE_SOURCE,
};

const NEW_DYSPNEA: DyspneaPlanReviewReason = {
  id: "new_dyspnea",
  text: "This dyspnea is new since the last visit.",
  basis: "cms_guidance",
  source: RE_EVALUATE_SOURCE,
};

const NOT_RELIEVED: DyspneaPlanReviewReason = {
  id: "not_relieved",
  text: "The measures tried for dyspnea gave no relief.",
  basis: "guideline",
  source:
    "National Consensus Project guidelines 4th ed. 2.2.4 and 2.3.4 (timely reassessment after treatment starts; re-evaluate response)",
};

function aboveGoal(score: number, goal: number): DyspneaPlanReviewReason {
  return {
    id: "above_goal",
    text: `Dyspnea is ${score} of ${PAIN_SCORE_MAX}, above the patient's own acceptable level of ${goal}.`,
    basis: "common_practice",
    source:
      "NHPCO Care Planning Primer (2023): a goal not met means the interventions are reviewed; National Consensus Project guidelines 4th ed. 2.1.1",
  };
}

/**
 * Why the plan of care for dyspnea may need a look, from what the visit's statements record. The function limit is named only when
 * the "dyspnea limiting function" statement is picked; the other reasons come from the helper's own statements whether or not that
 * statement is picked, so unticking it never hides a reason the helper rows still show. Empty when nothing applies. Deterministic
 * and ordered. Each reason carries its type and source so the screen can say what kind of prompt it is. There is no severity
 * reason and no rise reason: a score alone, high or not, adds nothing.
 */
export function dyspneaPlanReviewReasons(
  selections: readonly DyspneaSelection[],
): readonly DyspneaPlanReviewReason[] {
  const facts = dyspneaFactsFrom(selections);
  const { score, goal } = facts;
  return [
    ...(facts.hasDyspneaStatement ? [FUNCTION_LIMIT] : []),
    ...(score !== null && goal !== null && score > goal ? [aboveGoal(score, goal)] : []),
    ...(facts.change === "worsened" ? [WORSENING] : []),
    ...(facts.change === "new dyspnea" ? [NEW_DYSPNEA] : []),
    ...(facts.response === "no relief" ? [NOT_RELIEVED] : []),
  ];
}

/**
 * What the prompt reminds the clinician of, beside the reasons: two fixed notes. There is no level-of-care note for dyspnea: no
 * source ties dyspnea to a change in the level of care, and "no relief" from non-drug measures alone is not that.
 */
export function dyspneaPlanReviewReference(): readonly PlanReviewReference[] {
  return [
    {
      id: "idg_cadence",
      text: `The IDG, with the attending physician, reviews and revises the plan of care as often as the patient's condition requires, and at least every ${PAIN_PLAN_REVIEW_MAX_DAYS} calendar days.`,
      basis: "regulation",
      source: "42 CFR 418.56(d)",
    },
    {
      id: "hope_follow_up",
      text: `At a HOPE admission or update visit, a moderate or severe impact of shortness of breath calls for an in-person follow-up visit within ${PAIN_SFV_WINDOW_DAYS} calendar days. That impact is how much the shortness of breath affects the patient (HOPE records not at all, slight, moderate or severe); it is not the 0 to ${PAIN_SCORE_MAX} score, and no score converts to it.`,
      basis: "cms_guidance",
      source: "CMS HOPE Guidance Manual v1.03, J2051 and J2052",
    },
  ];
}
