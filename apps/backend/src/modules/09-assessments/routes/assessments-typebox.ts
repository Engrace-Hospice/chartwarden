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
import type {
  ScaleDelta as ServiceScaleDelta,
  ScaleSeries as ServiceScaleSeries,
} from "@wardenx/types";
import type {
  AssessmentView as ServiceAssessmentView,
  ScaleLicenseView as ServiceScaleLicenseView,
  ScalePolicyView as ServiceScalePolicyView,
  SignificantChangeView as ServiceSignificantChangeView,
} from "./service";

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
  actingAs: Type.Optional(
    Type.Union([Type.Literal("self"), Type.Literal("patient_representative")]),
  ),
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

// ── §4.3 RESPONSE DTOs (F0 enrichment) ───────────────────────────────────────────────────────────────
// The read routes returned typed service views (`AssessmentView` / `ScaleSeries` / `ScaleDelta` /
// `ScaleLicenseView` / `ScalePolicyView` / `SignificantChangeView` and their list envelopes) but published
// NO response contract, so the generated client typed every GET body as `never`. These DTOs mirror the
// service's read views 1:1 and are pinned to them by the compile-time `Conforms` aliases below, so a view
// field added or renamed breaks `bun run build` rather than silently drifting from the client. Enum-valued
// columns are pinned to their literal unions (not a bare `Type.String()`) so the wire contract stays honest.
const nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

const ACTING_AS = Type.Union([Type.Literal("self"), Type.Literal("patient_representative")]);
const ASSESSMENT_STATUS = Type.Union([Type.Literal("active"), Type.Literal("superseded")]);
const SIGNIFICANT_CHANGE_STATUS = Type.Union([
  Type.Literal("open"),
  Type.Literal("acknowledged"),
  Type.Literal("escalated"),
]);
const SIGNIFICANT_CHANGE_SEVERITY = Type.Union([Type.Literal("medium"), Type.Literal("high")]);
const SCALE_LICENSE_STATUS = Type.Union([
  Type.Literal("active"),
  Type.Literal("pending_renewal"),
  Type.Literal("expired"),
]);
const SIGNIFICANT_CHANGE_RULE_ID = lit([
  "pps_drop_20_in_14d",
  "kps_drop_20_in_14d",
  "esas_total_increase_20_in_7d",
  "esas_symptom_ge_7",
  "painad_ge_4",
  "nyha_class_iv",
  "braden_le_12",
  "morse_ge_51",
  "meld_ge_30",
  "fast_progression_30d",
  "gds_progression_30d",
  "flacker_increase",
  "aims_emergent_dyskinesia",
] as const);

/** One assessment row (the §4.3 `AssessmentDto`) — server-scored, SUD-redaction-aware. */
export const AssessmentViewResponseSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  scaleType: SCALE_TYPE,
  scaleVersion: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
  score: nullable(Type.Number()),
  scoreInterpretation: nullable(Type.String()),
  capturedAt: Type.String(),
  capturedByDiscipline: Type.String(),
  recordedByUserId: Type.String(),
  sourceEncounterId: nullable(Type.String()),
  cosignRequired: Type.Boolean(),
  cosignedAt: nullable(Type.String()),
  sudContext: Type.Boolean(),
  actingAs: ACTING_AS,
  actingConsentId: nullable(Type.String()),
  status: ASSESSMENT_STATUS,
  correctsAssessmentId: nullable(Type.String()),
  correctionReason: nullable(Type.String()),
  redacted: Type.Boolean(),
  version: Type.Integer(),
});

/** Route 3 — the patient assessment timeline envelope. */
export const AssessmentListResponseSchema = Type.Object({
  assessments: Type.Array(AssessmentViewResponseSchema),
});

/** Route 18 — the per-scale latest-capture summary surface. */
export const AssessmentSummaryResponseSchema = Type.Object({
  patientId: Type.String(),
  latest: Type.Array(AssessmentViewResponseSchema),
});

/** One scored point in a series (§4.3 `SeriesPointDto`). */
export const ScaleSeriesPointResponseSchema = Type.Object({
  assessmentId: Type.String(),
  capturedAt: Type.String(),
  score: nullable(Type.Number()),
  scoreInterpretation: nullable(Type.String()),
  significantChange: Type.Boolean(),
});

/** Routes 6 & 12 — a windowed series of one scale (§4.3 `SeriesResponseDto`). */
export const ScaleSeriesResponseSchema = Type.Object({
  scaleType: SCALE_TYPE,
  patientId: Type.String(),
  from: Type.String(),
  to: Type.String(),
  points: Type.Array(ScaleSeriesPointResponseSchema),
});

/** Route 7 — the latest-vs-window delta for one scale. */
export const ScaleDeltaResponseSchema = Type.Object({
  scaleType: SCALE_TYPE,
  patientId: Type.String(),
  window: Type.Object({ from: Type.String(), to: Type.String() }),
  latestScore: nullable(Type.Number()),
  priorScore: nullable(Type.Number()),
  delta: nullable(Type.Number()),
});

/** Route 11 — the LatestAssessmentProvider batch envelope. */
export const LatestBatchResponseSchema = Type.Object({
  latest: Type.Array(AssessmentViewResponseSchema),
});

/** One significant-change worklist row. */
export const SignificantChangeViewResponseSchema = Type.Object({
  id: Type.String(),
  assessmentId: Type.String(),
  priorAssessmentId: nullable(Type.String()),
  ruleId: SIGNIFICANT_CHANGE_RULE_ID,
  status: SIGNIFICANT_CHANGE_STATUS,
  severity: SIGNIFICANT_CHANGE_SEVERITY,
});

/** Route 9 — the significant-change worklist envelope. */
export const SignificantChangeListResponseSchema = Type.Object({
  events: Type.Array(SignificantChangeViewResponseSchema),
});

/** One scale-license registry row (status computed from the effective/expires window, D3). */
export const ScaleLicenseViewResponseSchema = Type.Object({
  id: Type.String(),
  scaleType: SCALE_TYPE,
  vendor: Type.String(),
  effectiveDate: Type.String(),
  expiresAt: Type.String(),
  seats: nullable(Type.Integer()),
  status: SCALE_LICENSE_STATUS,
});

/** Route 13 — the scale-license registry envelope. */
export const ScaleLicenseListResponseSchema = Type.Object({
  licenses: Type.Array(ScaleLicenseViewResponseSchema),
});

/** One scale-policy row (the enabled/disabled state for a tenant scale). */
export const ScalePolicyViewResponseSchema = Type.Object({
  scaleType: SCALE_TYPE,
  enabled: Type.Boolean(),
});

/** Route 16 — the scale-policy registry envelope. */
export const ScalePolicyListResponseSchema = Type.Object({
  policies: Type.Array(ScalePolicyViewResponseSchema),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _AssessmentView = Conforms<Static<typeof AssessmentViewResponseSchema>, ServiceAssessmentView>;
type _AssessmentList = Conforms<
  Static<typeof AssessmentListResponseSchema>,
  { readonly assessments: readonly ServiceAssessmentView[] }
>;
type _AssessmentSummary = Conforms<
  Static<typeof AssessmentSummaryResponseSchema>,
  { readonly patientId: string; readonly latest: readonly ServiceAssessmentView[] }
>;
type _ScaleSeries = Conforms<Static<typeof ScaleSeriesResponseSchema>, ServiceScaleSeries>;
type _ScaleDelta = Conforms<Static<typeof ScaleDeltaResponseSchema>, ServiceScaleDelta>;
type _LatestBatch = Conforms<
  Static<typeof LatestBatchResponseSchema>,
  { readonly latest: readonly ServiceAssessmentView[] }
>;
type _SignificantChangeView = Conforms<
  Static<typeof SignificantChangeViewResponseSchema>,
  ServiceSignificantChangeView
>;
type _SignificantChangeList = Conforms<
  Static<typeof SignificantChangeListResponseSchema>,
  { readonly events: readonly ServiceSignificantChangeView[] }
>;
type _ScaleLicenseView = Conforms<
  Static<typeof ScaleLicenseViewResponseSchema>,
  ServiceScaleLicenseView
>;
type _ScaleLicenseList = Conforms<
  Static<typeof ScaleLicenseListResponseSchema>,
  { readonly licenses: readonly ServiceScaleLicenseView[] }
>;
type _ScalePolicyView = Conforms<
  Static<typeof ScalePolicyViewResponseSchema>,
  ServiceScalePolicyView
>;
type _ScalePolicyList = Conforms<
  Static<typeof ScalePolicyListResponseSchema>,
  { readonly policies: readonly ServiceScalePolicyView[] }
>;

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
