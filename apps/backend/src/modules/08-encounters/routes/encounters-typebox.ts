// apps/backend/src/modules/08-encounters/routes/encounters-typebox.ts — M8-T09 TypeBox route schemas
// (§4.2). Named `encounters-typebox` (NOT `*schema*`) so the table-ownership import heuristic never
// mistakes a TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope. Schemas mirror §4.2 (abbreviated where the spec spells out only the
// consequential routes). Optimistic concurrency rides the `If-Match` header (NOT the body); the sign
// routes carry the client's step-up timestamp (verified server-side ≤ 5 min stale, §2.7 D13).
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

// §2.2 vocab mirrors (string-literal unions; the canonical types live in @wardenx/types).
const ENCOUNTER_TYPE = [
  "routine_visit",
  "admission_visit",
  "recert_visit",
  "face_to_face",
  "telephonic",
  "lpn_visit",
  "chha_visit",
  "msw_assessment",
  "msw_followup",
  "chaplain_assessment",
  "chaplain_visit",
  "volunteer_visit",
  "bereavement_contact",
  "idg_followup",
] as const;
const ENCOUNTER_DISCIPLINE = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "volunteer",
  "md",
  "np",
] as const;

const Text = (min = 1, max = 4000) => Type.String({ minLength: min, maxLength: max });

// ── Path params (slice ids are uuid-shaped; cross-module ids are validated uuids per §4.2) ───────────
export const EncounterParamsSchema = Type.Object({
  encounterId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const VitalParamsSchema = Type.Object({
  encounterId: Type.String({ minLength: 1, maxLength: 64 }),
  vitalId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const CarePlanLinkParamsSchema = Type.Object({
  encounterId: Type.String({ minLength: 1, maxLength: 64 }),
  linkId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const ModificationParamsSchema = Type.Object({
  encounterId: Type.String({ minLength: 1, maxLength: 64 }),
  modId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const AddendumParamsSchema = Type.Object({
  encounterId: Type.String({ minLength: 1, maxLength: 64 }),
  addendumId: Type.String({ minLength: 1, maxLength: 64 }),
});

// ── Bodies ──────────────────────────────────────────────────────────────────────────────────────────
export const CreateEncounterSchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  admissionId: Type.String({ format: "uuid" }),
  visitId: Type.Optional(Type.String({ format: "uuid" })),
  encounterType: lit(ENCOUNTER_TYPE),
  discipline: lit(ENCOUNTER_DISCIPLINE),
  serviceDate: Type.String({ format: "date" }),
  faceToFaceEncounterId: Type.Optional(Type.String({ format: "uuid" })),
  bereavementPlanId: Type.Optional(Type.String({ format: "uuid" })),
});

export const UpdateSelectionsSchema = Type.Object({
  selections: Type.Record(Type.String(), Type.Unknown()),
  freeText: Type.Optional(Type.Record(Type.String(), Type.String())),
});

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
  weight: Type.Optional(Type.String({ maxLength: 16 })),
  weightUnit: Type.Optional(lit(VITAL_UNIT)),
  height: Type.Optional(Type.String({ maxLength: 16 })),
  heightUnit: Type.Optional(lit(VITAL_UNIT)),
  bloodGlucose: Int,
  bloodGlucoseUnit: Type.Optional(lit(VITAL_UNIT)),
  clinicallyNotIndicatedFields: Type.Optional(Type.Array(Type.String({ maxLength: 64 }))),
  clinicallyNotIndicatedReason: Type.Optional(Type.String({ maxLength: 4000 })),
});

// §2.2 D10 — per-encounter mileage; the source picks how `miles_driven` is resolved.
const MILES_SOURCE = ["odometer", "route_calc", "manual_override"] as const;
export const CaptureMileageSchema = Type.Object({
  odometerStart: Int,
  odometerEnd: Int,
  milesDriven: Type.Optional(Type.String({ maxLength: 32 })),
  source: lit(MILES_SOURCE),
  manualOverrideReason: Type.Optional(Type.String({ maxLength: 4000 })),
  routeProposedMiles: Type.Optional(Type.String({ maxLength: 32 })),
});

export const CarePlanLinkSchema = Type.Object({
  problemId: Type.Optional(Type.String({ format: "uuid" })),
  goalId: Type.Optional(Type.String({ format: "uuid" })),
  interventionId: Type.Optional(Type.String({ format: "uuid" })),
});

export const EvvReconcileSchema = Type.Object({
  evvMissingReason: Type.String({ minLength: 20, maxLength: 4000 }),
});

export const FinalizeEncounterSchema = Type.Object({});

export const HearthnoteEnhanceSchema = Type.Object({
  style: Type.Object({
    tone: Type.Union([Type.Literal("formal"), Type.Literal("conversational")]),
    brevity: Type.Union([Type.Literal("concise"), Type.Literal("detailed")]),
  }),
});

export const ModificationDecisionSchema = Type.Object({
  decision: Type.Union([Type.Literal("accept"), Type.Literal("edit"), Type.Literal("reject")]),
  editedText: Type.Optional(Type.String({ maxLength: 4000 })),
});

export const SignEncounterSchema = Type.Object({
  stepUpAuthAt: Type.String({ format: "date-time" }),
  attestationConfirmed: Type.Literal(true),
});

export const LateEntryOverrideSchema = Type.Object({
  reason: Text(40),
  stepUpAuthAt: Type.String({ format: "date-time" }),
});

export const AdministrativeOverrideSchema = Type.Object({
  reason: Text(100),
  stepUpAuthAt: Type.String({ format: "date-time" }),
});

export const VoidEncounterSchema = Type.Object({
  reason: Text(40),
});

export const SupervisorReleaseSchema = Type.Object({
  reason: Text(40),
  stepUpAuthAt: Type.String({ format: "date-time" }),
});

export const CreateAddendumSchema = Type.Object({
  reason: Type.String({ minLength: 20, maxLength: 4000 }),
});

// ── Queries ───────────────────────────────────────────────────────────────────────────────────────
export const EncounterListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ maxLength: 64 })),
  authorId: Type.Optional(Type.String({ maxLength: 64 })),
  status: Type.Optional(Type.String({ maxLength: 32 })),
  lateEntryTier: Type.Optional(Type.String({ maxLength: 32 })),
  from: Type.Optional(Type.String({ maxLength: 32 })),
  to: Type.Optional(Type.String({ maxLength: 32 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const BillableQuerySchema = Type.Object({
  encounterIds: Type.Array(Type.String({ format: "uuid" }), { maxItems: 500 }),
});

export const SignedSinceQuerySchema = Type.Object({
  since: Type.String({ format: "date-time" }),
  patientId: Type.Optional(Type.String({ maxLength: 64 })),
});

/** Parse `raw` through `schema` → typed value, or throw M1's VALIDATION_FAILED envelope. */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
