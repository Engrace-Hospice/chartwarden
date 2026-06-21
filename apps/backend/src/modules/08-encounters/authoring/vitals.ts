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
import type { PainScale, VitalUnit } from "@wardenx/types";
import type { EncounterSideEffect } from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";

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

const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const isText = (v: string | null | undefined): v is string => typeof v === "string" && v.trim().length > 0;

/** §3.3 `vitals_*` CHECK envelopes mirrored as guards (precise 422 before the write). */
export function validateVitals(input: VitalsInput): void {
  if (isNum(input.bpSystolic)) {
    require_(input.bpSystolic >= 40 && input.bpSystolic <= 260, "VITALS_OUT_OF_RANGE", "bp_systolic out of range (40–260)");
  }
  if (isNum(input.bpDiastolic)) {
    require_(input.bpDiastolic >= 20 && input.bpDiastolic <= 180, "VITALS_OUT_OF_RANGE", "bp_diastolic out of range (20–180)");
  }
  if (isNum(input.spo2)) {
    require_(input.spo2 >= 50 && input.spo2 <= 100, "VITALS_OUT_OF_RANGE", "spo2 out of range (50–100)");
  }
  if (isNum(input.painScore)) {
    require_(input.painScore >= 0 && input.painScore <= 10, "VITALS_OUT_OF_RANGE", "pain_score out of range (0–10)");
  }
  const cniFields = input.clinicallyNotIndicatedFields ?? [];
  if (cniFields.length > 0) {
    require_(
      (input.clinicallyNotIndicatedReason?.trim().length ?? 0) >= VITALS_CNI_REASON_MIN,
      "VITALS_CNI_REASON_REQUIRED",
      `a clinically-not-indicated field list requires a reason ≥ ${VITALS_CNI_REASON_MIN} characters`,
    );
  }
}

/** Convert a numeric-as-text weight to kilograms (lb→kg), or null when unparseable. */
function toKg(weight: string | null | undefined, unit: VitalUnit | null | undefined): number | null {
  if (!isText(weight)) return null;
  const n = Number(weight);
  if (!Number.isFinite(n) || n <= 0) return null;
  return unit === "lb" ? n * 0.45359237 : n;
}

/** Convert a numeric-as-text height to metres (in→m, cm→m), or null when unparseable. */
function toMetres(height: string | null | undefined, unit: VitalUnit | null | undefined): number | null {
  if (!isText(height)) return null;
  const n = Number(height);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === "in") return (n * 2.54) / 100;
  return n / 100; // cm (default)
}

/** §2.2 — BMI is a derived column, computed from weight + height, never clinician-entered. */
export function computeBmi(input: VitalsInput): string | null {
  const kg = toKg(input.weight, input.weightUnit);
  const m = toMetres(input.height, input.heightUnit);
  if (kg === null || m === null) return null;
  return (kg / (m * m)).toFixed(1);
}

/** Derive the abnormal-vital flags that decorate `m8.vitals.captured` (clinical envelopes, advisory). */
export function deriveAbnormalFlags(input: VitalsInput): string[] {
  const flags: string[] = [];
  if (isNum(input.bpSystolic) && (input.bpSystolic >= 140 || input.bpSystolic < 90)) flags.push("bp_systolic");
  if (isNum(input.bpDiastolic) && (input.bpDiastolic >= 90 || input.bpDiastolic < 60)) flags.push("bp_diastolic");
  if (isNum(input.heartRate) && (input.heartRate > 100 || input.heartRate < 60)) flags.push("heart_rate");
  if (isNum(input.respiratoryRate) && (input.respiratoryRate > 20 || input.respiratoryRate < 12)) flags.push("respiratory_rate");
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
