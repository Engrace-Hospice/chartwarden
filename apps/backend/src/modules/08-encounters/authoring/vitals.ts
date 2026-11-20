// apps/backend/src/modules/08-encounters/authoring/vitals.ts — M8-T10 (§2.2, §3.3 `vitals`).
//
// Pure vitals authoring: validation (the same numeric envelopes the `vitals_*` DB CHECK constraints
// enforce — defence-in-depth so an out-of-range value is a precise 422 before it ever reaches the row),
// the computed BMI (a derived column, never clinician-entered), the captured-field roster, and the
// abnormal-flag derivation that decorates the `m8.vitals.captured` outbox event (§4.4) for M9 trending
// and the M36 abnormal-vital alert path. No IO: the service supplies the input, persists the row, and
// runs the returned §2.8 effects inside the encounter's optimistic-locked transaction. "Clinically not
// indicated" is a first-class value (§2.2) — a non-empty CNI field list requires a documented reason,
// never a silent NULL the surveyor can't explain.
import type { RecordedVitals } from "@chartwarden/hearthnote";
import {
  type ErrorDetailType,
  type PainScale,
  ValidationError,
  type VitalUnit,
} from "@chartwarden/types";
import type { EncounterSideEffect } from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";
import {
  HEIGHT_UNITS,
  WEIGHT_UNITS,
  parseHeight,
  parseWeight,
  plausibleKilograms,
  plausibleMetres,
  positiveDecimal,
} from "./measurements";

/** Minimum free-text length for the §2.2 "clinically not indicated" reason (also a DB CHECK). */
export const VITALS_CNI_REASON_MIN = 20;

/** The clinician-supplied vitals payload (numeric-direct per §2.2; numerics-as-text preserve units). */
export interface VitalsInput {
  readonly bpSystolic?: number | null;
  readonly bpDiastolic?: number | null;
  readonly heartRate?: number | null;
  readonly respiratoryRate?: number | null;
  readonly temperature?: string | null;
  readonly temperatureUnit?: VitalUnit | null;
  readonly spo2?: number | null;
  readonly painScore?: number | null;
  readonly painScale?: PainScale | null;
  readonly weight?: string | null;
  readonly weightUnit?: VitalUnit | null;
  readonly height?: string | null;
  readonly heightUnit?: VitalUnit | null;
  readonly bloodGlucose?: number | null;
  readonly bloodGlucoseUnit?: VitalUnit | null;
  readonly clinicallyNotIndicatedFields?: readonly string[];
  readonly clinicallyNotIndicatedReason?: string | null;
}

const hasValue = (v: unknown): boolean => isNum(v as number) || isText(v as string);

/** Measurements the note takes one at a time: the newest set that carries one supplies it. */
const SCALAR_MEASUREMENTS = ["heartRate", "respiratoryRate", "spo2", "painScore"] as const;

/** The fields of `source` that carry a value (an absent or null field stays absent), or nothing when there is no source. */
function takeFrom(source: VitalsInput | undefined, fields: readonly (keyof VitalsInput)[]) {
  return Object.fromEntries(
    source === undefined ? [] : fields.flatMap((f) => (source[f] == null ? [] : [[f, source[f]]])),
  );
}

/**
 * What the visit note states, from every vitals set captured on the encounter (NEWEST first). Each measurement comes from
 * the newest set that carries it, so a later capture replaces only what it measured and an earlier reading is never dropped
 * by a partial retake. Two things are never split across sets, because the halves mean nothing apart: a measurement and its
 * unit, and the two halves of a blood pressure (the newest set that has BOTH; failing that the newest set with either one,
 * stated on its own). A weight or height counts only when it is a positive number with a unit of its own family, the same
 * rule the weight history applies, so the note's "current weight" and the history's agree.
 */
export function recordedVitalsFrom(sets: readonly VitalsInput[]): RecordedVitals {
  const bloodPressureSet =
    sets.find((s) => isNum(s.bpSystolic) && isNum(s.bpDiastolic)) ??
    sets.find((s) => isNum(s.bpSystolic) || isNum(s.bpDiastolic));
  const merged: RecordedVitals = {
    ...takeFrom(bloodPressureSet, ["bpSystolic", "bpDiastolic"]),
    ...takeFrom(
      sets.find((s) => hasValue(s.temperature)),
      ["temperature", "temperatureUnit"],
    ),
    ...takeFrom(
      sets.find((s) => parseWeight(s.weight, s.weightUnit) !== null),
      ["weight", "weightUnit"],
    ),
    ...takeFrom(
      sets.find((s) => parseHeight(s.height, s.heightUnit) !== null),
      ["height", "heightUnit"],
    ),
    ...Object.fromEntries(
      SCALAR_MEASUREMENTS.flatMap((field) => {
        const source = sets.find((s) => hasValue(s[field]));
        return source === undefined ? [] : [[field, source[field]]];
      }),
    ),
  };
  // BMI is derived from the MERGED weight and height: a set that took only one of them stores no BMI of its own.
  const bmi = computeBmi(merged as VitalsInput);
  return bmi === null ? merged : { ...merged, bmi };
}

/** The derived vitals facts + the §2.8 effects a capture declares (the service executes them). */
export interface VitalsCapturePlan {
  /** The non-null numeric/measurement fields actually captured (drives the event payload). */
  readonly fieldsCaptured: readonly string[];
  /** Out-of-envelope readings flagged for M9 trending / M36 alerts (never a hard block). */
  readonly abnormalFlags: readonly string[];
  /** The computed BMI (kg/m², 1 d.p.) when both weight + height are present, else null. */
  readonly bmi: string | null;
  /** §2.8: audit the row + publish `m8.vitals.captured` in the same tx. */
  readonly effects: readonly EncounterSideEffect[];
}

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isText = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.trim().length > 0;

/** §3.3 `vitals_*` CHECK envelopes mirrored as guards (precise 422 before the write). */
export function validateVitals(input: VitalsInput): void {
  if (isNum(input.bpSystolic)) {
    require_(
      input.bpSystolic >= 40 && input.bpSystolic <= 260,
      "VITALS_OUT_OF_RANGE",
      "bp_systolic out of range (40–260)",
    );
  }
  if (isNum(input.bpDiastolic)) {
    require_(
      input.bpDiastolic >= 20 && input.bpDiastolic <= 180,
      "VITALS_OUT_OF_RANGE",
      "bp_diastolic out of range (20–180)",
    );
  }
  if (isNum(input.spo2)) {
    require_(
      input.spo2 >= 50 && input.spo2 <= 100,
      "VITALS_OUT_OF_RANGE",
      "spo2 out of range (50–100)",
    );
  }
  if (isNum(input.painScore)) {
    require_(
      input.painScore >= 0 && input.painScore <= 10,
      "VITALS_OUT_OF_RANGE",
      "pain_score out of range (0–10)",
    );
  }
  validateMeasurements(input);
  const cniFields = input.clinicallyNotIndicatedFields ?? [];
  if (cniFields.length > 0) {
    require_(
      (input.clinicallyNotIndicatedReason?.trim().length ?? 0) >= VITALS_CNI_REASON_MIN,
      "VITALS_CNI_REASON_REQUIRED",
      `a clinically-not-indicated field list requires a reason ≥ ${VITALS_CNI_REASON_MIN} characters`,
    );
  }
}

/** A weight or height needs a plain positive number and a unit of its own family; every violation is named by field. */
function measurementProblems(
  label: "weight" | "height",
  value: string | null | undefined,
  unit: string | null | undefined,
  units: readonly string[],
): ErrorDetailType[] {
  const unitField = `${label}Unit`;
  const unitList = units.join(" or ");
  const problems: ErrorDetailType[] = [];
  if (isText(value) && positiveDecimal(value) === null) {
    problems.push({ field: label, code: "INVALID", message: `${label} must be a positive number` });
  }
  if (unit !== null && unit !== undefined && !units.includes(unit)) {
    problems.push({
      field: unitField,
      code: "INVALID",
      message: `${unitField} must be ${unitList}`,
    });
  } else if (isText(value) && (unit === null || unit === undefined)) {
    problems.push({
      field: unitField,
      code: "REQUIRED",
      message: `a ${label} needs its unit (${unitList})`,
    });
  }
  return problems;
}

/** §2.2 — a weight/height without its unit, with a unit of the wrong family, or that is not a positive number is a 422 naming each field. */
function validateMeasurements(input: VitalsInput): void {
  const problems = [
    ...measurementProblems("weight", input.weight, input.weightUnit, WEIGHT_UNITS),
    ...measurementProblems("height", input.height, input.heightUnit, HEIGHT_UNITS),
  ];
  if (problems.length > 0) throw new ValidationError("request validation failed", problems);
}

/**
 * §2.2 — BMI is a derived column, computed from weight + height, never clinician-entered. It exists only when BOTH are recorded
 * (a positive number with a kg|lb / cm|in unit) and are plausible human values; a unit is never assumed, so an incomplete or
 * implausible pair yields no BMI rather than a wrong one.
 */
export function computeBmi(input: VitalsInput): string | null {
  const kg = plausibleKilograms(input.weight, input.weightUnit);
  const m = plausibleMetres(input.height, input.heightUnit);
  if (kg === null || m === null) return null;
  return (kg / (m * m)).toFixed(1);
}

/** Derive the abnormal-vital flags that decorate `m8.vitals.captured` (clinical envelopes, advisory). */
export function deriveAbnormalFlags(input: VitalsInput): string[] {
  const flags: string[] = [];
  if (isNum(input.bpSystolic) && (input.bpSystolic >= 140 || input.bpSystolic < 90))
    flags.push("bp_systolic");
  if (isNum(input.bpDiastolic) && (input.bpDiastolic >= 90 || input.bpDiastolic < 60))
    flags.push("bp_diastolic");
  if (isNum(input.heartRate) && (input.heartRate > 100 || input.heartRate < 60))
    flags.push("heart_rate");
  if (isNum(input.respiratoryRate) && (input.respiratoryRate > 20 || input.respiratoryRate < 12))
    flags.push("respiratory_rate");
  if (isNum(input.spo2) && input.spo2 < 92) flags.push("spo2");
  if (isNum(input.painScore) && input.painScore >= 7) flags.push("pain_score");
  return flags;
}

/** The numeric/measurement field names whose value is present on the input (the captured roster). */
export function capturedFields(input: VitalsInput): string[] {
  const present: string[] = [];
  if (isNum(input.bpSystolic)) present.push("bp_systolic");
  if (isNum(input.bpDiastolic)) present.push("bp_diastolic");
  if (isNum(input.heartRate)) present.push("heart_rate");
  if (isNum(input.respiratoryRate)) present.push("respiratory_rate");
  if (isText(input.temperature)) present.push("temperature");
  if (isNum(input.spo2)) present.push("spo2");
  if (isNum(input.painScore)) present.push("pain_score");
  if (isText(input.weight)) present.push("weight");
  if (isText(input.height)) present.push("height");
  if (isNum(input.bloodGlucose)) present.push("blood_glucose");
  return present;
}

/** Validate + derive a vitals capture (§2.2). Throws the §2.7 code on an envelope/CNI violation. */
export function planVitalsCapture(input: VitalsInput): VitalsCapturePlan {
  validateVitals(input);
  const abnormalFlags = deriveAbnormalFlags(input);
  return {
    fieldsCaptured: capturedFields(input),
    abnormalFlags,
    bmi: computeBmi(input),
    effects: [{ kind: "audit" }, { kind: "outbox", event: "m8.vitals.captured" }],
  };
}
