import { HOPE_J2051_SYMPTOM_CODES, HOPE_RFA_KINDS } from "@chartwarden/types";
import { ValidationError } from "@chartwarden/types";
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
import type {
  HopeAnswerPatchResult as ServiceAnswerPatchResult,
  HopeAssessmentView as ServiceAssessmentView,
  HopeAssessmentWorkspace as ServiceAssessmentWorkspace,
  HopeComplianceView as ServiceComplianceView,
  HopeReviewReadModel as ServiceReviewReadModel,
  HopeScheduleView as ServiceScheduleView,
  HopeSfvView as ServiceSfvView,
  HopeSignResult as ServiceSignResult,
  HopeSubmissionView as ServiceSubmissionView,
  HopeValidationRunView as ServiceValidationRunView,
  HopeWorkflowStateView as ServiceWorkflowStateView,
} from "./service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

/** The canonical RFA-kind union, mirrored from @chartwarden/types `HOPE_RFA_KINDS` (single source). */
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
  // Closed to the §2.1 CMS roster (`HOPE_J2051_SYMPTOM_CODES`). It was `Type.String({maxLength: 64})`,
  // while `j2051.ts`'s header described it as "the closed CMS list at the route boundary" — so the list
  // was closed in prose and open in code, and the emitted contract enumerated nothing a client could
  // pick from. Every symptomCode literal in the repo is already a member, so this closes a gap rather
  // than narrowing behaviour.
  symptomCode: lit(HOPE_J2051_SYMPTOM_CODES),
  severity: J2051_SEVERITY,
  otherSymptomLabel: Type.Optional(Type.String({ maxLength: 100 })),
});
const J2053Answer = Type.Union([
  Type.String({
    minLength: 1,
    maxLength: 16,
  }),
  Type.Number(),
]);

const J2053Data = Type.Object(
  {
    J2053A: Type.Optional(J2053Answer),
    J2053B: Type.Optional(J2053Answer),
    J2053C: Type.Optional(J2053Answer),
    J2053D: Type.Optional(J2053Answer),
    J2053E: Type.Optional(J2053Answer),
    J2053F: Type.Optional(J2053Answer),
    J2053G: Type.Optional(J2053Answer),
    J2053H: Type.Optional(J2053Answer),
  },
  {
    additionalProperties: false,
  },
);
/** A CMS Yes/No screening item. Typed as a union rather than a bare boolean because the payload the
 * mobile client and the recording modal produce is form data — `projectHopeSections` accepts all three
 * spellings, and the contract enumerates them so a client can see which ones are meant. */
const YesNo = Type.Union([Type.Boolean(), Type.Literal("yes"), Type.Literal("no")]);

/** §4.3 Section-J screening item (J2030 pain / J2050 shortness of breath): the Yes/No screen plus the
 * characteristics the §86 cross-field rule requires whenever the screen is Yes. `characteristics` is
 * deliberately open — CMS captures a different item set per symptom and the rule only asks whether
 * ANYTHING was documented. */
const JScreeningItem = Type.Object(
  {
    screened: Type.Optional(YesNo),
    characteristics: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

/**
 * The per-section `data` payload. Four sections are typed — the ones the CMS pre-submission rule set
 * reads (F-057): Section I's primary diagnosis, Section J's J2030/J2050/J2051 items, and Section N's
 * opioid / bowel-regimen triple. Every other section stays opaque and is narrowed by the server-side
 * per-section validators (§4.3).
 *
 * They are typed HERE, and not only in `@chartwarden/hope`'s projection, because the emitted OpenAPI is
 * what the generated client can express: a field the contract does not declare is one no caller can
 * send (F-031's M11 finding, one module over). The projection stays TOLERANT of anything — these types
 * describe the intended payload, they are not a second validation layer.
 */
const HopeData = Type.Object(
  {
    I: Type.Optional(
      Type.Object(
        {
          primaryDiagnosisIcd10: Type.Optional(Type.String({ maxLength: 16 })),
        },
        { additionalProperties: true },
      ),
    ),
    J: Type.Optional(
      Type.Object(
        {
          J2030: Type.Optional(JScreeningItem),
          J2050: Type.Optional(JScreeningItem),
          J2051: Type.Optional(Type.Object({ entries: Type.Array(J2051Entry, { maxItems: 8 }) })),
        },
        { additionalProperties: true },
      ),
    ),
    N: Type.Optional(
      Type.Object(
        {
          opioidPrescribed: Type.Optional(YesNo),
          scheduledBowelRegimen: Type.Optional(YesNo),
          bowelRegimenContraindication: Type.Optional(Type.String({ maxLength: 500 })),
        },
        { additionalProperties: true },
      ),
    ),
  },
  {
    additionalProperties: true,
  },
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
  lateCompletionReasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  // GAP-015: honoured ONLY for a holder of `hope.admin.late_deadline_override`, with a justification
  // (enforced in the route); the flag alone never lifts the hard cutoff.
  adminOverride: Type.Optional(Type.Boolean()),
  adminOverrideJustification: Type.Optional(Type.String({ minLength: 20, maxLength: 1000 })),
  // #48 — the window this capture completes, as the timepoint worklist hands it to the clinician.
  // (`lateCompletionReasonCode` stays a free string at the boundary: the §4.4 capture gate enforces the
  // CMS codelist exactly when the capture is late, and the capture workspace sends free text.)
  scheduleId: Type.Optional(Type.String({ format: "uuid" })),
  data: HopeData,
});
export const RecordSfvSchema = Type.Object({
  triggeringAssessmentId: Type.String({ minLength: 1, maxLength: 64 }),
  targetDate: Type.String({ format: "date-time" }),
  authorDiscipline: AUTHOR_DISCIPLINE,
  adminOverride: Type.Optional(Type.Boolean()),
  adminOverrideJustification: Type.Optional(Type.String({ minLength: 20, maxLength: 1000 })),
  data: HopeData,
});
export const UpdateDraftSchema = Type.Object({ data: HopeData });
const AnswerValueSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);
export const PatchAnswersSchema = Type.Object({
  ifVersion: Type.Integer({ minimum: 1 }),
  changes: Type.Array(
    Type.Union([
      Type.Object({
        itemCode: Type.String({ minLength: 1, maxLength: 32 }),
        action: Type.Literal("set"),
        value: AnswerValueSchema,
      }),
      Type.Object({
        itemCode: Type.String({ minLength: 1, maxLength: 32 }),
        action: Type.Literal("clear"),
      }),
    ]),
    { minItems: 1, maxItems: 32 },
  ),
});
export const SignTimepointSchema = Type.Object({
  ifVersion: Type.Integer({ minimum: 1 }),
  attestationConfirmed: Type.Optional(Type.Literal(true)),
});
export const SetHuvCompletionDateSchema = Type.Object({
  ifVersion: Type.Integer({ minimum: 1 }),
  z0350: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
});
export const CorrectTimepointSchema = Type.Object({
  correctionReason: Type.String({ minLength: 1, maxLength: 2000 }),
  ifVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  targetDate: Type.String({ format: "date-time" }),
  authorDiscipline: AUTHOR_DISCIPLINE,
  data: HopeData,
});
export const InactivateTimepointSchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  ifVersion: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const SummaryPdfSchema = Type.Object({});
export const RetrySubmissionSchema = Type.Object({});
export const AssembleSubmissionSchema = Type.Object({
  providerEntityId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const MarkSubmissionUploadedSchema = Type.Object({
  submittedAt: Type.Optional(Type.String({ format: "date-time" })),
  iqiesSubmissionReference: Type.Optional(
    Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  ),
});
const CMS_TOKEN = { maxLength: 64 };
export const ImportSubmissionResultSchema = Type.Object({
  reportReference: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  // Bounded: every row is stored (report, item result, finding), so an unbounded body is a write amplifier.
  results: Type.Array(
    Type.Object(
      {
        assessmentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        status: Type.Optional(Type.String(CMS_TOKEN)),
        result: Type.Optional(Type.String(CMS_TOKEN)),
        outcome: Type.Optional(Type.String(CMS_TOKEN)),
        severity: Type.Optional(Type.String(CMS_TOKEN)),
        code: Type.Optional(Type.String(CMS_TOKEN)),
        itemCode: Type.Optional(Type.String(CMS_TOKEN)),
        message: Type.Optional(Type.String({ maxLength: 1000 })),
        iqiesRecordId: Type.Optional(Type.String(CMS_TOKEN)),
      },
      { additionalProperties: false },
    ),
    { maxItems: 2000 },
  ),
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
export const ValidationQuerySchema = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("final")])),
  submissionDate: Type.Optional(Type.String({ format: "date-time" })),
});

// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────
// The read + write routes returned typed service view shapes (`HopeAssessmentView` / `HopeScheduleView` /
// `HopeSfvView` / `HopeSubmissionView` / `HopeComplianceView` and their `{ items }` envelopes) but published
// NO response contract, so the generated client typed every body as `never`. These DTOs mirror the service's
// read views 1:1 and are pinned to them by the compile-time `Conforms` aliases below, so a view field added
// or renamed breaks `bun run build` rather than silently drifting from the client.
const ASSESSMENT_STATUS = lit(["draft", "signed", "superseded"] as const);
const SCHEDULE_STATUS = lit(["open", "completed", "expired", "skipped"] as const);
const SFV_STATUS = lit(["open", "completed", "overdue", "missed", "withdrawn"] as const);
const SUBMISSION_STATUS = lit([
  "ready",
  "queued",
  "packaged",
  "exported",
  "in_flight",
  "submitted_pending_result",
  "accepted",
  "rejected",
  "partially_accepted",
  "accepted_with_warnings",
  "file_error",
] as const);
const SCHEDULE_GENERATED_BY = lit([
  "auto_admission",
  "auto_discharge",
  "sfv_trigger",
  "manual_admin",
] as const);
const WORKFLOW_ITEM_STATUS = lit([
  "upcoming",
  "open",
  "late",
  "completed",
  "expired",
  "skipped",
  "not_applicable",
  "workflow_not_initialized",
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
  regulatory: Type.Object({
    specVersionId: NullableString(),
    isc: Type.Union([
      Type.Literal("HA"),
      Type.Literal("HUV"),
      Type.Literal("HD"),
      Type.Literal("XX"),
      Type.Null(),
    ]),
  }),
  version: Type.Integer(),
});
const ANSWER_SOURCE = Type.Union([
  Type.Literal("user"),
  Type.Literal("patient_prefill"),
  Type.Literal("admission_prefill"),
  Type.Literal("derived"),
  Type.Literal("imported"),
  Type.Literal("correction_copy"),
]);
const ANSWER_STATE = Type.Union([
  Type.Literal("unanswered"),
  Type.Literal("answered"),
  Type.Literal("skipped"),
]);
const APPLICABILITY_STATE = Type.Union([
  Type.Literal("applicable"),
  Type.Literal("not_applicable"),
  Type.Literal("pending"),
]);
const SkipReasonSchema = Type.Union([
  Type.Object({
    ruleId: Type.String(),
    cmsRuleId: Type.Optional(Type.String()),
    dependsOn: Type.Array(Type.String()),
  }),
  Type.Null(),
]);
const HopeItemStateSchema = Type.Object({
  itemCode: Type.String(),
  active: Type.Boolean(),
  state: ANSWER_STATE,
  value: Type.Union([AnswerValueSchema, Type.Null()]),
  source: Type.Union([ANSWER_SOURCE, Type.Null()]),
  answeredAt: NullableString(),
  answeredByMembershipId: NullableString(),
  applicability: APPLICABILITY_STATE,
  skipReason: SkipReasonSchema,
});
const HopeWorkspaceItemSchema = Type.Composite([
  HopeItemStateSchema,
  Type.Object({
    label: Type.String(),
    section: Type.String(),
    group: NullableString(),
    kind: Type.Literal("assessment"),
    cmsItemTypeCode: Type.String(),
    maxLength: Type.Union([Type.Integer(), Type.Null()]),
    options: Type.Array(
      Type.Object({
        valueCode: Type.String(),
        label: Type.String(),
        sortOrder: Type.Integer(),
      }),
    ),
  }),
]);
export const HopeAssessmentWorkspaceResponseSchema = Type.Object({
  assessment: Type.Object({
    id: Type.String(),
    status: ASSESSMENT_STATUS,
    rfaKind: RFA_KIND,
    targetDate: Type.String(),
    isc: Type.Union([
      Type.Literal("HA"),
      Type.Literal("HUV"),
      Type.Literal("HD"),
      Type.Literal("XX"),
    ]),
    specVersionId: Type.String(),
    specVersion: Type.String(),
    version: Type.Integer(),
  }),
  sections: Type.Array(
    Type.Object({
      code: Type.String(),
      label: Type.String(),
      items: Type.Array(HopeWorkspaceItemSchema),
    }),
  ),
  progress: Type.Object({
    active: Type.Integer(),
    applicable: Type.Integer(),
    notApplicable: Type.Integer(),
    pending: Type.Integer(),
    answered: Type.Integer(),
    skipped: Type.Integer(),
    unanswered: Type.Integer(),
  }),
  huv: Type.Union([
    Type.Object({
      scheduleId: NullableString(),
      scheduleStatus: NullableString(),
      windowStart: NullableString(),
      windowEnd: NullableString(),
      lateDeadline: NullableString(),
      timingState: Type.Union([
        Type.Literal("upcoming"),
        Type.Literal("within_window"),
        Type.Literal("due_soon"),
        Type.Literal("late"),
        Type.Literal("completed"),
        Type.Literal("unknown"),
      ]),
      z0350: NullableString(),
    }),
    Type.Null(),
  ]),
});
const HopeReviewSectionSchema = Type.Object({
  code: Type.String(),
  active: Type.Integer(),
  applicable: Type.Integer(),
  answered: Type.Integer(),
  skipped: Type.Integer(),
  pending: Type.Integer(),
  unanswered: Type.Integer(),
  errors: Type.Integer(),
  warnings: Type.Integer(),
  state: Type.Union([
    Type.Literal("complete"),
    Type.Literal("needs_attention"),
    Type.Literal("blocked"),
  ]),
});
const HopeReadinessBlockerSchema = Type.Object({
  code: Type.String(),
  section: Type.Optional(Type.String()),
  itemCode: Type.Optional(Type.String()),
  ruleId: Type.Optional(Type.String()),
  message: Type.String(),
});
export const HopeAssessmentReviewResponseSchema = Type.Object({
  assessmentId: Type.String(),
  version: Type.Integer(),
  specVersion: Type.String(),
  isc: Type.Union([
    Type.Literal("HA"),
    Type.Literal("HUV"),
    Type.Literal("HD"),
    Type.Literal("XX"),
  ]),
  status: ASSESSMENT_STATUS,
  signedAt: NullableString(),
  signedByMembershipId: NullableString(),
  z0350: NullableString(),
  z0500b: NullableString(),
  sections: Type.Array(HopeReviewSectionSchema),
  progress: Type.Object({
    active: Type.Integer(),
    applicable: Type.Integer(),
    answered: Type.Integer(),
    skipped: Type.Integer(),
    pending: Type.Integer(),
    unanswered: Type.Integer(),
  }),
  validation: Type.Object({
    errorCount: Type.Integer(),
    warningCount: Type.Integer(),
    hasBlockingErrors: Type.Boolean(),
    findings: Type.Array(
      Type.Object({
        ruleId: Type.String(),
        severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
        section: Type.String(),
        itemCode: NullableString(),
        message: Type.String(),
      }),
    ),
  }),
  sfv: Type.Object({
    required: Type.Union([Type.Boolean(), Type.Null()]),
    status: Type.Optional(Type.String()),
    dueAt: Type.Optional(Type.String()),
    completedAt: Type.Optional(NullableString()),
  }),
  readiness: Type.Object({
    readyToSign: Type.Boolean(),
    blockers: Type.Array(HopeReadinessBlockerSchema),
  }),
});
export const HopeAnswerPatchResponseSchema = Type.Object({
  assessmentId: Type.String(),
  version: Type.Integer(),
  answers: Type.Array(HopeItemStateSchema),
});
export const HopeSignResponseSchema = Type.Object({
  assessmentId: Type.String(),
  status: Type.Literal("signed"),
  version: Type.Integer(),
  signedAt: Type.String(),
  signedByMembershipId: Type.String(),
  z0500b: Type.String(),
  validation: Type.Object({
    errorCount: Type.Integer(),
    warningCount: Type.Integer(),
    hasBlockingErrors: Type.Boolean(),
  }),
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
  // #91 — the SFV worklist is the queue whose reason to exist is COMPLETING the follow-up, and
  // `POST /admissions/:admissionId/hope/sfv` is keyed by admission. The column has always been on the
  // row (`symptom_follow_up_visit.admission_id`); it just never reached the wire, so the one screen
  // that must act on an SFV had no way to name the admission it belongs to.
  admissionId: Type.String(),
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
  transportMode: Type.Optional(Type.String()),
  validationProfile: Type.Optional(NullableString()),
  packageFilename: Type.Optional(NullableString()),
  packageSha256: Type.Optional(NullableString()),
  packageSizeBytes: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  itemCount: Type.Integer(),
  acceptedCount: Type.Integer(),
  rejectedCount: Type.Integer(),
  transmittedAt: NullableString(),
  exportedAt: Type.Optional(NullableString()),
  submittedAt: Type.Optional(NullableString()),
  acceptedAt: NullableString(),
  iqiesSubmissionReference: Type.Optional(NullableString()),
  /** Rejected items still awaiting a correction assessment. */
  needsCorrectionCount: Type.Integer(),
  /** Rejected items whose correction exists but is not yet in a batch. */
  correctionInProgressCount: Type.Integer(),
  /** Rejected items whose correction is in a newer batch awaiting the CMS result. */
  resubmittedCount: Type.Integer(),
});
const SUBMISSION_ITEM_STATUS = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("accepted_with_warnings"),
  Type.Literal("rejected"),
  Type.Literal("pending"),
  Type.Literal("blocked"),
  Type.Literal("unmatched"),
]);
/** One assessment inside a batch with its CMS outcome (patient NAME is not resolved by M10). */
export const HopeSubmissionItemResponseSchema = Type.Object({
  id: Type.String(),
  assessmentId: Type.String(),
  patientId: NullableString(),
  rfaKind: Type.Union([RFA_KIND, Type.Null()]),
  assessmentStatus: Type.Union([
    Type.Literal("draft"),
    Type.Literal("signed"),
    Type.Literal("superseded"),
    Type.Null(),
  ]),
  status: SUBMISSION_ITEM_STATUS,
  iqiesRecordId: NullableString(),
  processedAt: NullableString(),
  /** Rejected items only: where the correction stands (corrections supersede; originals untouched). */
  resolution: Type.Union([
    Type.Literal("needs_correction"),
    Type.Literal("correction_in_progress"),
    Type.Literal("resubmitted"),
    Type.Literal("resolved"),
    Type.Null(),
  ]),
  correctionAssessmentId: NullableString(),
});
/** One CMS finding recorded from the Final Validation Report. */
export const HopeSubmissionFindingResponseSchema = Type.Object({
  id: Type.String(),
  assessmentId: NullableString(),
  severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
  code: NullableString(),
  itemCode: NullableString(),
  message: NullableString(),
});
/** Submission detail: the batch plus its items and the recorded CMS findings. */
export const HopeSubmissionDetailResponseSchema = Type.Composite([
  HopeSubmissionResponseSchema,
  Type.Object({
    resultImportedAt: NullableString(),
    resultReportReference: NullableString(),
    items: Type.Array(HopeSubmissionItemResponseSchema),
    findings: Type.Array(HopeSubmissionFindingResponseSchema),
  }),
]);
/** Reverse lookup: the batches holding one assessment. */
export const HopeAssessmentSubmissionsResponseSchema = Type.Object({
  submissions: Type.Array(
    Type.Object({
      submissionId: Type.String(),
      status: SUBMISSION_STATUS,
      itemStatus: SUBMISSION_ITEM_STATUS,
      packageFilename: NullableString(),
      submittedAt: NullableString(),
      resultImportedAt: NullableString(),
    }),
  ),
});
/**
 * F-058 (#150) — what one force-assemble pass did.
 *
 * The route used to answer with a single {@link HopeSubmissionResponseSchema}, because it always created
 * exactly one batch: an EMPTY one, with no `hope_submission_item` rows behind it. A real pass groups the
 * provider entity's eligible signed assessments by CMS submission period, so it yields one batch per
 * period and may legitimately yield none — and the three counts are what let the caller tell "nothing
 * to do" apart from "nothing happened".
 */
export const HopeAssembleResponseSchema = Type.Object({
  submissions: Type.Array(HopeSubmissionResponseSchema),
  assessmentsConsidered: Type.Integer(),
  /** Already on a `pending` item — the §4.10 idempotency skip, so a second press is legible. */
  skippedAlreadyBatched: Type.Integer(),
  /** No `provider_entity_id`, so no CCN to batch under. Never silent. */
  skippedUnsited: Type.Integer(),
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
const HopeWorkflowTimepointResponseSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("01_admission"),
    Type.Literal("02_huv1"),
    Type.Literal("03_huv2"),
    Type.Literal("05_discharge"),
  ]),
  status: WORKFLOW_ITEM_STATUS,
  scheduleId: NullableString(),
  windowStart: NullableString(),
  windowEnd: NullableString(),
  lateDeadline: NullableString(),
  completedAt: NullableString(),
  assessmentId: NullableString(),
  attention: Type.Object({
    state: Type.Union([
      Type.Literal("none"),
      Type.Literal("upcoming"),
      Type.Literal("due_soon"),
      Type.Literal("due"),
      Type.Literal("overdue"),
      Type.Literal("window_expired"),
      Type.Literal("missed"),
      Type.Literal("workflow_issue"),
    ]),
    severity: Type.Union([
      Type.Literal("none"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("critical"),
    ]),
    action: Type.Union([
      Type.Literal("COMPLETE_ADMISSION_RFA"),
      Type.Literal("COMPLETE_HUV1"),
      Type.Literal("COMPLETE_HUV2"),
      Type.Literal("COMPLETE_DISCHARGE_RFA"),
      Type.Literal("OPEN_SFV"),
      Type.Literal("REPAIR_WORKFLOW"),
      Type.Literal("NONE"),
    ]),
    message: NullableString(),
    deadline: NullableString(),
  }),
});
const HopeWorkflowSfvResponseSchema = Type.Object({
  id: Type.String(),
  status: SFV_STATUS,
  triggeringAssessmentId: Type.String(),
  triggeringRfaKind: Type.Union([RFA_KIND, Type.Null()]),
  dueAt: Type.String(),
  triggeredAt: Type.String(),
  completedAt: NullableString(),
  completingAssessmentId: NullableString(),
  attention: Type.Object({
    state: Type.Union([
      Type.Literal("none"),
      Type.Literal("upcoming"),
      Type.Literal("due_soon"),
      Type.Literal("due"),
      Type.Literal("overdue"),
      Type.Literal("window_expired"),
      Type.Literal("missed"),
      Type.Literal("workflow_issue"),
    ]),
    severity: Type.Union([
      Type.Literal("none"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("critical"),
    ]),
    action: Type.Union([
      Type.Literal("COMPLETE_ADMISSION_RFA"),
      Type.Literal("COMPLETE_HUV1"),
      Type.Literal("COMPLETE_HUV2"),
      Type.Literal("COMPLETE_DISCHARGE_RFA"),
      Type.Literal("OPEN_SFV"),
      Type.Literal("REPAIR_WORKFLOW"),
      Type.Literal("NONE"),
    ]),
    message: NullableString(),
    deadline: NullableString(),
  }),
});
export const HopeWorkflowStateResponseSchema = Type.Object({
  admissionId: Type.String(),
  patientId: NullableString(),
  admissionStatus: NullableString(),
  admissionAt: NullableString(),
  activatedAt: NullableString(),
  dischargedAt: NullableString(),
  admissionAssessment: HopeWorkflowTimepointResponseSchema,
  huv1: HopeWorkflowTimepointResponseSchema,
  huv2: HopeWorkflowTimepointResponseSchema,
  sfvs: Type.Array(HopeWorkflowSfvResponseSchema),
  dischargeAssessment: HopeWorkflowTimepointResponseSchema,
  summary: Type.Object({
    actionableCount: Type.Integer(),
    overdueCount: Type.Integer(),
    completedCount: Type.Integer(),
    nextDeadline: NullableString(),
    highestSeverity: Type.Union([
      Type.Literal("none"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("critical"),
    ]),
    dueSoonCount: Type.Integer(),
    workflowIssueCount: Type.Integer(),
  }),
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
  mode: Type.Union([Type.Literal("draft"), Type.Literal("final")]),
  evaluatedAt: Type.String(),
  findings: Type.Array(
    Type.Object({
      ruleId: Type.String(),
      severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
      findingKind: NullableString(),
      section: Type.String(),
      itemCode: NullableString(),
      message: Type.String(),
      details: Type.Record(Type.String(), Type.Unknown()),
      fingerprint: NullableString(),
      evaluatedAt: Type.String(),
      resolved: Type.Boolean(),
      resolvedAt: NullableString(),
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
type _Workspace = Conforms<
  Static<typeof HopeAssessmentWorkspaceResponseSchema>,
  ServiceAssessmentWorkspace
>;
type _Review = Conforms<Static<typeof HopeAssessmentReviewResponseSchema>, ServiceReviewReadModel>;
type _AnswerPatch = Conforms<
  Static<typeof HopeAnswerPatchResponseSchema>,
  ServiceAnswerPatchResult
>;
type _Sign = Conforms<Static<typeof HopeSignResponseSchema>, ServiceSignResult>;
type _Schedule = Conforms<Static<typeof HopeScheduleResponseSchema>, ServiceScheduleView>;
type _Sfv = Conforms<Static<typeof HopeSfvResponseSchema>, ServiceSfvView>;
type _Submission = Conforms<Static<typeof HopeSubmissionResponseSchema>, ServiceSubmissionView>;
type _Compliance = Conforms<Static<typeof HopeComplianceResponseSchema>, ServiceComplianceView>;
type _WorkflowState = Conforms<
  Static<typeof HopeWorkflowStateResponseSchema>,
  ServiceWorkflowStateView
>;
type _Validation = Conforms<Static<typeof HopeValidationResponseSchema>, ServiceValidationRunView>;
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
