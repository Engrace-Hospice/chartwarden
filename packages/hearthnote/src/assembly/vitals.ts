// packages/hearthnote/src/assembly/vitals.ts — the recorded-vitals sentence (WF09).
//
// A pure, total transform from the vitals a clinician captured to one sentence. Values are quoted exactly
// as stored (never rounded, converted or judged), so the note states what was measured and nothing more.
import type { RecordedVitals } from "./types";

const TEMPERATURE_UNIT: Readonly<Record<string, string>> = { f: "°F", c: "°C" };
const WEIGHT_UNIT: Readonly<Record<string, string>> = { kg: "kg", lb: "lb" };

const isNumber = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);
const text = (v: string | null | undefined): string | undefined => {
  const t = v?.trim() ?? "";
  return t.length > 0 ? t : undefined;
};
/** A measurement with its unit, or without one when the stored unit is missing or not one we name. */
const measured = (value: string, unit: string | undefined): string =>
  unit === undefined ? value : `${value} ${unit}`;

function bloodPressure(v: RecordedVitals): string | undefined {
  const { bpSystolic: sys, bpDiastolic: dia } = v;
  if (isNumber(sys) && isNumber(dia)) return `blood pressure ${sys}/${dia} mmHg`;
  if (isNumber(sys)) return `systolic blood pressure ${sys} mmHg`;
  if (isNumber(dia)) return `diastolic blood pressure ${dia} mmHg`;
  return undefined;
}

/** `"Vital signs: …"` for what was recorded, or `""` when nothing was (the caller then adds no sentence). */
export function describeRecordedVitals(v: RecordedVitals | undefined): string {
  if (v === undefined) return "";
  const temperature = text(v.temperature);
  const weight = text(v.weight);
  const parts = [
    bloodPressure(v),
    isNumber(v.heartRate) ? `heart rate ${v.heartRate} bpm` : undefined,
    isNumber(v.respiratoryRate) ? `respiratory rate ${v.respiratoryRate} breaths/min` : undefined,
    temperature === undefined
      ? undefined
      : `temperature ${measured(temperature, TEMPERATURE_UNIT[v.temperatureUnit ?? ""])}`,
    isNumber(v.spo2) ? `SpO₂ ${v.spo2}%` : undefined,
    isNumber(v.painScore) ? `pain score ${v.painScore} of 10` : undefined,
    weight === undefined
      ? undefined
      : `weight ${measured(weight, WEIGHT_UNIT[v.weightUnit ?? ""])}`,
  ].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? "" : `Vital signs: ${parts.join(", ")}.`;
}
