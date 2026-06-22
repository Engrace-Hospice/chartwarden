// apps/backend/src/modules/09-assessments/routes/assessments-typebox.ts — M9-T05 TypeBox route schemas
// (§4.3). Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a
// TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's VALIDATION_FAILED
// envelope. The record body is the §4.3 discriminated-union envelope: a `scaleType` (validated against the
// canonical `SCALE_TYPES`), the common capture envelope, and a per-scale `data` object the server scores
// (the API ignores any client-sent `score` — D6 server-authoritative). Optimistic concurrency on the
// correction route rides the `If-Match` header (NOT the body) → 412 STALE_VERSION on skew.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import { SCALE_TYPES } from "@wardenx/types";

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

/** The canonical scale-type union, mirrored from @wardenx/types `SCALE_TYPES` (single source). */
const SCALE_TYPE = lit(SCALE_TYPES);

// ── Path params (slice ids are uuid-shaped; cross-module ids are validated uuids per §4.3) ────────────
export const PatientParamsSchema = Type.Object({
  patientId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const PatientAssessmentParamsSchema = Type.Object({
  patientId: Type.String({ minLength: 1, maxLength: 64 }),
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const PatientScaleParamsSchema = Type.Object({
  patientId: Type.String({ minLength: 1, maxLength: 64 }),
  scaleType: SCALE_TYPE,
});
export const AssessmentParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const ChangeEventParamsSchema = Type.Object({
  eventId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const LicenseParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const ScalePolicyParamsSchema = Type.Object({
  scaleType: SCALE_TYPE,
});

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────────────
// §4.3 — the common capture envelope shared by every per-scale record subtype.
const CommonRecordFields = {
  scaleType: SCALE_TYPE,
  capturedAt: Type.String({ format: "date-time" }),
  sourceEncounterId: Type.Optional(Type.String({ format: "uuid" })),
  actingAs: Type.Optional(Type.Union([Type.Literal("self"), Type.Literal("patient_representative")])),
  actingConsentId: Type.Optional(Type.String({ format: "uuid" })),
  sudContext: Type.Optional(Type.Boolean()), // only meaningful for scaleType='aims'
  // The per-scale `data` payload (typed per scaleType in the client SDK + the per-scale `schema.ts`); the
  // server narrows + scores it. Captured here as an object so the union route validates the envelope and
  // the service dispatches scoring; the API IGNORES any client-sent `score` (D6 server-authoritative).
  data: Type.Record(Type.String(), Type.Unknown()),
};

export const RecordAssessmentSchema = Type.Object({
  admissionId: Type.String({ format: "uuid" }),
  ...CommonRecordFields,
});

export const CorrectAssessmentSchema = Type.Object({
  admissionId: Type.String({ format: "uuid" }),
  correctionReason: Type.String({ minLength: 1, maxLength: 2000 }),
  ...CommonRecordFields,
});

export const CosignatureSchema = Type.Object({
  attestationConfirmed: Type.Literal(true),
});

export const AcknowledgeChangeSchema = Type.Object({
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});

// §4.1 admin — license CRUD + scale-policy toggle (org_admin; idempotent via Idempotency-Key, M09-F06).
export const CreateLicenseSchema = Type.Object({
  scaleType: SCALE_TYPE,
  vendor: Type.String({ minLength: 1, maxLength: 200 }),
  effectiveDate: Type.String({ format: "date" }),
  expiresAt: Type.String({ format: "date" }),
  seats: Type.Optional(Type.Integer({ minimum: 0 })),
});
export const UpdateLicenseSchema = Type.Object({
  vendor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  effectiveDate: Type.Optional(Type.String({ format: "date" })),
  expiresAt: Type.Optional(Type.String({ format: "date" })),
  seats: Type.Optional(Type.Integer({ minimum: 0 })),
});
export const UpdateScalePolicySchema = Type.Object({
  enabled: Type.Boolean(),
});

// ── Queries ───────────────────────────────────────────────────────────────────────────────────────────
export const AssessmentListQuerySchema = Type.Object({
  scaleType: Type.Optional(Type.String({ maxLength: 32 })),
  from: Type.Optional(Type.String({ maxLength: 32 })),
  to: Type.Optional(Type.String({ maxLength: 32 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export const SeriesQuerySchema = Type.Object({
  from: Type.String({ format: "date" }),
  to: Type.String({ format: "date" }),
});
export const DeltaQuerySchema = Type.Object({
  from: Type.String({ format: "date" }),
  to: Type.String({ format: "date" }),
});
export const LatestBatchQuerySchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  scaleTypes: Type.Array(SCALE_TYPE, { minItems: 1, maxItems: 14 }),
});
export const SeriesBatchQuerySchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  scaleType: SCALE_TYPE,
  from: Type.String({ format: "date" }),
  to: Type.String({ format: "date" }),
});
export const ChangeListQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ maxLength: 32 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
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
