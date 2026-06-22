// apps/backend/src/modules/10-hope/routes/hope-typebox.ts — M10-T06 TypeBox route schemas (§4.1 / §4.3).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox
// import for a Drizzle one. Validation runs through TypeBox `Value` → M1's VALIDATION_FAILED envelope.
//
// The full §4.3 per-RFA discriminated union (with every Section A–Z schema) lands with the per-section
// modules; this T06 boundary captures the recording envelope plus Section J's J2051 entries — the field
// the server-authoritative `evaluateJ2051Trigger` (D4) reads at sign — so the trigger/ SFV flow is wired
// end-to-end. The server IGNORES any client-sent trigger flag (D4); the `data` object is otherwise carried
// opaquely and narrowed by the per-section validators server-side.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { HOPE_RFA_KINDS } from "@wardenx/types";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

/** The canonical RFA-kind union, mirrored from @wardenx/types `HOPE_RFA_KINDS` (single source). */
const RFA_KIND = lit(HOPE_RFA_KINDS);
/** The §4.3 HOPE author disciplines accepted at the route boundary (the ABAC predicate is authoritative). */
const AUTHOR_DISCIPLINE = Type.Union([Type.Literal("RN"), Type.Literal("NP"), Type.Literal("MD")]);
/** The §4.3 J2051 per-symptom severity vocabulary. */
const J2051_SEVERITY = Type.Union([
  Type.Literal("none"),
  Type.Literal("mild"),
  Type.Literal("moderate"),
  Type.Literal("severe"),
]);
const DISCHARGE_REASON = Type.Union([
  Type.Literal("death"),
  Type.Literal("revocation"),
  Type.Literal("transfer_to_hospice"),
  Type.Literal("live_discharge"),
]);

/** §4.3 Section-J J2051 entries — the symptom-impact readings the D4 trigger evaluates. */
const J2051Entry = Type.Object({
  symptomCode: Type.String({ minLength: 1, maxLength: 64 }),
  severity: J2051_SEVERITY,
  otherSymptomLabel: Type.Optional(Type.String({ maxLength: 100 })),
});
/** The per-section `data` payload. Section J's J2051 entries are typed (the trigger reads them); other
 * sections are carried opaquely and narrowed by the server-side per-section validators (§4.3). */
const HopeData = Type.Object(
  {
    J: Type.Optional(
      Type.Object(
        { J2051: Type.Optional(Type.Object({ entries: Type.Array(J2051Entry, { maxItems: 8 }) })) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

// ── Path params ───────────────────────────────────────────────────────────────────────────────────────
export const ScheduleParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });
export const AdmissionParamsSchema = Type.Object({ admissionId: Type.String({ minLength: 1, maxLength: 64 }) });
export const AssessmentParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });
export const PatientParamsSchema = Type.Object({ patientId: Type.String({ minLength: 1, maxLength: 64 }) });
export const SfvParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });
export const SubmissionParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });

// ── Bodies ────────────────────────────────────────────────────────────────────────────────────────────
export const SkipScheduleSchema = Type.Object({
  reasonCode: Type.String({ minLength: 1, maxLength: 64 }),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export const RecordTimepointSchema = Type.Object({
  rfaKind: RFA_KIND,
  targetDate: Type.String({ format: "date-time" }),
  authorDiscipline: AUTHOR_DISCIPLINE,
  sourceEncounterId: Type.Optional(Type.String({ format: "uuid" })),
  dischargeReason: Type.Optional(DISCHARGE_REASON),
  data: HopeData,
});
export const RecordSfvSchema = Type.Object({
  triggeringAssessmentId: Type.String({ minLength: 1, maxLength: 64 }),
  targetDate: Type.String({ format: "date-time" }),
  authorDiscipline: AUTHOR_DISCIPLINE,
  adminOverride: Type.Optional(Type.Boolean()),
  data: HopeData,
});
export const UpdateDraftSchema = Type.Object({ data: HopeData });
export const SignTimepointSchema = Type.Object({ attestationConfirmed: Type.Literal(true) });
export const CorrectTimepointSchema = Type.Object({
  correctionReason: Type.String({ minLength: 1, maxLength: 2000 }),
  targetDate: Type.String({ format: "date-time" }),
  authorDiscipline: AUTHOR_DISCIPLINE,
  data: HopeData,
});
export const SummaryPdfSchema = Type.Object({});
export const RetrySubmissionSchema = Type.Object({});
export const AssembleSubmissionSchema = Type.Object({
  providerEntityId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const RegenerateSchedulesSchema = Type.Object({
  admissionId: Type.String({ minLength: 1, maxLength: 64 }),
});

// ── Queries ───────────────────────────────────────────────────────────────────────────────────────────
export const ScheduleListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ maxLength: 64 })),
  status: Type.Optional(Type.String({ maxLength: 32 })),
  rfaKind: Type.Optional(Type.String({ maxLength: 32 })),
});
export const SfvWorklistQuerySchema = Type.Object({
  state: Type.Optional(Type.String({ maxLength: 32 })),
});
export const SubmissionListQuerySchema = Type.Object({
  providerEntityId: Type.Optional(Type.String({ maxLength: 64 })),
});
export const DashboardQuerySchema = Type.Object({
  providerEntityId: Type.Optional(Type.String({ maxLength: 64 })),
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
