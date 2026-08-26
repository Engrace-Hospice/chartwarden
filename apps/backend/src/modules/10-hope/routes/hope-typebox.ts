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
import { LATE_COMPLETION_REASON_CODES } from "@wardenx/hope";
import { HOPE_RFA_KINDS } from "@wardenx/types";
import { ValidationError } from "@wardenx/types";
import type {
  HopeAssessmentView as ServiceAssessmentView,
  HopeComplianceView as ServiceComplianceView,
  HopeScheduleView as ServiceScheduleView,
  HopeSfvView as ServiceSfvView,
  HopeSubmissionView as ServiceSubmissionView,
} from "./service";

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
/** §4.4 / D12 — the closed CMS-aligned late-completion codelist (`LATE_COMPLETION_REASON_CODES`). */
const LATE_COMPLETION_REASON = lit(LATE_COMPLETION_REASON_CODES);

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
export const ScheduleParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const AdmissionParamsSchema = Type.Object({
  admissionId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const AssessmentParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const PatientParamsSchema = Type.Object({
  patientId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const SfvParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });
export const SubmissionParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});

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
  // #48 / D12 — the late-completion branch of the §4.4 capture gate. The closed CMS-aligned codelist is
  // `LATE_COMPLETION_REASON_CODES` in @wardenx/hope; it is spelled out here rather than imported so the
  // emitted OpenAPI enumerates the accepted values for a client.
  lateCompletionReasonCode: Type.Optional(LATE_COMPLETION_REASON),
  adminOverride: Type.Optional(Type.Boolean()),
  // #48 — the window this capture completes, as the timepoint worklist hands it to the clinician.
  scheduleId: Type.Optional(Type.String({ format: "uuid" })),
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

// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────
// The read + write routes returned typed service view shapes (`HopeAssessmentView` / `HopeScheduleView` /
// `HopeSfvView` / `HopeSubmissionView` / `HopeComplianceView` and their `{ items }` envelopes) but published
// NO response contract, so the generated client typed every body as `never`. These DTOs mirror the service's
// read views 1:1 and are pinned to them by the compile-time `Conforms` aliases below, so a view field added
// or renamed breaks `bun run build` rather than silently drifting from the client.
const ASSESSMENT_STATUS = lit(["draft", "signed", "superseded"] as const);
const SCHEDULE_STATUS = lit(["open", "completed", "expired", "skipped"] as const);
const SFV_STATUS = lit(["open", "completed", "overdue", "missed"] as const);
const SUBMISSION_STATUS = lit([
  "queued",
  "in_flight",
  "accepted",
  "rejected",
  "partially_accepted",
] as const);
const SCHEDULE_GENERATED_BY = lit([
  "auto_admission",
  "auto_discharge",
  "sfv_trigger",
  "manual_admin",
] as const);
const NullableString = () => Type.Union([Type.String(), Type.Null()]);
const NullableNumber = () => Type.Union([Type.Number(), Type.Null()]);

/** One HOPE assessment view (sections snapshot + J2051 trigger verdict + correction chain). */
export const HopeAssessmentResponseSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  rfaKind: RFA_KIND,
  status: ASSESSMENT_STATUS,
  targetDate: Type.String(),
  authorDiscipline: Type.String(),
  j2051MaxSeverity: Type.Union([J2051_SEVERITY, Type.Null()]),
  j2051TriggerFired: Type.Boolean(),
  wasLate: Type.Boolean(),
  signedAt: NullableString(),
  signedBy: NullableString(),
  correctsAssessmentId: NullableString(),
  supersededByAssessmentId: NullableString(),
  snapshot: Type.Union([
    Type.Record(Type.String(), Type.Union([Type.Number(), Type.Null()])),
    Type.Null(),
  ]),
  version: Type.Integer(),
});
/** One HOPE timepoint-schedule view (window + late-deadline + provenance). */
export const HopeScheduleResponseSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  rfaKind: RFA_KIND,
  status: SCHEDULE_STATUS,
  windowOpensAt: Type.String(),
  windowClosesAt: Type.String(),
  lateDeadlineAt: Type.String(),
  generatedBy: SCHEDULE_GENERATED_BY,
  completedByAssessmentId: NullableString(),
});
/** One Symptom-Follow-Up-Visit obligation view. */
export const HopeSfvResponseSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  triggeringAssessmentId: Type.String(),
  status: SFV_STATUS,
  triggeredAt: Type.String(),
  dueAt: Type.String(),
  completingAssessmentId: NullableString(),
});
/** One iQIES submission-batch view (per-provider-entity, with item outcome counts). */
export const HopeSubmissionResponseSchema = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  submissionPeriod: Type.String(),
  status: SUBMISSION_STATUS,
  itemCount: Type.Integer(),
  acceptedCount: Type.Integer(),
  rejectedCount: Type.Integer(),
  transmittedAt: NullableString(),
  acceptedAt: NullableString(),
});
/** Org-level HQRP compliance posture (on-time + acceptance rates). */
/** #48 — every rate is nullable (`null` = no data, which is NOT 100%) and ships beside the count pair it
 * was computed from, so a consumer can suppress a small-N rate instead of rendering a fragile one. */
export const HopeComplianceResponseSchema = Type.Object({
  providerEntityId: NullableString(),
  hopeOnTimeRate: NullableNumber(),
  hopeOnTimeCounts: Type.Object({ onTime: Type.Integer(), total: Type.Integer() }),
  sfvOnTimeRate: NullableNumber(),
  sfvOnTimeCounts: Type.Object({ onTime: Type.Integer(), total: Type.Integer() }),
  submissionAcceptanceRate: NullableNumber(),
  submissionAcceptanceCounts: Type.Object({ accepted: Type.Integer(), total: Type.Integer() }),
});

// List / envelope responses (the service returns keyed wrappers, never bare arrays).
export const HopeScheduleListResponseSchema = Type.Object({
  schedules: Type.Array(HopeScheduleResponseSchema),
});
export const HopeAssessmentListResponseSchema = Type.Object({
  assessments: Type.Array(HopeAssessmentResponseSchema),
});
export const HopeSfvListResponseSchema = Type.Object({
  sfvs: Type.Array(HopeSfvResponseSchema),
});
export const HopeSubmissionListResponseSchema = Type.Object({
  submissions: Type.Array(HopeSubmissionResponseSchema),
});

/** Route 11 — the async summary-PDF request acknowledgement (202). */
export const HopeSummaryRequestedResponseSchema = Type.Object({
  assessmentId: Type.String(),
  requested: Type.Literal(true),
});
/** Route 14 — on-demand pre-submission validation findings for one row. */
export const HopeValidationResponseSchema = Type.Object({
  assessmentId: Type.String(),
  findings: Type.Array(
    Type.Object({
      ruleId: Type.String(),
      severity: Type.String(),
      message: Type.String(),
    }),
  ),
});
/** Route 20 — the admin schedule-recompute result (rows touched). */
export const HopeRegenerateResponseSchema = Type.Object({
  admissionId: Type.String(),
  scheduleCount: Type.Integer(),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _Assessment = Conforms<Static<typeof HopeAssessmentResponseSchema>, ServiceAssessmentView>;
type _Schedule = Conforms<Static<typeof HopeScheduleResponseSchema>, ServiceScheduleView>;
type _Sfv = Conforms<Static<typeof HopeSfvResponseSchema>, ServiceSfvView>;
type _Submission = Conforms<Static<typeof HopeSubmissionResponseSchema>, ServiceSubmissionView>;
type _Compliance = Conforms<Static<typeof HopeComplianceResponseSchema>, ServiceComplianceView>;
type _ScheduleList = Conforms<
  Static<typeof HopeScheduleListResponseSchema>,
  { readonly schedules: readonly ServiceScheduleView[] }
>;
type _AssessmentList = Conforms<
  Static<typeof HopeAssessmentListResponseSchema>,
  { readonly assessments: readonly ServiceAssessmentView[] }
>;
type _SfvList = Conforms<
  Static<typeof HopeSfvListResponseSchema>,
  { readonly sfvs: readonly ServiceSfvView[] }
>;
type _SubmissionList = Conforms<
  Static<typeof HopeSubmissionListResponseSchema>,
  { readonly submissions: readonly ServiceSubmissionView[] }
>;
type _SummaryRequested = Conforms<
  Static<typeof HopeSummaryRequestedResponseSchema>,
  { assessmentId: string; requested: true }
>;
type _Validation = Conforms<
  Static<typeof HopeValidationResponseSchema>,
  {
    assessmentId: string;
    findings: ReadonlyArray<{ ruleId: string; severity: string; message: string }>;
  }
>;
type _Regenerate = Conforms<
  Static<typeof HopeRegenerateResponseSchema>,
  { admissionId: string; scheduleCount: number }
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
