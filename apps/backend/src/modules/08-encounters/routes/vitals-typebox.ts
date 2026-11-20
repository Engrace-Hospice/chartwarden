// apps/backend/src/modules/08-encounters/routes/vitals-typebox.ts — the vitals capture body and the vitals responses of the M8
// routes (§4.2 routes 4, 5, 5b). Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox
// import for a Drizzle one. Re-exported by `encounters-typebox.ts`, which the route and the OpenAPI enrichments import from.
import { type Static, Type } from "@sinclair/typebox";
import { HEIGHT_UNITS, WEIGHT_UNITS } from "../authoring/measurements";
import type {
  EncounterRouteService as ServiceRouteApi,
  VitalsResult as ServiceVitalsResult,
} from "./service";

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

// §2.2 — numeric-direct vitals (the `vitals` row shape; numerics-as-text preserve their unit). "Clinically
// not indicated" is a first-class value: a non-empty field list carries a documented reason, not a NULL.
const VITAL_UNIT = [
  "mmHg",
  "bpm",
  "breaths_per_min",
  "c",
  "f",
  "percent_o2",
  "kg",
  "lb",
  "cm",
  "in",
  "mg_dl",
  "mmol_l",
] as const;
const PAIN_SCALE = ["nrs_0_10", "flacc", "painad", "verbal_descriptor"] as const;
const Int = Type.Optional(Type.Integer());
export const CaptureVitalsSchema = Type.Object({
  bpSystolic: Int,
  bpDiastolic: Int,
  heartRate: Int,
  respiratoryRate: Int,
  temperature: Type.Optional(Type.String({ maxLength: 16 })),
  temperatureUnit: Type.Optional(lit(VITAL_UNIT)),
  spo2: Int,
  painScore: Int,
  painScale: Type.Optional(lit(PAIN_SCALE)),
  // A weight/height is a positive number WITH its unit, of its own family (kg|lb, cm|in): `planVitalsCapture` refuses a value with no
  // unit and a non-numeric value with a 422 naming the field, so the note's weight and BMI never rest on a guessed unit.
  weight: Type.Optional(Type.String({ maxLength: 16 })),
  weightUnit: Type.Optional(lit(WEIGHT_UNITS)),
  height: Type.Optional(Type.String({ maxLength: 16 })),
  heightUnit: Type.Optional(lit(HEIGHT_UNITS)),
  bloodGlucose: Int,
  bloodGlucoseUnit: Type.Optional(lit(VITAL_UNIT)),
  clinicallyNotIndicatedFields: Type.Optional(Type.Array(Type.String({ maxLength: 64 }))),
  clinicallyNotIndicatedReason: Type.Optional(Type.String({ maxLength: 4000 })),
});

/** Routes 4/5 — a vitals capture/edit result (§4.4 decorators). */
export const VitalsResultResponseSchema = Type.Object({
  vitalsId: Type.String(),
  fieldsCaptured: Type.Array(Type.String()),
  abnormalFlags: Type.Array(Type.String()),
  bmi: Type.Union([Type.String(), Type.Null()]),
});

/**
 * Route 5b — one stored vitals set read back (#92). Nullable rather than optional on every field:
 * the row exists and the measurement is genuinely absent, which is a different clinical statement
 * from "this key was not sent" — a `null` spo2 on a signed encounter says nobody recorded it.
 */
const NullableInt = Type.Union([Type.Integer(), Type.Null()]);
const NullableStr = Type.Union([Type.String(), Type.Null()]);
const NullableUnit = Type.Union([lit(VITAL_UNIT), Type.Null()]);
export const VitalsViewResponseSchema = Type.Object({
  id: Type.String(),
  encounterId: Type.String(),
  capturedAt: Type.String(),
  bpSystolic: NullableInt,
  bpDiastolic: NullableInt,
  heartRate: NullableInt,
  respiratoryRate: NullableInt,
  temperature: NullableStr,
  temperatureUnit: NullableUnit,
  spo2: NullableInt,
  painScore: NullableInt,
  painScale: Type.Union([lit(PAIN_SCALE), Type.Null()]),
  weight: NullableStr,
  weightUnit: NullableUnit,
  height: NullableStr,
  heightUnit: NullableUnit,
  bmi: NullableStr,
  bloodGlucose: NullableInt,
  bloodGlucoseUnit: NullableUnit,
  clinicallyNotIndicatedFields: Type.Union([Type.Array(Type.String()), Type.Null()]),
  clinicallyNotIndicatedReason: NullableStr,
  abnormalFlags: Type.Array(Type.String()),
});

/** Route 5b — the `{ encounterId, vitals }` envelope, newest capture first. */
export const VitalsListResponseSchema = Type.Object({
  encounterId: Type.String(),
  patientId: Type.String(),
  /** A stored weight / height whose unit is missing or not of its family (legacy rows): never stated in the note; re-enter it with its unit. */
  weightUnitMissing: Type.Boolean(),
  heightUnitMissing: Type.Boolean(),
  vitals: Type.Array(VitalsViewResponseSchema),
});

// Compile-time pins: what the schema publishes and what the service returns must be mutually assignable.
type Ret<K extends keyof ServiceRouteApi> = Awaited<ReturnType<ServiceRouteApi[K]>>;
type Conforms<T extends V, V> = T;
export type VitalsSchemaPins = [
  Conforms<Static<typeof VitalsResultResponseSchema>, ServiceVitalsResult>,
  Conforms<Static<typeof VitalsListResponseSchema>, Ret<"listVitals">>,
];
