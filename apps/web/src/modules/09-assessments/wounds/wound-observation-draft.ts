// apps/web/src/modules/09-assessments/wounds — the observation form's draft: what is typed, how it becomes the request
// body, and the rules the server enforces restated as field hints so most 422s never happen. The server stays the
// authority (packages/assessments/src/wounds/validation.ts): these checks only spare a round trip, and every one has
// its own 422 code behind it. `wound-observation-draft.test.ts` pins the rules against the package's validator.
import type {
  CorrectObservationBody,
  CorrectionReason,
  ExudateAmount,
  ExudateType,
  PeriwoundCondition,
  PressureStage,
  RecordObservationBody,
  WoundBedTissue,
  WoundDressing,
  WoundEtiology,
  WoundObservation,
  WoundOdor,
  WoundTrend,
} from "./wounds-api";

/** Length and width are at most this many cm; a larger figure is a unit slip (millimetres, inches). */
export const MAX_LENGTH_WIDTH_CM = 100;
export const MAX_DEPTH_CM = 30;
export const MAX_PAIN_SCORE = 10;

/** A yes/no finding that may also be left unrecorded; "" is "not recorded", which is not the same as "no". */
export type TriState = "" | "yes" | "no";

export interface ObservationDraft {
  readonly stage: PressureStage | "";
  readonly lengthCm: string;
  readonly widthCm: string;
  readonly depthCm: string;
  readonly undermining: TriState;
  readonly woundBed: readonly WoundBedTissue[];
  readonly exudateAmount: ExudateAmount | "";
  readonly exudateType: ExudateType | "";
  readonly odor: WoundOdor | "";
  readonly periwound: readonly PeriwoundCondition[];
  /** "0" to "10", or "" for not recorded. */
  readonly painScore: string;
  readonly dressing: WoundDressing | "";
  readonly dressingChanged: TriState;
  readonly infectionSigns: TriState;
  readonly trend: WoundTrend | "";
}

export const EMPTY_DRAFT: ObservationDraft = {
  stage: "",
  lengthCm: "",
  widthCm: "",
  depthCm: "",
  undermining: "",
  woundBed: [],
  exudateAmount: "",
  exudateType: "",
  odor: "",
  periwound: [],
  painScore: "",
  dressing: "",
  dressingChanged: "",
  infectionSigns: "",
  trend: "",
};

const triOf = (v: boolean | null): TriState => (v === null ? "" : v ? "yes" : "no");
const boolOf = (v: TriState): boolean | null => (v === "" ? null : v === "yes");
const textOf = (n: number | null): string => (n === null ? "" : String(n));
const numberOf = (text: string): number | null => (text.trim() === "" ? null : Number(text.trim()));

/** The draft a correction opens on: the whole observation, so the correction restates it with the one thing changed. */
export function draftFromObservation(o: WoundObservation): ObservationDraft {
  return {
    stage: o.stage ?? "",
    lengthCm: textOf(o.lengthCm),
    widthCm: textOf(o.widthCm),
    depthCm: textOf(o.depthCm),
    undermining: triOf(o.undermining),
    woundBed: o.woundBed,
    exudateAmount: o.exudateAmount ?? "",
    exudateType: o.exudateType ?? "",
    odor: o.odor ?? "",
    periwound: o.periwound,
    painScore: textOf(o.painScore),
    dressing: o.dressing ?? "",
    dressingChanged: triOf(o.dressingChanged),
    infectionSigns: triOf(o.infectionSigns),
    trend: o.trend ?? "",
  };
}

/** Everything the draft records, with null / [] for what is empty: the full restatement a correction sends. */
function fullFields(draft: ObservationDraft, etiology: WoundEtiology) {
  return {
    stage: etiology === "pressure_injury" && draft.stage !== "" ? draft.stage : null,
    lengthCm: numberOf(draft.lengthCm),
    widthCm: numberOf(draft.widthCm),
    depthCm: numberOf(draft.depthCm),
    undermining: boolOf(draft.undermining),
    woundBed: [...draft.woundBed],
    exudateAmount: draft.exudateAmount === "" ? null : draft.exudateAmount,
    exudateType: draft.exudateType === "" ? null : draft.exudateType,
    odor: draft.odor === "" ? null : draft.odor,
    periwound: [...draft.periwound],
    painScore: numberOf(draft.painScore),
    dressing: draft.dressing === "" ? null : draft.dressing,
    dressingChanged: boolOf(draft.dressingChanged),
    infectionSigns: boolOf(draft.infectionSigns),
    trend: draft.trend === "" ? null : draft.trend,
  };
}

/** The fields that hold something: an empty list and a null are not sent with a new observation. */
function omitEmpty<T extends object>(fields: T): Partial<T> {
  const kept: Partial<T> = {};
  for (const key of Object.keys(fields) as (keyof T)[]) {
    const value = fields[key];
    if (Array.isArray(value) ? value.length > 0 : value !== null) kept[key] = value;
  }
  return kept;
}

/** A new observation: only what was recorded is sent. `sourceEncounterId` ties it to the visit it was made on. */
export function recordBodyOf(
  draft: ObservationDraft,
  etiology: WoundEtiology,
  sourceEncounterId?: string,
): RecordObservationBody {
  return {
    ...omitEmpty(fullFields(draft, etiology)),
    ...(sourceEncounterId ? { sourceEncounterId } : {}),
  };
}

/**
 * A correction restates the WHOLE observation (what is now empty goes as null / []) and says why, by code. It keeps the
 * visit the original was made on, and sends no date: the server keeps the original's.
 */
export function correctBodyOf(
  draft: ObservationDraft,
  etiology: WoundEtiology,
  reason: CorrectionReason,
  sourceEncounterId: string | null,
): CorrectObservationBody {
  return {
    ...fullFields(draft, etiology),
    ...(sourceEncounterId ? { sourceEncounterId } : {}),
    correctionReason: reason,
  };
}

/** The fields a hint can attach to. */
export type DraftField =
  | "stage"
  | "lengthCm"
  | "widthCm"
  | "depthCm"
  | "periwound"
  | "dressing"
  | "findings";

export type DraftProblems = Partial<Record<DraftField, string>>;

function measurementProblem(name: string, text: string, max: number): string | undefined {
  if (text.trim() === "") return undefined;
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value < 0) return `The ${name} must be a number of at least 0.`;
  if (value > max) return `The ${name} cannot be more than ${max} cm.`;
  const tenths = value * 10;
  if (Math.abs(tenths - Math.round(tenths)) > 1e-9) return `The ${name} takes one decimal place.`;
  return undefined;
}

/** True when the draft records at least one finding: an observation with nothing in it says nothing about the wound. */
export function recordsAFinding(draft: ObservationDraft): boolean {
  const { woundBed, periwound, ...rest } = draft;
  return woundBed.length > 0 || periwound.length > 0 || Object.values(rest).some((v) => v !== "");
}

/** The server's rules for one observation, as field hints. Empty when the draft is coherent. */
export function draftProblems(draft: ObservationDraft, etiology: WoundEtiology): DraftProblems {
  const problems: Record<string, string> = {};
  if (draft.stage !== "" && etiology !== "pressure_injury") {
    problems.stage = "Only a pressure injury has a stage.";
  }
  const hasLength = draft.lengthCm.trim() !== "";
  const hasWidth = draft.widthCm.trim() !== "";
  const length = measurementProblem("length", draft.lengthCm, MAX_LENGTH_WIDTH_CM);
  const width = measurementProblem("width", draft.widthCm, MAX_LENGTH_WIDTH_CM);
  const depth = measurementProblem("depth", draft.depthCm, MAX_DEPTH_CM);
  if (length) problems.lengthCm = length;
  if (width) problems.widthCm = width;
  if (depth) problems.depthCm = depth;
  if (draft.depthCm.trim() !== "" && !(hasLength && hasWidth) && !depth) {
    problems.depthCm = "A depth needs the length and the width.";
  }
  if (draft.dressingChanged === "yes" && draft.dressing === "") {
    problems.dressing = "Name the dressing that was applied.";
  }
  if (draft.periwound.includes("intact") && draft.periwound.length > 1) {
    problems.periwound = "Intact skin cannot be combined with another finding.";
  }
  if (!recordsAFinding(draft)) problems.findings = "Record at least one finding.";
  return problems;
}

/**
 * Toggle one periwound finding. "Intact" excludes every other finding, so choosing it clears the rest and choosing any
 * other clears "Intact": the combination the server refuses cannot be built from the form.
 */
export function togglePeriwound(
  current: readonly PeriwoundCondition[],
  condition: PeriwoundCondition,
): readonly PeriwoundCondition[] {
  if (current.includes(condition)) return current.filter((c) => c !== condition);
  return condition === "intact"
    ? ["intact"]
    : [...current.filter((c) => c !== "intact"), condition];
}

/** Length times width in cm², two decimals: the figure the server computes and shows, so it reads the same while typing. */
export function draftAreaCm2(draft: ObservationDraft): number | null {
  const length = numberOf(draft.lengthCm);
  const width = numberOf(draft.widthCm);
  if (length === null || width === null || Number.isNaN(length) || Number.isNaN(width)) return null;
  return Math.round(length * width * 100) / 100;
}
