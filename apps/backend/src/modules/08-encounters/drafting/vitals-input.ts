// apps/backend/src/modules/08-encounters/drafting/vitals-input.ts — one `vitals` row as the draft's vitals source (S1 PR C2b1; VN-D5,
// design §3.2 "Vitals"). The encounter's own latest row, never merged with another. A field that was not captured is left out (the
// compiler drafts only what is there), not passed as null.
import type { VitalsDraftInput } from "@chartwarden/hearthnote";

/** The `vitals` columns the draft reads (a Drizzle row satisfies it). */
export interface VitalsRow {
  readonly id: string;
  readonly capturedAt: Date;
  readonly bpSystolic: number | null;
  readonly bpDiastolic: number | null;
  readonly heartRate: number | null;
  readonly respiratoryRate: number | null;
  /** A decimal as text; the unit travels with it. */
  readonly temperature: string | null;
  readonly temperatureUnit: string | null;
  readonly spo2: number | null;
  readonly painScore: number | null;
  readonly painScale: string | null;
}

const present = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } =>
  value === null ? {} : ({ [key]: value } as { [P in K]: V });

export function vitalsDraftInput(row: VitalsRow): VitalsDraftInput {
  const temperatureUnit =
    row.temperatureUnit === "f" || row.temperatureUnit === "c" ? row.temperatureUnit : null;
  return {
    id: row.id,
    recordedAt: row.capturedAt.toISOString(),
    ...present("bpSystolic", row.bpSystolic),
    ...present("bpDiastolic", row.bpDiastolic),
    ...present("heartRate", row.heartRate),
    ...present("respiratoryRate", row.respiratoryRate),
    // A temperature needs its unit, and a unit that is not f or c is not a temperature phrase.
    ...(row.temperature !== null && temperatureUnit !== null
      ? { temperature: row.temperature, temperatureUnit }
      : {}),
    ...present("spo2", row.spo2),
    // Only the 0-10 numeric rating is a vital; a pain reading on another scale (or one with no scale) is a scale reading.
    ...(row.painScale === "nrs_0_10" ? present("painScore", row.painScore) : {}),
  };
}
