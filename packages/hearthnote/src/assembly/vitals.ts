// packages/hearthnote/src/assembly/vitals.ts — the recorded-vitals sentence (WF09).
//
// A pure, total transform from the vitals a clinician captured to one sentence. Values are quoted exactly
// as stored (never rounded, converted or judged), so the note states what was measured and nothing more.
import type { RecordedVitals } from "./types";

const TEMPERATURE_UNIT: Readonly<Record<string, string>> = { f: "°F", c: "°C" };
const WEIGHT_UNIT: Readonly<Record<string, string>> = { kg: "kg", lb: "lb" };
const HEIGHT_UNIT: Readonly<Record<string, string>> = { cm: "cm", in: "in" };

const isNumber = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);
const text = (v: string | null | undefined): string | undefined => {
  const t = v?.trim() ?? "";
  return t.length > 0 ? t : undefined;
};
/** A measurement with its unit, or without one when the stored unit is missing or not one we name. */
const measured = (value: string, unit: string | undefined): string =>
  unit === undefined ? value : `${value} ${unit}`;

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** A decimal string as an exact scaled integer (`"61.20"` → 6120 at scale 2), or `undefined` if it is not one. */
function parseDecimal(
  value: string,
): { readonly units: bigint; readonly scale: number } | undefined {
  const match = DECIMAL.exec(value.trim());
  if (match === null) return undefined;
  const fraction = match[3] ?? "";
  return { units: BigInt(`${match[1]}${match[2]}${fraction}`), scale: fraction.length };
}

/** `current − prior` as "1.3 kg lower than" / "0.4 kg higher than" / "unchanged from", exact (integer arithmetic), or `undefined` if either is not a decimal. */
function weightChange(current: string, prior: string, unit: string): string | undefined {
  const a = parseDecimal(current);
  const b = parseDecimal(prior);
  if (a === undefined || b === undefined) return undefined;
  const scale = Math.max(a.scale, b.scale);
  const rescale = (d: NonNullable<typeof a>): bigint => d.units * 10n ** BigInt(scale - d.scale);
  const delta = rescale(a) - rescale(b);
  if (delta === 0n) return "unchanged from";
  const digits = (delta < 0n ? -delta : delta).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  const amount = fraction === "" ? whole : `${whole}.${fraction}`;
  return `${amount} ${unit} ${delta < 0n ? "lower" : "higher"} than`;
}

/** The weight clause: the weight as stored, then the change since the previous visit when one was recorded. */
function weightClause(v: RecordedVitals): string | undefined {
  const weight = text(v.weight);
  if (weight === undefined) return undefined;
  const unit = WEIGHT_UNIT[v.weightUnit ?? ""];
  const clause = `weight ${measured(weight, unit)}`;
  const priorValue = text(v.priorWeight?.value);
  if (v.priorWeight == null || priorValue === undefined) return clause;
  const priorUnit = WEIGHT_UNIT[v.priorWeight.unit];
  const on = text(v.priorWeight.on);
  const since = on === undefined ? "" : ` on ${on}`;
  const priorText = `${measured(priorValue, priorUnit)}${since}`;
  const relation =
    unit !== undefined && unit === priorUnit ? weightChange(weight, priorValue, unit) : undefined;
  return `${clause}, ${relation ?? "prior weight"} ${priorText}`;
}

function bloodPressure(v: RecordedVitals): string | undefined {
  const { bpSystolic: sys, bpDiastolic: dia } = v;
  if (isNumber(sys) && isNumber(dia)) return `blood pressure ${sys}/${dia} mmHg`;
  if (isNumber(sys)) return `systolic blood pressure ${sys} mmHg`;
  if (isNumber(dia)) return `diastolic blood pressure ${dia} mmHg`;
  return undefined;
}

/** The weight, height and BMI clauses, in the order the sentences state them. */
function bodyMeasureParts(v: RecordedVitals): string[] {
  const height = text(v.height);
  const bmi = text(v.bmi);
  return [
    weightClause(v),
    height === undefined
      ? undefined
      : `height ${measured(height, HEIGHT_UNIT[v.heightUnit ?? ""])}`,
    bmi === undefined ? undefined : `BMI ${bmi}`,
  ].filter((p): p is string => p !== undefined);
}

/** `"Vital signs: …"` for what was recorded, or `""` when nothing was (the caller then adds no sentence). */
export function describeRecordedVitals(v: RecordedVitals | undefined): string {
  if (v === undefined) return "";
  const temperature = text(v.temperature);
  const parts = [
    bloodPressure(v),
    isNumber(v.heartRate) ? `heart rate ${v.heartRate} bpm` : undefined,
    isNumber(v.respiratoryRate) ? `respiratory rate ${v.respiratoryRate} breaths/min` : undefined,
    temperature === undefined
      ? undefined
      : `temperature ${measured(temperature, TEMPERATURE_UNIT[v.temperatureUnit ?? ""])}`,
    isNumber(v.spo2) ? `SpO₂ ${v.spo2}%` : undefined,
    isNumber(v.painScore) ? `pain score ${v.painScore} of 10` : undefined,
    ...bodyMeasureParts(v),
  ].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? "" : `Vital signs: ${parts.join(", ")}.`;
}

/**
 * `"Body measurements: weight …, height …, BMI …."` for the weight, height and BMI that were recorded, or `""`. The visit-note draft
 * states the other vitals from its own source (`draft/sources.ts`), which carries no body measurement, so the draft adds this sentence to
 * its vitals section: a confirmed section replaces the whole section, and weight recorded on the visit must not drop out with it.
 */
export function describeRecordedBodyMeasures(v: RecordedVitals | undefined): string {
  if (v === undefined) return "";
  const parts = bodyMeasureParts(v);
  return parts.length === 0 ? "" : `Body measurements: ${parts.join(", ")}.`;
}
