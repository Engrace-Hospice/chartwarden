// @chartwarden/types — pain assessment at a hospice visit and the advisory prompt to review the plan of care.
//
// ONE place for the codes, thresholds and rules behind the visit-note composer's "Pain assessment" helper and its
// plan-of-care prompt (apps/web, `pain-assessment-helper.tsx` and `plan-review-prompt.tsx`), and for the statements the
// narrative corpus ships (`packages/narrative-vocab/src/pain-assessment-entries.ts`; a test there pins the two together).
//
// ADVISORY ONLY. Nothing here is read by the finalize or sign gate, nothing blocks a note, and nothing changes a plan of care:
// a prompt names its reasons and points the clinician at the Plan of care step. The clinician and the IDG decide.
//
// EVERY THRESHOLD CITES ITS SOURCE and its type (regulation, CMS guidance, guideline, common practice, research). The sources, the
// retrieval date and where they differ are in docs/research/PAIN_ASSESSMENT_AND_PLAN_OF_CARE_TRIGGERS_RESEARCH.md. The clinical
// content has NOT been signed off by a clinician; do not read a number here as a clinical rule beyond its stated source.

/** The two pain statements the helper hangs off. */
export const PAIN_STATEMENT_CODES = {
  controlled: "nv.sym.pain_controlled",
  limiting: "nv.sym.pain_uncontrolled",
} as const;

/** The statements of the helper, one per recorded item. A slot name is a `${slot}` in the corpus phrase. */
export const PAIN_ASSESSMENT_CODES = {
  location: "nv.sym.pain_location",
  character: "nv.sym.pain_character",
  duration: "nv.sym.pain_duration",
  frequency: "nv.sym.pain_frequency",
  worsenedBy: "nv.sym.pain_worsened_by",
  relievedBy: "nv.sym.pain_relieved_by",
  prnRelief: "nv.sym.pain_prn_relief",
  sideEffects: "nv.sym.pain_side_effects",
  bowelRegimen: "nv.sym.pain_bowel_regimen",
  oralBarrier: "nv.sym.pain_oral_barrier",
  nonverbal: "nv.sym.pain_nonverbal",
  observationScale: "nv.sym.pain_observation_scale",
  goal: "nv.sym.pain_goal",
  lastScore: "nv.sym.pain_last_score",
  change: "nv.sym.pain_change",
  planDecision: "nv.sym.pain_plan_decision",
} as const;

export type PainAssessmentCode = (typeof PAIN_ASSESSMENT_CODES)[keyof typeof PAIN_ASSESSMENT_CODES];

const PAIN_ASSESSMENT_CODE_SET: ReadonlySet<string> = new Set(Object.values(PAIN_ASSESSMENT_CODES));

/** Whether a corpus code is one of the helper's statements (the composer lists those in the helper, not in the flat menu). */
export function isPainAssessmentCode(code: string): boolean {
  return PAIN_ASSESSMENT_CODE_SET.has(code);
}

/** The `${slot}` names the helper fills. */
export const PAIN_SLOTS = {
  score: "pain_score",
  goal: "pain_goal",
  lastScore: "pain_last_score",
  change: "pain_change",
  prnRelief: "pain_prn_relief",
  observationTool: "observation_tool",
  observationScore: "observation_score",
  oralBarrier: "oral_barrier",
  planDecision: "pain_plan_decision",
} as const;

/** What the clinician may pick where the corpus offers a choice. The corpus carries the same strings (a test pins them). */
export const PAIN_RELIEF_OPTIONS = [
  "complete relief",
  "partial relief",
  "no relief",
  "no dose taken",
] as const;
export const PAIN_CHANGE_OPTIONS = ["improved", "unchanged", "worsened", "new pain"] as const;
// PAINAD and FLACC are the two staff-observation scales HOPE names that score 0 to 10 (five items scored 0 to 2).
// Source: CMS HOPE Guidance Manual v1.03, Table 5 (staff observation); PAINAD tool text (Warden 2003); FLACC tool text (Merkel 1997).
// The other HOPE staff-observation examples (CPOT, CNPI) are left out: their score ranges were not verified.
export const PAIN_OBSERVATION_TOOLS = ["PAINAD", "FLACC"] as const;
export const PAIN_PLAN_DECISIONS = [
  "no change to the current plan of care",
  "physician notified",
  "IDG plan-of-care review requested",
  "physician notified and IDG plan-of-care review requested",
] as const;

/** The highest value of a 0 to 10 numeric pain scale. */
export const PAIN_SCORE_MAX = 10;

/**
 * "Severe" on the 10-point numeric scale: 7 to 10. Type: CMS guidance (a reporting band, not a clinical cut-off).
 * Source: CMS HOPE Guidance Manual v1.03, J0900, Table 4 (0 none, 1-3 mild, 4-6 moderate, 7-10 severe).
 * Sources differ: the NCCN Adult Cancer Pain article text (JNCCN 2019) puts severe at 8 to 10, while NCCN v2.2023 PAIN-A puts it at
 * 7 to 10, the same as HOPE (read in the text 2026-11-25; research doc rows 3.10a and 3.10b). This corpus is HOPE-aligned, so the
 * HOPE band is used and the prompt labels it as the CMS HOPE scale.
 */
export const PAIN_SEVERE_MIN_SCORE = 7;

/**
 * A rise of this many points on the 0 to 10 scale since the last visit is a meaningful change. Type: research benchmark.
 * Source: Farrar JT et al., Pain 2001;94:149-158 (about 2 points, or about 30%, on an 11-point scale, in chronic pain trials;
 * secondary citations only). Other populations quote 1 to 2 points.
 */
export const PAIN_MEANINGFUL_RISE_POINTS = 2;

/**
 * The HOPE comprehensive pain assessment lists seven characteristics; the CMS quality measure counts the assessment done when at
 * least this many are checked, for the ADMISSION assessment, within 1 day of a positive pain screen. Type: CMS guidance (a quality
 * reporting measure; not a condition of participation and not a visit-note rule). HOPE itself codes the assessment done if even
 * one characteristic was attempted.
 * Source: CMS HQRP Quality Measure Specifications User's Manual v1.04, ch. 2 (CBE #3235, pain component); HOPE v1.03 J0910.
 */
export const PAIN_HQRP_MIN_CHARACTERISTICS = 5;

/** HOPE: a moderate or severe symptom impact at admission or an update visit calls for an in-person follow-up within this many calendar days. Type: CMS guidance (quality reporting). Source: HOPE v1.03 J2052; QM manual ch. 5. */
export const PAIN_SFV_WINDOW_DAYS = 2;

/** The plan of care is reviewed as often as the condition requires and at least this often. Type: regulation. Source: 42 CFR 418.56(d); 418.54(d) for the assessment. */
export const PAIN_PLAN_REVIEW_MAX_DAYS = 15;

/** After an as-needed dose, reassess once the peak effect has had time. Type: guideline. Source: Fast Facts and Concepts #70 (Gordon, 2025); NCP 4th ed. 2.2.4. */
export const PAIN_PRN_REASSESS_HINT =
  "Reassess once the dose has had time to work: about 1 hour after an oral dose, 15 to 30 minutes after an injected dose.";

// ── the seven characteristics ───────────────────────────────────────────────────────────────────────────────────
// Source: CMS HOPE Guidance Manual v1.03, J0910C (items 1 to 7); SOM Appendix M, interpretive guidelines for 418.54(c).

export const PAIN_CHARACTERISTICS = [
  "severity",
  "location",
  "character",
  "duration",
  "frequency",
  "relieving_worsening",
  "function_quality_of_life",
] as const;

export type PainCharacteristic = (typeof PAIN_CHARACTERISTICS)[number];

export const PAIN_CHARACTERISTIC_LABELS: Readonly<Record<PainCharacteristic, string>> = {
  severity: "Severity",
  location: "Location",
  character: "Character",
  duration: "Duration",
  frequency: "Frequency",
  relieving_worsening: "What relieves or worsens it",
  function_quality_of_life: "Effect on function or quality of life",
};

// ── reading the selections ──────────────────────────────────────────────────────────────────────────────────────

/** A selected statement as the composer holds it (a value is a string typed in the form, or a number from a stored note). */
export interface PainSelection {
  readonly code: string;
  readonly params?: Readonly<Record<string, string | number | undefined>>;
}

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

/** The value a selected statement holds for one slot (undefined when the statement is not selected or the slot is empty). */
function slotValue(
  selections: readonly PainSelection[],
  code: string,
  slot: string,
): string | number | undefined {
  return selections.find((s) => s.code === code)?.params?.[slot];
}

function isSelected(selections: readonly PainSelection[], code: string): boolean {
  return selections.some((s) => s.code === code);
}

/** What the recorded statements say about the pain, in the terms the rules below use. `null` is "not recorded". */
export interface PainFacts {
  readonly hasPainStatement: boolean;
  readonly limitingFunction: boolean;
  readonly score: number | null;
  readonly goal: number | null;
  readonly lastScore: number | null;
  readonly change: (typeof PAIN_CHANGE_OPTIONS)[number] | null;
  readonly prnRelief: (typeof PAIN_RELIEF_OPTIONS)[number] | null;
  readonly cannotTakeOral: boolean;
}

function choiceOf<T extends string>(
  options: readonly T[],
  value: string | number | undefined,
): T | null {
  const text = textOf(value);
  return options.find((o) => o === text) ?? null;
}

export function painFactsFrom(selections: readonly PainSelection[]): PainFacts {
  const limitingFunction = isSelected(selections, PAIN_STATEMENT_CODES.limiting);
  const hasPainStatement =
    limitingFunction || isSelected(selections, PAIN_STATEMENT_CODES.controlled);
  const statementCode = limitingFunction
    ? PAIN_STATEMENT_CODES.limiting
    : PAIN_STATEMENT_CODES.controlled;
  const choice = <T extends string>(options: readonly T[], code: string, slot: string): T | null =>
    choiceOf(options, slotValue(selections, code, slot));
  return {
    hasPainStatement,
    limitingFunction,
    score: hasPainStatement
      ? numberOf(slotValue(selections, statementCode, PAIN_SLOTS.score))
      : null,
    goal: numberOf(slotValue(selections, PAIN_ASSESSMENT_CODES.goal, PAIN_SLOTS.goal)),
    lastScore: numberOf(
      slotValue(selections, PAIN_ASSESSMENT_CODES.lastScore, PAIN_SLOTS.lastScore),
    ),
    change: choice(PAIN_CHANGE_OPTIONS, PAIN_ASSESSMENT_CODES.change, PAIN_SLOTS.change),
    prnRelief: choice(PAIN_RELIEF_OPTIONS, PAIN_ASSESSMENT_CODES.prnRelief, PAIN_SLOTS.prnRelief),
    cannotTakeOral:
      textOf(slotValue(selections, PAIN_ASSESSMENT_CODES.oralBarrier, PAIN_SLOTS.oralBarrier)) !==
      null,
  };
}

// ── completeness: how many of the seven are documented ─────────────────────────────────────────────────────────

/** Which statement documents which characteristic (a statement counts only once its value is filled in). */
const CHARACTERISTIC_SOURCES: Readonly<
  Record<
    Exclude<PainCharacteristic, "severity" | "function_quality_of_life">,
    readonly [string, string][]
  >
> = {
  location: [[PAIN_ASSESSMENT_CODES.location, "pain_location"]],
  character: [[PAIN_ASSESSMENT_CODES.character, "pain_character"]],
  duration: [[PAIN_ASSESSMENT_CODES.duration, "pain_duration"]],
  frequency: [[PAIN_ASSESSMENT_CODES.frequency, "pain_frequency"]],
  relieving_worsening: [
    [PAIN_ASSESSMENT_CODES.worsenedBy, "pain_worsened_by"],
    [PAIN_ASSESSMENT_CODES.relievedBy, "pain_relieved_by"],
  ],
};

export interface PainCompleteness {
  readonly documented: readonly PainCharacteristic[];
  readonly missing: readonly PainCharacteristic[];
  readonly count: number;
  readonly total: number;
  /** The count reaches the CMS quality measure's admission benchmark. Informational; see {@link PAIN_HQRP_MIN_CHARACTERISTICS}. */
  readonly meetsQualityMeasureBenchmark: boolean;
}

/**
 * Severity is the pain score of a pain statement, or the score of a recorded observation scale (HOPE accepts a nonverbal rating
 * scale for severity). Effect on function is the "limiting function" statement itself. The rest are one statement each.
 */
export function painCompleteness(selections: readonly PainSelection[]): PainCompleteness {
  const facts = painFactsFrom(selections);
  const observed =
    numberOf(
      slotValue(selections, PAIN_ASSESSMENT_CODES.observationScale, PAIN_SLOTS.observationScore),
    ) !== null;
  const done = (characteristic: PainCharacteristic): boolean => {
    if (characteristic === "severity") return facts.score !== null || observed;
    if (characteristic === "function_quality_of_life") return facts.limitingFunction;
    return CHARACTERISTIC_SOURCES[characteristic].some(
      ([code, slot]) => textOf(slotValue(selections, code, slot)) !== null,
    );
  };
  const documented = PAIN_CHARACTERISTICS.filter(done);
  return {
    documented,
    missing: PAIN_CHARACTERISTICS.filter((c) => !documented.includes(c)),
    count: documented.length,
    total: PAIN_CHARACTERISTICS.length,
    meetsQualityMeasureBenchmark: documented.length >= PAIN_HQRP_MIN_CHARACTERISTICS,
  };
}

// ── the advisory prompt to review the plan of care ─────────────────────────────────────────────────────────────

export type PlanReviewBasis =
  | "regulation"
  | "cms_guidance"
  | "guideline"
  | "common_practice"
  | "research";

/** How a basis reads in the UI. */
export const PLAN_REVIEW_BASIS_LABELS: Readonly<Record<PlanReviewBasis, string>> = {
  regulation: "CMS rule",
  cms_guidance: "CMS guidance",
  guideline: "Clinical guideline",
  common_practice: "Common practice",
  research: "Research benchmark",
};

export type PlanReviewReasonId =
  | "function_limit"
  | "above_goal"
  | "severe_score"
  | "rise"
  | "worsening"
  | "new_pain"
  | "not_relieved"
  | "no_oral_route";

export interface PlanReviewReason {
  readonly id: PlanReviewReasonId;
  readonly text: string;
  readonly basis: PlanReviewBasis;
  readonly source: string;
}

/**
 * Why the plan of care for pain may need a look, from what the visit's statements record. Empty when no pain statement is picked.
 * Deterministic and ordered. Each reason carries its type and source so the screen can say what kind of prompt it is.
 */
export function painPlanReviewReasons(
  selections: readonly PainSelection[],
): readonly PlanReviewReason[] {
  const facts = painFactsFrom(selections);
  if (!facts.hasPainStatement) return [];
  const reasons: PlanReviewReason[] = [];
  const { score, goal, lastScore } = facts;

  if (facts.limitingFunction) {
    reasons.push({
      id: "function_limit",
      text: "Pain is limiting function, so the plan's comfort and function goal is not being met.",
      basis: "guideline",
      source:
        "National Consensus Project guidelines 4th ed. 2.1.1 and 2.3.4; CMS State Operations Manual, Appendix M, 418.56(c)(1) (re-evaluate the current plan of care)",
    });
  }
  if (score !== null && goal !== null && score > goal) {
    reasons.push({
      id: "above_goal",
      text: `Pain is ${score} of 10, above the patient's own acceptable level of ${goal}.`,
      basis: "common_practice",
      source:
        "NHPCO Care Planning Primer (2023): a goal not met (pain at 5, goal 3) means the interventions are reviewed and possibly changed",
    });
  }
  if (score !== null && score >= PAIN_SEVERE_MIN_SCORE) {
    reasons.push({
      id: "severe_score",
      text: `Pain of ${score} of 10 is in the severe range on the CMS HOPE scale (${PAIN_SEVERE_MIN_SCORE} to ${PAIN_SCORE_MAX}).`,
      basis: "cms_guidance",
      source:
        "CMS HOPE Guidance Manual v1.03, J0900, Table 4 (a reporting band; NCCN v3.2019 puts severe at 8 to 10)",
    });
  }
  let riseReported = false;
  if (score !== null && lastScore !== null && score - lastScore >= PAIN_MEANINGFUL_RISE_POINTS) {
    riseReported = true;
    reasons.push({
      id: "rise",
      text: `Pain rose ${score - lastScore} points since the last visit (${lastScore} to ${score}); about ${PAIN_MEANINGFUL_RISE_POINTS} points is a meaningful change.`,
      basis: "research",
      source: "Farrar et al., Pain 2001;94:149-158 (about 2 points or 30% on a 0 to 10 scale)",
    });
  }
  if (facts.change === "worsened" && !riseReported) {
    reasons.push({
      id: "worsening",
      text: "Pain is worse than at the last visit.",
      basis: "regulation",
      source:
        "42 CFR 418.54(d) and 418.56(d): update the assessment and review the plan as often as the patient's condition requires",
    });
  }
  if (facts.change === "new pain") {
    reasons.push({
      id: "new_pain",
      text: "This pain is new since the last visit.",
      basis: "regulation",
      source:
        "42 CFR 418.54(d) and 418.56(d): update the assessment and review the plan as often as the patient's condition requires",
    });
  }
  if (facts.prnRelief === "no relief") {
    reasons.push({
      id: "not_relieved",
      text: "The last as-needed dose gave no relief.",
      basis: "guideline",
      source:
        "Fast Facts and Concepts #70 (reassess about 1 hour after an oral as-needed dose); National Consensus Project guidelines 4th ed. 2.2.4 (timely reassessment after treatment starts)",
    });
  }
  if (facts.cannotTakeOral) {
    reasons.push({
      id: "no_oral_route",
      text: "The patient cannot take oral pain medicine, so another route will need to be ordered.",
      basis: "guideline",
      source:
        "Albert, Am Fam Physician 2017;95:356 (medicines move to sublingual, transdermal or rectal routes as swallowing declines); WHO 2018, 5.6 (by mouth whenever possible)",
    });
  }
  return reasons;
}

export interface PlanReviewReference {
  readonly id: "idg_cadence" | "hope_follow_up" | "level_of_care";
  readonly text: string;
  readonly basis: PlanReviewBasis;
  readonly source: string;
}

/**
 * What the prompt reminds the clinician of, beside the reasons. The level-of-care pointer is shown only after an as-needed dose
 * gave no relief, because the sources tie a higher level of care to symptoms that cannot be managed at home, and "no relief from
 * the last dose" is the closest thing this note records to that.
 */
export function painPlanReviewReference(
  reasons: readonly PlanReviewReason[],
): readonly PlanReviewReference[] {
  const reference: PlanReviewReference[] = [
    {
      id: "idg_cadence",
      text: `The IDG, with the attending physician, reviews and revises the plan of care as often as the patient's condition requires, and at least every ${PAIN_PLAN_REVIEW_MAX_DAYS} calendar days.`,
      basis: "regulation",
      source: "42 CFR 418.56(d)",
    },
    {
      id: "hope_follow_up",
      text: `At a HOPE admission or update visit, a moderate or severe symptom impact calls for an in-person follow-up visit within ${PAIN_SFV_WINDOW_DAYS} calendar days.`,
      basis: "cms_guidance",
      source: "CMS HOPE Guidance Manual v1.03, J2052; HQRP Quality Measure Manual v1.04, ch. 5",
    },
  ];
  if (reasons.some((r) => r.id === "not_relieved")) {
    reference.push({
      id: "level_of_care",
      text: "If pain cannot be managed at home, the hospice physician and the IDG decide whether a higher level of care is needed: continuous home care for a brief crisis, or general inpatient care.",
      basis: "cms_guidance",
      source: "42 CFR 418.204(a); Medicare Benefit Policy Manual ch. 9, 40.1.5 and 40.2.1",
    });
  }
  return reference;
}
