// @chartwarden/assessments — wound validation (pure). Rules that depend on more than one field of a wound or an
// observation; per-field vocabulary is enforced by the route schema (400) and the table CHECK constraints (the
// backstop). A violation is a 422 carrying its rule code, so a form can point at the exact field.
import { ChartWardenError } from "@chartwarden/types";
import { lateralityFitsSite, woundSiteOf } from "./sites";
import type {
  ExudateAmount,
  ExudateType,
  PeriwoundCondition,
  PressureStage,
  WoundAcquired,
  WoundBedTissue,
  WoundDressing,
  WoundEtiology,
  WoundLaterality,
  WoundOdor,
  WoundTrend,
} from "./value-sets";

export const WOUND_RULES = [
  "WOUND_SITE_UNKNOWN",
  "WOUND_SITE_LATERALITY_MISMATCH",
  "WOUND_ONSET_IN_FUTURE",
  "WOUND_CLOSED_BEFORE_ONSET",
  "WOUND_CLOSE_IN_FUTURE",
  "WOUND_OBSERVED_IN_FUTURE",
  "WOUND_OBSERVED_BEFORE_ONSET",
  "WOUND_OBSERVED_IMPLAUSIBLY_EARLY",
  "WOUND_NOT_IN_NOTE",
  "WOUND_STAGE_NOT_APPLICABLE",
  "WOUND_DEPTH_REQUIRES_AREA",
  "WOUND_MEASUREMENT_RANGE",
  "WOUND_PAIN_RANGE",
  "WOUND_DRESSING_REQUIRED",
  "WOUND_PERIWOUND_INTACT_EXCLUSIVE",
  "WOUND_BED_DUPLICATE",
  "WOUND_PERIWOUND_DUPLICATE",
] as const;
export type WoundRule = (typeof WOUND_RULES)[number];

export interface WoundRuleViolation {
  readonly code: WoundRule;
  readonly message: string;
}

/** A wound rule broken: 422, the code names the rule. */
export class WoundValidationError extends ChartWardenError {
  constructor(violation: WoundRuleViolation) {
    super(violation.code, violation.message, 422);
    this.name = "WoundValidationError";
  }
}

/** Largest length or width a wound record accepts, centimetres. A larger figure is a unit slip (millimetres, inches). */
export const MAX_WOUND_LENGTH_WIDTH_CM = 100;
/** Largest depth, centimetres. */
export const MAX_WOUND_DEPTH_CM = 30;
export const MAX_WOUND_PAIN_SCORE = 10;
const MEASUREMENT_DECIMALS_SCALE = 10; // stored as numeric(5,1)

const violation = (code: WoundRule, message: string): WoundRuleViolation => ({ code, message });

// ── the wound itself ─────────────────────────────────────────────────────────────────────────────────────────────
export interface WoundFields {
  readonly siteCode: string;
  readonly laterality: WoundLaterality;
  readonly etiology: WoundEtiology;
  readonly acquired?: WoundAcquired;
  /** ISO date (`YYYY-MM-DD`). */
  readonly onsetOn?: string | null;
}

/** Rules for a new wound. `today` is the organisation-local ISO date, so an onset date cannot be in the future. */
export function validateWound(fields: WoundFields, today: string): readonly WoundRuleViolation[] {
  const out: WoundRuleViolation[] = [];
  if (!woundSiteOf(fields.siteCode)) {
    out.push(violation("WOUND_SITE_UNKNOWN", "the wound site is not in the site list"));
  } else if (!lateralityFitsSite(fields.siteCode, fields.laterality)) {
    out.push(
      violation(
        "WOUND_SITE_LATERALITY_MISMATCH",
        `laterality '${fields.laterality}' does not fit site '${fields.siteCode}'`,
      ),
    );
  }
  if (fields.onsetOn && fields.onsetOn > today) {
    out.push(violation("WOUND_ONSET_IN_FUTURE", "the onset date cannot be in the future"));
  }
  return out;
}

export function assertValidWound(fields: WoundFields, today: string): void {
  const first = validateWound(fields, today)[0];
  if (first) throw new WoundValidationError(first);
}

export interface WoundResolutionFields {
  readonly onsetOn?: string | null;
  /** ISO date (`YYYY-MM-DD`). */
  readonly closedOn: string;
}

/** Rules for closing a wound on `closedOn`. `today` is the organisation-local ISO date. */
export function validateWoundResolution(
  fields: WoundResolutionFields,
  today: string,
): readonly WoundRuleViolation[] {
  if (fields.closedOn > today) {
    return [violation("WOUND_CLOSE_IN_FUTURE", "the close date cannot be in the future")];
  }
  if (fields.onsetOn && fields.closedOn < fields.onsetOn) {
    return [
      violation("WOUND_CLOSED_BEFORE_ONSET", "the close date cannot be before the onset date"),
    ];
  }
  return [];
}

export function assertValidWoundResolution(fields: WoundResolutionFields, today: string): void {
  const first = validateWoundResolution(fields, today)[0];
  if (first) throw new WoundValidationError(first);
}

/** Minutes a device clock may run ahead of the server before an observation counts as dated in the future. */
export const OBSERVED_AT_SKEW_MINUTES = 5;
const MS_PER_MINUTE = 60_000;

/** No wound observation predates this instant: an earlier date is a typo (a year slip, an epoch default), never a real assessment. */
export const EARLIEST_OBSERVATION_AT = "2000-01-01T00:00:00.000Z";
const EARLIEST_OBSERVATION_MS = Date.parse(EARLIEST_OBSERVATION_AT);
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/**
 * An observation cannot be dated later than `now` plus a little clock skew, earlier than 2000-01-01, or (when the wound's onset is known)
 * before the onset DATE. The onset is an organisation-local date and the instant is UTC, so the onset check allows a day of slack rather than
 * guess the zone: it catches a wrong year or month, not a wrong hour. An instant that does not parse fails the lower bound.
 */
export function validateObservedAt(
  observedAt: string,
  now: Date,
  onsetOn?: string | null,
): readonly WoundRuleViolation[] {
  const at = Date.parse(observedAt);
  if (at > now.getTime() + OBSERVED_AT_SKEW_MINUTES * MS_PER_MINUTE) {
    return [violation("WOUND_OBSERVED_IN_FUTURE", "an observation cannot be dated in the future")];
  }
  if (!(at >= EARLIEST_OBSERVATION_MS)) {
    return [
      violation(
        "WOUND_OBSERVED_IMPLAUSIBLY_EARLY",
        "an observation cannot be dated before 2000-01-01: check the date",
      ),
    ];
  }
  if (onsetOn && at < Date.parse(`${onsetOn}T00:00:00.000Z`) - MS_PER_DAY) {
    return [
      violation(
        "WOUND_OBSERVED_BEFORE_ONSET",
        "an observation cannot be dated before the wound's onset date",
      ),
    ];
  }
  return [];
}

export function assertValidObservedAt(
  observedAt: string,
  now: Date,
  onsetOn?: string | null,
): void {
  const first = validateObservedAt(observedAt, now, onsetOn)[0];
  if (first) throw new WoundValidationError(first);
}

// ── one dated observation ────────────────────────────────────────────────────────────────────────────────────────
export interface WoundObservationFields {
  readonly stage?: PressureStage | null;
  readonly lengthCm?: number | null;
  readonly widthCm?: number | null;
  readonly depthCm?: number | null;
  readonly undermining?: boolean | null;
  readonly woundBed?: readonly WoundBedTissue[];
  readonly exudateAmount?: ExudateAmount | null;
  readonly exudateType?: ExudateType | null;
  readonly odor?: WoundOdor | null;
  readonly periwound?: readonly PeriwoundCondition[];
  readonly painScore?: number | null;
  readonly dressing?: WoundDressing | null;
  readonly dressingChanged?: boolean | null;
  readonly infectionSigns?: boolean | null;
  readonly trend?: WoundTrend | null;
}

const present = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;
const hasDuplicates = (xs: readonly string[]): boolean => new Set(xs).size !== xs.length;

function measurementProblem(name: string, value: number, max: number): string | null {
  if (!Number.isFinite(value) || value < 0) return `${name} must be a number of at least 0`;
  if (value > max) return `${name} cannot exceed ${max} cm`;
  const scaled = value * MEASUREMENT_DECIMALS_SCALE;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-9) return `${name} takes one decimal place`;
  return null;
}

function measurementViolations(f: WoundObservationFields): WoundRuleViolation[] {
  const checks: [string, number | null | undefined, number][] = [
    ["length", f.lengthCm, MAX_WOUND_LENGTH_WIDTH_CM],
    ["width", f.widthCm, MAX_WOUND_LENGTH_WIDTH_CM],
    ["depth", f.depthCm, MAX_WOUND_DEPTH_CM],
  ];
  const out: WoundRuleViolation[] = [];
  for (const [name, value, max] of checks) {
    if (!present(value)) continue;
    const problem = measurementProblem(name, value, max);
    if (problem) out.push(violation("WOUND_MEASUREMENT_RANGE", problem));
  }
  return out;
}

/** Rules for one observation of a wound of the given etiology; empty when it is coherent. Order is fixed. */
export function validateWoundObservation(
  etiology: WoundEtiology,
  fields: WoundObservationFields,
): readonly WoundRuleViolation[] {
  const out: WoundRuleViolation[] = [];
  if (present(fields.stage) && etiology !== "pressure_injury") {
    out.push(violation("WOUND_STAGE_NOT_APPLICABLE", "only a pressure injury carries a stage"));
  }
  if (present(fields.depthCm) && !(present(fields.lengthCm) && present(fields.widthCm))) {
    out.push(violation("WOUND_DEPTH_REQUIRES_AREA", "a depth needs the length and the width"));
  }
  out.push(...measurementViolations(fields));
  const pain = fields.painScore;
  if (present(pain) && !(Number.isInteger(pain) && pain >= 0 && pain <= MAX_WOUND_PAIN_SCORE)) {
    out.push(
      violation("WOUND_PAIN_RANGE", `pain is a whole number from 0 to ${MAX_WOUND_PAIN_SCORE}`),
    );
  }
  if (fields.dressingChanged === true && !present(fields.dressing)) {
    out.push(violation("WOUND_DRESSING_REQUIRED", "name the dressing that was applied"));
  }
  const bed = fields.woundBed ?? [];
  if (hasDuplicates(bed)) {
    out.push(violation("WOUND_BED_DUPLICATE", "a wound bed tissue is listed twice"));
  }
  const periwound = fields.periwound ?? [];
  if (hasDuplicates(periwound)) {
    out.push(violation("WOUND_PERIWOUND_DUPLICATE", "a periwound condition is listed twice"));
  } else if (periwound.includes("intact") && periwound.length > 1) {
    out.push(
      violation(
        "WOUND_PERIWOUND_INTACT_EXCLUSIVE",
        "intact periwound skin cannot be combined with another periwound finding",
      ),
    );
  }
  return out;
}

export function assertValidWoundObservation(
  etiology: WoundEtiology,
  fields: WoundObservationFields,
): void {
  const first = validateWoundObservation(etiology, fields)[0];
  if (first) throw new WoundValidationError(first);
}
