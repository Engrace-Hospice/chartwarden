// packages/hearthnote/src/assembly/recorded-findings.ts — the recorded ADL, nutrition and wound sentences (WF09).
//
// Pure, total transforms from the structured findings a clinician captured on a visit to plain clinical
// sentences, like `describeRecordedVitals`: values are stated as stored, never judged, inferred or combined
// into a conclusion, and a finding that was not recorded adds nothing. Each value set has a label table typed
// `Record<Value, string>`, so a value added to the contract does not compile until it has wording (and the
// package tests assert every value reads distinctly). A value outside its set (stale data) is dropped, never
// printed as a raw token. The one derived statement is the ADL dependence count (and its change since the previous signed visit):
// a count and the ADLs it names, computed by the same `scoreAdlDependence` the Functional Status panel shows, never a conclusion.
import { scoreAdlDependence } from "@chartwarden/types";
import { finishSentence, joinSentences } from "./grammar";
import type {
  AdlDevice,
  AdlItem,
  AdlLevel,
  AppetiteLevel,
  ContinenceLevel,
  ExudateAmount,
  ExudateType,
  FluidIntakeLevel,
  NutritionSupport,
  PeriwoundCondition,
  PressureStage,
  PriorRecordedAdl,
  RecordedAdl,
  RecordedNutrition,
  RecordedWound,
  SwallowingLevel,
  WoundBedTissue,
  WoundDressing,
  WoundEtiology,
  WoundOdor,
  WoundTrend,
} from "./types";
import { ADL_ITEMS, ADL_LEVELS } from "./types";

const MAX_PERCENT = 100;

const ADL_ITEM_LABEL: Readonly<Record<AdlItem, string>> = {
  bathing: "bathing",
  dressing: "dressing",
  grooming: "grooming",
  toileting: "toileting",
  transferring: "transferring",
  ambulation: "ambulation",
  eating: "eating",
};

/** The clause for the items recorded at one assistance level (`items` is already a joined list). */
const ADL_LEVEL_CLAUSE: Readonly<Record<AdlLevel, (items: string) => string>> = {
  independent: (items) => `independent with ${items}`,
  supervision: (items) => `needed supervision with ${items}`,
  limited_assist: (items) => `needed limited assistance with ${items}`,
  extensive_assist: (items) => `needed extensive assistance with ${items}`,
  total_dependence: (items) => `was totally dependent for ${items}`,
  did_not_occur: (items) => `${items} did not occur`,
};

const CONTINENCE_LABEL: Readonly<Record<ContinenceLevel, string>> = {
  continent: "continent",
  occasionally_incontinent: "occasionally incontinent",
  frequently_incontinent: "frequently incontinent",
  incontinent: "incontinent",
  catheter_or_ostomy: "managed with a catheter or ostomy",
};

const ADL_DEVICE_LABEL: Readonly<Record<AdlDevice, string>> = {
  cane: "a cane",
  walker: "a walker",
  wheelchair: "a wheelchair",
  hospital_bed: "a hospital bed",
  mechanical_lift: "a mechanical lift",
  bedside_commode: "a bedside commode",
};

const APPETITE_CLAUSE: Readonly<Record<AppetiteLevel, string>> = {
  good: "appetite good",
  fair: "appetite fair",
  poor: "appetite poor",
  none: "no appetite",
};

const FLUID_INTAKE_CLAUSE: Readonly<Record<FluidIntakeLevel, string>> = {
  adequate: "fluid intake adequate",
  decreased: "fluid intake decreased",
  minimal: "fluid intake minimal",
};

const SWALLOWING_CLAUSE: Readonly<Record<SwallowingLevel, string>> = {
  no_difficulty: "no difficulty swallowing",
  difficulty_solids: "difficulty swallowing solids",
  difficulty_liquids: "difficulty swallowing liquids",
  difficulty_solids_and_liquids: "difficulty swallowing solids and liquids",
  unable_to_swallow: "unable to swallow",
};

const NUTRITION_SUPPORT_CLAUSE: Readonly<Record<NutritionSupport, string>> = {
  none: "receives no nutrition support",
  oral_supplements: "receives oral supplements",
  tube_feeding: "receives tube feeding",
  parenteral: "receives parenteral nutrition",
};

const WOUND_ETIOLOGY_LABEL: Readonly<Record<WoundEtiology, string>> = {
  pressure_injury: "pressure injury",
  diabetic_ulcer: "diabetic ulcer",
  venous_ulcer: "venous ulcer",
  arterial_ulcer: "arterial ulcer",
  surgical: "surgical wound",
  traumatic: "traumatic wound",
  skin_tear: "skin tear",
  malignant_fungating: "malignant fungating wound",
  moisture_associated: "moisture-associated skin damage",
  other: "wound",
};

const PRESSURE_STAGE_LABEL: Readonly<Record<PressureStage, string>> = {
  stage_1: "stage 1",
  stage_2: "stage 2",
  stage_3: "stage 3",
  stage_4: "stage 4",
  unstageable: "unstageable",
  deep_tissue_injury: "deep tissue injury",
};

const WOUND_BED_LABEL: Readonly<Record<WoundBedTissue, string>> = {
  granulation: "granulation",
  slough: "slough",
  eschar: "eschar",
  epithelializing: "epithelializing tissue",
  necrotic: "necrotic tissue",
  hypergranulation: "hypergranulation",
  bone_or_tendon_exposed: "exposed bone or tendon",
};

/** `none` is worded by {@link drainage} ("no drainage"), where a recorded type is moot. */
const EXUDATE_AMOUNT_LABEL: Readonly<Record<ExudateAmount, string>> = {
  none: "no",
  scant: "scant",
  small: "small",
  moderate: "moderate",
  large: "large",
};

const EXUDATE_TYPE_LABEL: Readonly<Record<ExudateType, string>> = {
  serous: "serous",
  serosanguineous: "serosanguineous",
  sanguineous: "sanguineous",
  purulent: "purulent",
};

const ODOR_CLAUSE: Readonly<Record<WoundOdor, string>> = {
  none: "no odor",
  mild: "mild odor",
  moderate: "moderate odor",
  strong: "strong odor",
};

/** Follows the word "periwound": "periwound erythema and warmth", "periwound skin intact". */
const PERIWOUND_LABEL: Readonly<Record<PeriwoundCondition, string>> = {
  intact: "skin intact",
  erythema: "erythema",
  macerated: "maceration",
  indurated: "induration",
  edematous: "edema",
  warm: "warmth",
  excoriated: "excoriation",
};

const DRESSING_LABEL: Readonly<Record<WoundDressing, string>> = {
  foam: "foam dressing",
  hydrocolloid: "hydrocolloid dressing",
  alginate: "alginate dressing",
  hydrogel: "hydrogel dressing",
  gauze: "gauze dressing",
  silver: "silver dressing",
  transparent_film: "transparent film dressing",
  negative_pressure: "negative pressure dressing",
  other: "other dressing",
};

const TREND_CLAUSE: Readonly<Record<WoundTrend, string>> = {
  new: "new wound",
  improving: "trend improving",
  stable: "trend stable",
  worsening: "trend worsening",
};

/** The wording for a stored value, or `undefined` for an empty value or one outside the set. */
function labelOf<V extends string>(
  table: Readonly<Record<V, string>>,
  value: string | null | undefined,
): string | undefined {
  return typeof value === "string" && Object.hasOwn(table, value) ? table[value as V] : undefined;
}

/** "a", "a and b", "a, b and c". */
function listOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The distinct labels for a recorded list, in the order recorded. */
function labelsOf<V extends string>(
  table: Readonly<Record<V, string>>,
  values: readonly (string | null | undefined)[] | undefined,
): string[] {
  const labels = (values ?? []).map((value) => labelOf(table, value));
  return labels.filter(
    (label, i): label is string => label !== undefined && labels.indexOf(label) === i,
  );
}

const present = (parts: readonly (string | undefined)[]): string[] =>
  parts.filter((part): part is string => part !== undefined);

const isFiniteNumber = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** The assistance-level clauses: items grouped by level in scale order, items in the canonical order. */
function adlItemClauses(items: RecordedAdl["items"]): string[] {
  if (items === undefined) return [];
  const clauses = ADL_LEVELS.flatMap((level) => {
    const labels = ADL_ITEMS.filter((item) => items[item] === level).map(
      (item) => ADL_ITEM_LABEL[item],
    );
    return labels.length === 0 ? [] : [ADL_LEVEL_CLAUSE[level](listOf(labels))];
  });
  // "needed limited assistance with a and b, extensive assistance with c": the verb is stated once per run.
  return clauses.map((clause, i) =>
    clause.startsWith("needed ") && clauses[i - 1]?.startsWith("needed ")
      ? clause.slice("needed ".length)
      : clause,
  );
}

const adlNoun = (count: number): string => (count === 1 ? "ADL" : "ADLs");

/** How many ADLs were assessed at a visit and how many of them the patient was dependent in. */
interface AdlShare {
  readonly dependent: number;
  readonly assessed: number;
}

/**
 * How the SHARE of assessed ADLs the patient was dependent in moved since the earlier visit: stated as a movement, never judged. A share,
 * not a count: "1 of 1" after "2 of 2" is everything assessed both times, not a decrease. Compared by cross-multiplication
 * (`now.dependent / now.assessed` against `before.dependent / before.assessed`), so no float rounding decides it. `undefined` when either
 * visit assessed nothing (no share to compare).
 */
const adlChangeWord = (now: AdlShare, before: AdlShare): string | undefined => {
  if (now.assessed <= 0 || before.assessed <= 0) return undefined;
  const nowScaled = now.dependent * before.assessed;
  const beforeScaled = before.dependent * now.assessed;
  return nowScaled > beforeScaled
    ? "up from"
    : nowScaled < beforeScaled
      ? "down from"
      : "unchanged from";
};

/**
 * The dependence score: "dependent in 2 of 3 assessed ADLs (bathing and dressing)", and, when an earlier visit assessed any ADL,
 * "up from 1 of 3 assessed at the visit on 2026-11-10" (up, down or unchanged is the movement of the share dependent, not of the count).
 * The same count the Functional Status panel shows (`scoreAdlDependence`).
 * A count and its names only: whether the patient remains appropriate for hospice is the clinician's and the IDG's call, so the note
 * never words a band or a determination. `undefined` when no ADL was assessed this visit (there is nothing to count).
 */
function adlDependenceClause(
  items: RecordedAdl["items"],
  prior: PriorRecordedAdl | null | undefined,
): string | undefined {
  const now = scoreAdlDependence(items, ADL_ITEMS);
  if (now.assessed === 0) return undefined;
  const names = now.dependent.map((item) => ADL_ITEM_LABEL[item]);
  const named = names.length === 0 ? "" : ` (${listOf(names)})`;
  const head = `dependent in ${now.dependent.length} of ${now.assessed} assessed ${adlNoun(now.assessed)}${named}`;
  const before = scoreAdlDependence(prior?.items, ADL_ITEMS);
  const change = adlChangeWord(
    { dependent: now.dependent.length, assessed: now.assessed },
    { dependent: before.dependent.length, assessed: before.assessed },
  );
  if (prior == null || change === undefined) return head;
  const on = typeof prior.on === "string" ? prior.on.trim() : "";
  const visit = on === "" ? "the previous visit" : `the visit on ${on}`;
  return `${head}, ${change} ${before.dependent.length} of ${before.assessed} assessed at ${visit}`;
}

/**
 * `"Functional status: …"` for what was recorded, or `""` when nothing was (the caller then adds no sentence). `prior` is the ADL
 * levels of the patient's previous signed visit: given, and when it assessed any ADL, the dependence score states the change since then.
 */
export function describeRecordedAdl(
  recorded: RecordedAdl | undefined,
  prior?: PriorRecordedAdl | null,
): string {
  if (recorded === undefined) return "";
  const bladder = labelOf(CONTINENCE_LABEL, recorded.bladder);
  const bowel = labelOf(CONTINENCE_LABEL, recorded.bowel);
  const devices = labelsOf(ADL_DEVICE_LABEL, recorded.devices);
  const segments = present([
    adlItemClauses(recorded.items).join(", ") || undefined,
    adlDependenceClause(recorded.items, prior),
    bladder === undefined ? undefined : `bladder ${bladder}`,
    bowel === undefined ? undefined : `bowel ${bowel}`,
    devices.length === 0 ? undefined : `uses ${listOf(devices)}`,
  ]);
  return segments.length === 0 ? "" : `Functional status: ${segments.join("; ")}.`;
}

/** `"Nutrition: …"` for what was recorded, or `""` when nothing was. */
export function describeRecordedNutrition(recorded: RecordedNutrition | undefined): string {
  if (recorded === undefined) return "";
  const intake = recorded.mealIntakePercent;
  const parts = present([
    labelOf(APPETITE_CLAUSE, recorded.appetite),
    isFiniteNumber(intake) && intake >= 0 && intake <= MAX_PERCENT
      ? `ate about ${intake}% of meals`
      : undefined,
    labelOf(FLUID_INTAKE_CLAUSE, recorded.fluidIntake),
    labelOf(SWALLOWING_CLAUSE, recorded.swallowing),
    labelOf(NUTRITION_SUPPORT_CLAUSE, recorded.support),
  ]);
  return parts.length === 0 ? "" : `Nutrition: ${parts.join(", ")}.`;
}

/** A measurement as stored, with at least one decimal ("4" → "4.0", "2.55" stays "2.55"; never rounded). */
const centimetres = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const isMeasurement = (v: number | null | undefined): v is number => isFiniteNumber(v) && v >= 0;

/** "4.0 x 3.0 x 1.2 cm" when length and width were taken; otherwise each recorded dimension, labelled. */
function measurements(w: RecordedWound): string | undefined {
  const { lengthCm: length, widthCm: width, depthCm: depth } = w;
  if (isMeasurement(length) && isMeasurement(width)) {
    const dims = isMeasurement(depth) ? [length, width, depth] : [length, width];
    return `${dims.map(centimetres).join(" x ")} cm`;
  }
  const labelled = present([
    isMeasurement(length) ? `length ${centimetres(length)} cm` : undefined,
    isMeasurement(width) ? `width ${centimetres(width)} cm` : undefined,
    isMeasurement(depth) ? `depth ${centimetres(depth)} cm` : undefined,
  ]);
  return labelled.length === 0 ? undefined : labelled.join(", ");
}

const yesNo = (value: boolean | null | undefined, yes: string, no: string): string | undefined =>
  typeof value === "boolean" ? (value ? yes : no) : undefined;

/** "moderate serosanguineous drainage"; "no drainage" when the amount is none (a type is then moot). */
function drainage(w: RecordedWound): string | undefined {
  if (w.exudateAmount === "none") return "no drainage";
  const words = present([
    labelOf(EXUDATE_AMOUNT_LABEL, w.exudateAmount),
    labelOf(EXUDATE_TYPE_LABEL, w.exudateType),
  ]);
  return words.length === 0 ? undefined : `${words.join(" ")} drainage`;
}

/** "foam dressing changed", "dressing not changed", "gauze dressing". */
function dressing(w: RecordedWound): string | undefined {
  const name = labelOf(DRESSING_LABEL, w.dressing);
  const changed = yesNo(w.dressingChanged, "changed", "not changed");
  if (name === undefined && changed === undefined) return undefined;
  return [name ?? "dressing", changed].filter((p) => p !== undefined).join(" ");
}

function woundSentence(w: RecordedWound): string {
  const head = [w.site.trim(), labelOf(WOUND_ETIOLOGY_LABEL, w.etiology) ?? "wound"]
    .filter((p) => p.length > 0)
    .join(" ");
  const bed = labelsOf(WOUND_BED_LABEL, w.woundBed);
  const periwound = labelsOf(PERIWOUND_LABEL, w.periwound);
  const parts = [
    head,
    ...present([
      labelOf(PRESSURE_STAGE_LABEL, w.stage),
      measurements(w),
      yesNo(w.undermining, "undermining present", "no undermining"),
      bed.length === 0 ? undefined : `${listOf(bed)} in the wound bed`,
      drainage(w),
      labelOf(ODOR_CLAUSE, w.odor),
      periwound.length === 0 ? undefined : `periwound ${listOf(periwound)}`,
      yesNo(w.infectionSigns, "signs of infection present", "no signs of infection"),
      isFiniteNumber(w.painScore) ? `pain ${w.painScore} of 10` : undefined,
      dressing(w),
      labelOf(TREND_CLAUSE, w.trend),
    ]),
  ];
  return finishSentence(parts.join(", "));
}

/** One sentence per wound, in the order recorded, or `""` when none was. */
export function describeRecordedWounds(recorded: readonly RecordedWound[] | undefined): string {
  return joinSentences((recorded ?? []).map(woundSentence));
}
