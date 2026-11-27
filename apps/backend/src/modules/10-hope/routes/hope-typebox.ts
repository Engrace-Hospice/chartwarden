// apps/backend/src/modules/10-hope/routes/hope-typebox.ts — M10-T06 TypeBox route schemas (§4.1 / §4.3).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox
// import for a Drizzle one. Validation runs through TypeBox `Value` → M1's VALIDATION_FAILED envelope.
//
// The full §4.3 per-RFA discriminated union (with every Section A–Z schema) lands with the per-section
// modules; this T06 boundary captures the recording envelope plus Section J's J2051 entries — the field
// the server-authoritative `evaluateJ2051Trigger` (D4) reads at sign — so the trigger/ SFV flow is wired
// end-to-end. The server IGNORES any client-sent trigger flag (D4); the `data` object is otherwise carried
// opaquely and narrowed by the per-section validators server-side.
import "@chartwarden/shared/route-kit";
import {
  HOPE_J2051_SYMPTOM_CODES,
  HOPE_RFA_KINDS,
  HOPE_SCHEDULE_SKIP_REASON_CODES,
  HOPE_SUBMISSION_CANCEL_REASON_CODES,
} from "@chartwarden/types";
import { ValidationError } from "@chartwarden/types";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { ValueErrorType } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

/** The canonical RFA-kind union, mirrored from @chartwarden/types `HOPE_RFA_KINDS` (single source). */
const RFA_KIND = lit(HOPE_RFA_KINDS);
/** The §4.3 HOPE author disciplines accepted at the route boundary (the ABAC predicate is authoritative). */
const AUTHOR_DISCIPLINE = Type.Union([Type.Literal("RN"), Type.Literal("NP"), Type.Literal("MD")]);
/** SFV (RFA-04) authors additionally allow LPN/LVN (CMS HOPE Guidance Manual v1.03); MD stays accepted at
 *  the boundary so it is refused by the ABAC predicate (403), as before. */
const SFV_AUTHOR_DISCIPLINE = lit(["RN", "NP", "MD", "LPN", "LVN"] as const);
// The same five members as SFV_AUTHOR_DISCIPLINE, with the description the correction routes document.
const AMENDMENT_AUTHOR_DISCIPLINE = Type.Union(SFV_AUTHOR_DISCIPLINE.anyOf, {
  description:
    "RN, NP, or MD for non-SFV assessments; LPN and LVN are accepted only when correcting or inactivating an RFA-04 SFV. The server verifies the stored RFA and the actor's own discipline.",
});
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
/**
 * The reason is one of a fixed code list (no free text, so no PHI rides along into `skip_reason_code` or the audit before/after),
 * and there is no `note`: nothing kept it, so a body that carries one is refused rather than accepted and silently dropped.
 */
export const SkipScheduleSchema = Type.Object(
  {
    reasonCode: lit(HOPE_SCHEDULE_SKIP_REASON_CODES),
  },
  { additionalProperties: false },
);
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
  // A uuid on the wire: `symptom_follow_up_visit.triggering_assessment_id` is a uuid column, so a
  // non-uuid used to reach the cast and surface as a 500 instead of a 422.
  triggeringAssessmentId: Type.String({ format: "uuid" }),
  targetDate: Type.String({ format: "date-time" }),
  authorDiscipline: SFV_AUTHOR_DISCIPLINE,
  adminOverride: Type.Optional(Type.Boolean()),
  adminOverrideJustification: Type.Optional(Type.String({ minLength: 20, maxLength: 1000 })),
  // R-05: completing an SFV inserts an already-SIGNED RFA-04, so it carries the sign attestation.
  attestationConfirmed: Type.Literal(true),
  // The wording version the signer was shown; optional, and refused (409 M10_ATTESTATION_STALE) when it is not current.
  attestationVersion: Type.Optional(Type.String({ maxLength: 32 })),
  data: HopeData,
});
export const UpdateDraftSchema = Type.Object({ data: HopeData });
// A string answer is at most 18 characters in the HOPE v1.00.1 spec (A0500C, the longest assessment text item; dates are
// 10, codes fewer), and no non-filler field of the CMS record layout exceeds 50 (the vendor e-mail). 64 leaves headroom
// for a later spec without letting a request body (bounded only by the 10 MB body limit) become the value of an answer.
// Per-item lengths are still enforced by the answer engine (`fixedRecordLength`).
const ANSWER_VALUE_MAX_LENGTH = 64;
const AnswerValueSchema = Type.Union([
  Type.String({ maxLength: ANSWER_VALUE_MAX_LENGTH }),
  Type.Number(),
  Type.Boolean(),
]);
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
  // R-05: REQUIRED. Optional meant the field was accepted and never read, so `{ ifVersion }` signed.
  attestationConfirmed: Type.Literal(true),
  // The wording version the signer was shown; optional, and refused (409 M10_ATTESTATION_STALE) when it is not current.
  attestationVersion: Type.Optional(Type.String({ maxLength: 32 })),
});
export const SetHuvCompletionDateSchema = Type.Object({
  ifVersion: Type.Integer({ minimum: 1 }),
  z0350: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
});
export const CorrectTimepointSchema = Type.Object({
  correctionReason: Type.String({ minLength: 1, maxLength: 2000 }),
  ifVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  targetDate: Type.String({ format: "date-time" }),
  authorDiscipline: AMENDMENT_AUTHOR_DISCIPLINE,
  data: HopeData,
});
export const InactivateTimepointSchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  ifVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  authorDiscipline: AMENDMENT_AUTHOR_DISCIPLINE,
});
export const SummaryPdfSchema = Type.Object({});
export const RetrySubmissionSchema = Type.Object({});
export const AssembleSubmissionSchema = Type.Object({
  // A uuid on the wire: assembling reads `provider_entity_id` (a uuid column), so a value that is none used to reach the
  // cast and answer a 500 instead of a 422. The two list/dashboard query filters stay free text: the service answers
  // "matches nothing" for a non-uuid there, so a mistyped filter is an empty read, not an error.
  providerEntityId: Type.String({ format: "uuid" }),
});
/** R-08 — the reason is one of a fixed code list: no free text, so no PHI can ride along. */
export const CancelSubmissionSchema = Type.Object(
  {
    reasonCode: lit(HOPE_SUBMISSION_CANCEL_REASON_CODES),
  },
  { additionalProperties: false },
);
/**
 * The characters an operator-typed submission reference or CMS result token may hold (an iQIES upload id, a CMS report reference,
 * an edit code): letters, digits and ` . _ : # / -`, the FIRST of them never a space (a whitespace-only value is no value), so
 * markup, control characters and quotes never reach a stored row or an audit image. The schema does not echo the value in its
 * 422. A patient identifier shaped from these characters is refused by the route AND the service (hope-reference-screen.ts).
 * The web client's copy (apps/web hope-report-reference.ts) must use the same pattern and limits.
 */
export const HOPE_TOKEN_PATTERN = "^[A-Za-z0-9._:#/-][A-Za-z0-9 ._:#/-]*$";
/** A submission reference (`reportReference`, `iqiesSubmissionReference`): at most this many characters. */
export const HOPE_REFERENCE_MAX_LENGTH = 128;
/** One CMS result-row token (`status`, `result`, `outcome`, `severity`, `code`, `itemCode`, `iqiesRecordId`): at most this many. */
export const HOPE_RESULT_TOKEN_MAX_LENGTH = 64;
const referenceString = () =>
  Type.Union([
    Type.String({
      minLength: 1,
      maxLength: HOPE_REFERENCE_MAX_LENGTH,
      pattern: HOPE_TOKEN_PATTERN,
    }),
    Type.Null(),
  ]);
export const MarkSubmissionUploadedSchema = Type.Object({
  submittedAt: Type.Optional(Type.String({ format: "date-time" })),
  iqiesSubmissionReference: Type.Optional(referenceString()),
});
/**
 * A CMS edit code, an item code or an iQIES record id (`code`, `itemCode`, `iqiesRecordId`) is ONE word: letters, digits and
 * `. _ : # -` (a leading `-` is allowed, CMS edit codes look like `-3015`), NO space and NO slash, or EMPTY (a blank cell of a
 * pasted report names nothing, as an absent key does: a blank `iqiesRecordId` is never stored). These land unscrubbed in the
 * audit images of the result event, the item and the assessment and in the `m10.hope.submission_rejected` payload (`ruleId`), so a
 * phrase, a name with spaces or a `MM/DD/YYYY` date cannot be written at all; a date or phone shape that still fits is refused by
 * the screen (hope-reference-screen.ts), whatever separator of `. _ : # -` sets the groups apart. RESIDUAL, not closeable here: a
 * single-word surname or a hyphenated name passes the charset, a compact date or number (`19900517`, `5558675309`, `05-17-90`) is
 * no shape the screen can tell from a code, and the real iQIES edit-code and record-id formats are unverified, so this stays
 * permissive within the rule; a human should confirm the formats against a CMS sample and tighten it. The web client's copy must
 * use the same pattern.
 */
export const HOPE_RESULT_CODE_PATTERN = "^(?:[A-Za-z0-9._:#-]{1,64})?$";
/**
 * The status text of a row (`status`, `result`, `outcome`) is a phrase CMS wrote ("received, pending review", "Accepted (2
 * warnings)"), classified by words (`classifyStatusText`): the reference charset plus `, ; ( )` after the first character. It is
 * kept only in the scrubbed raw-result columns, never in a column the audit trail copies, and the identifier screen still reads it.
 */
export const HOPE_RESULT_STATUS_PATTERN = "^(?:[A-Za-z0-9._:#/-][A-Za-z0-9 ._:#/(),;-]*)?$";
/**
 * A report row's `assessmentId` is an assessment id, so it may hold only what a uuid is spelt with (Postgres reads hex digits,
 * hyphens and one pair of braces; `canonicalUuidOrNull`), padded with whitespace a pasted CSV cell carries (it is trimmed before it
 * is read): 1 to 64 characters. Text outside a uuid's characters is refused, so a name cannot be written into the stored report
 * or echoed by the read API. A hex-only word ("Ada", "Dee Cafe") does fit the charset and can still be stored in the raw report;
 * a value that is no uuid is stored as an unmatched row and never returned by a read.
 */
export const HOPE_RESULT_ASSESSMENT_ID_PATTERN = "^[\\s{}0-9A-Fa-f-]{1,64}$";
/** The most rows one result import takes, and the longest `message` of a row. */
export const HOPE_RESULT_MAX_ROWS = 2000;
export const HOPE_RESULT_MESSAGE_MAX_LENGTH = 1000;
/**
 * The severities a report row may carry: exactly the values the import acts on (`classifyCmsResult` rejects on `fatal` and
 * `error`, reads `warning` as accepted with warnings; `findingSeverity` maps the same), compared case-insensitively, or empty.
 * The pattern is spelled out (a JSON-schema pattern has no case flag); a unit test pins it to the list.
 */
export const HOPE_RESULT_SEVERITIES = ["fatal", "error", "warning"] as const;
export const HOPE_RESULT_SEVERITY_PATTERN =
  "^(?:[Ff][Aa][Tt][Aa][Ll]|[Ee][Rr][Rr][Oo][Rr]|[Ww][Aa][Rr][Nn][Ii][Nn][Gg])?$";
const resultString = (pattern: string) =>
  Type.Optional(Type.String({ maxLength: HOPE_RESULT_TOKEN_MAX_LENGTH, pattern }));
const resultCode = () => resultString(HOPE_RESULT_CODE_PATTERN);
const resultStatusText = () => resultString(HOPE_RESULT_STATUS_PATTERN);
const resultSeverity = () => resultString(HOPE_RESULT_SEVERITY_PATTERN);
export const ImportSubmissionResultSchema = Type.Object({
  reportReference: Type.Optional(referenceString()),
  // Bounded: every row is stored (report, item result, finding), so an unbounded body is a write amplifier.
  results: Type.Array(
    Type.Object(
      {
        assessmentId: Type.Optional(
          Type.String({ minLength: 1, maxLength: 64, pattern: HOPE_RESULT_ASSESSMENT_ID_PATTERN }),
        ),
        status: resultStatusText(),
        result: resultStatusText(),
        outcome: resultStatusText(),
        severity: resultSeverity(),
        code: resultCode(),
        itemCode: resultCode(),
        message: Type.Optional(Type.String({ maxLength: HOPE_RESULT_MESSAGE_MAX_LENGTH })),
        iqiesRecordId: resultCode(),
      },
      { additionalProperties: false },
    ),
    { maxItems: HOPE_RESULT_MAX_ROWS },
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
  // The SFV that one assessment triggered (the capture workspace asks for exactly that one); an unknown id is an
  // empty list. A uuid on the wire: the column is one.
  triggeringAssessmentId: Type.Optional(Type.String({ format: "uuid" })),
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
// read views 1:1 and are pinned to them by the compile-time `Conforms` aliases in `hope-typebox-conformance.ts`, so a view field added
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
  "cancelled",
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
  /** R-08 — set only on a package cancelled before upload; the reason is a fixed code, never free text. */
  cancelledAt: Type.Optional(NullableString()),
  cancelReasonCode: Type.Optional(
    Type.Union([lit(HOPE_SUBMISSION_CANCEL_REASON_CODES), Type.Null()]),
  ),
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
  Type.Literal("cancelled"),
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
/** Route 20 — the admin regenerate result: the admission's schedule count AFTER the missing windows were created. */
export const HopeRegenerateResponseSchema = Type.Object({
  admissionId: Type.String(),
  scheduleCount: Type.Integer(),
});

/**
 * CW-AC-46 — an organization's enforcement mode for the signer-licence check. `reason` is required for `shadow` (20-200 characters,
 * judged by the service so the 422 names the bound) and refused for `enforce`; the schema only bounds the size of what is read.
 */
const SignerLicenceModeSchema = Type.Union([Type.Literal("enforce"), Type.Literal("shadow")]);
export const PutSignerLicencePolicySchema = Type.Object(
  {
    mode: SignerLicenceModeSchema,
    // `null` is accepted as "none" (it is what the GET answers for an organization that enforces): the service judges the rest.
    reason: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
  },
  { additionalProperties: false },
);
/** Routes 21/22 — the effective policy (`enforce` for an organization that never set one: `configuredAt` null). */
export const HopeSignerLicencePolicyResponseSchema = Type.Object({
  mode: SignerLicenceModeSchema,
  reason: NullableString(),
  configuredAt: NullableString(),
});

/**
 * Parse `raw` through `schema` → typed value, or throw M1's VALIDATION_FAILED envelope. For an `additionalProperties: false`
 * schema the error's path IS the property name the client chose, which would be echoed into the 422 (and cached by the
 * idempotency layer for 24 h): an unexpected property is reported as the static `(unexpected property)`, never by name.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    // The FIRST error only: spreading the iterator builds one error object per offending element, which for an oversized array in a
    // request body is millions of them (hundreds of milliseconds and hundreds of megabytes on the shared event loop).
    const first = Value.Errors(schema, converted).First();
    const field =
      first?.type === ValueErrorType.ObjectAdditionalProperties
        ? "(unexpected property)"
        : first
          ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)"
          : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
