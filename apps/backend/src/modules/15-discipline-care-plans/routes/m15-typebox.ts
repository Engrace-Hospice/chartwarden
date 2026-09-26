// apps/backend/src/modules/15-discipline-care-plans/routes/m15-typebox.ts — M15 (§4.2) request schemas.
//
// TypeBox request bodies, path params and list queries for the §4.1 Discipline Care Plans routes. The
// OpenAPI enrichment registry layers these onto the auto-discovered routes so the generated client types
// the surface the M15-T07 web screens call (the M24 `m24-typebox` / M26 `m26-typebox` precedent). Named
// `m15-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one.
//
// The string-literal unions MIRROR the frozen `@wardenx/db` pgEnum value lists (packages/db/src/enums.ts,
// M15-T01) — the schema wins on conflict. Org / actor / membership binding is server-side
// (`request.context`): no body or query carries an org id or an acting membership id, which is the §8.6
// (S) spoofing control at the boundary.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type { CursorPage } from "./concurrency";
import type { RedactedCategory } from "./disclosure";
import type {
  AideSupervisoryVisitView,
  DisciplineAssessmentView,
  DisciplineGoalView,
  DisciplineInterventionView,
  DisciplinePlanDetail,
  DisciplinePlanListItem,
  DisciplinePlanSummary,
  DisciplinePlanVersionDetail,
  DisciplinePlanVersionListItem,
  RelevantElementsView,
  SupervisoryCadenceRowView,
  VolunteerAssignmentView,
  VolunteerComplianceGateView,
  VolunteerEffectiveStatusView,
} from "./read-service";
import type { VolunteerHourEntryView } from "./write-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

function check<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return value as Static<T>;
}

/**
 * Validate a request BODY at the route boundary — a malformed request is rejected BEFORE it reaches a
 * service. Deliberately does NOT run `Value.Convert`: a JSON body already carries real types, and coercing
 * would silently repair genuinely wrong input (`durationMinutes: 30.5` would truncate to 30, turning a
 * client bug into a ledger bug). Queries are the only place coercion is legitimate — use `parseQuery`.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}

/** Validate a request QUERY, converting the declared scalars first (`?limit=25` arrives as "25"). */
export function parseQuery<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, Value.Convert(schema, raw ?? {}));
}

const Uuid = Type.String({ format: "uuid" });
const UuidN = Type.Union([Type.String({ format: "uuid" }), Type.Null()]);
const Instant = Type.String({ format: "date-time" });
const InstantN = Type.Union([Type.String({ format: "date-time" }), Type.Null()]);

/** `discipline_plan_kind` (§3.2). */
export const PlanKind = Type.Union([
  Type.Literal("aide_poc"),
  Type.Literal("msw_plan"),
  Type.Literal("spiritual_plan"),
  Type.Literal("volunteer_plan"),
]);

/** `discipline_goal_source` (§3.2). */
export const GoalSource = Type.Union([
  Type.Literal("clinician_authored"),
  Type.Literal("patient_stated"),
  Type.Literal("family_stated"),
  Type.Literal("agent_stated"),
  Type.Literal("idg_directed"),
]);

/** `volunteer_gate_kind` (§3.2 / §4.2). */
export const GateKind = Type.Union([
  Type.Literal("background_check"),
  Type.Literal("tb_screening"),
  Type.Literal("confidentiality_agreement"),
  Type.Literal("initial_training"),
  Type.Literal("annual_ce"),
  Type.Literal("assignment_specific_training"),
  Type.Literal("vaccination_status"),
]);

/** `aide_supervisory_attestation_mode` (§3.2 / §4.2). */
export const AttestationMode = Type.Union([
  Type.Literal("aide_present"),
  Type.Literal("observation_of_work"),
]);

// ── path params ─────────────────────────────────────────────────────────────────────────────────────

export const PlanParams = Type.Object({ planId: Uuid });
export const VersionParams = Type.Object({ planId: Uuid, versionId: Uuid });
export const GoalParams = Type.Object({ planId: Uuid, goalId: Uuid });
export const InterventionParams = Type.Object({ planId: Uuid, interventionId: Uuid });
export const AssessmentParams = Type.Object({ planId: Uuid, assessmentId: Uuid });
export const SupervisoryVisitParams = Type.Object({ planId: Uuid, visitId: Uuid });
export const AssignmentParams = Type.Object({ planId: Uuid, assignmentId: Uuid });
export const GateParams = Type.Object({ gateId: Uuid });

// ── list queries (§4.6.1 cursor pagination; `offset` is refused by the preHandler) ──────────────────

export const PlanListQuerySchema = Type.Object({
  patientId: Type.Optional(Uuid),
  admissionId: Type.Optional(Uuid),
  kind: Type.Optional(PlanKind),
  status: Type.Optional(Type.String({ maxLength: 32 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const VersionListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const GateListQuerySchema = Type.Object({
  volunteerMembershipId: Type.Optional(Uuid),
  gateKind: Type.Optional(GateKind),
  expiringWithinDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const HourRatioQuerySchema = Type.Object({
  providerEntityId: Uuid,
  fiscalYear: Type.Integer({ minimum: 2000, maximum: 2200 }),
});

export const RelevantElementsQuerySchema = Type.Object({
  patientId: Type.Optional(Uuid),
  planId: Type.Optional(Uuid),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const RiskFactorQuerySchema = Type.Object({
  admissionId: Uuid,
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const VolunteerStatusQuerySchema = Type.Object({ volunteerMembershipId: Uuid });

export const SupervisoryCadenceQuerySchema = Type.Object({
  providerEntityId: Type.Optional(Uuid),
  locationId: Type.Optional(Uuid),
  overdueOnly: Type.Optional(Type.Boolean()),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

// ── request bodies (§4.2) ───────────────────────────────────────────────────────────────────────────

/** Route 6 — the tenant may TIGHTEN the D11 quorum; the pure resolver refuses a loosening set. */
export const FinalizeVersionBody = Type.Object({
  requiredSignerSet: Type.Optional(
    Type.Array(
      Type.Object({
        role: Type.String({ minLength: 1, maxLength: 64 }),
        count: Type.Integer({ minimum: 1, maximum: 8 }),
        isAcknowledgment: Type.Boolean(),
      }),
      { maxItems: 8 },
    ),
  ),
});

/** Route 7 — one signature against the SEALED set. The signer MEMBERSHIP is server-side, never here. */
export const SignVersionBody = Type.Object({
  signerRole: Type.String({ minLength: 1, maxLength: 64 }),
  attestationText: Type.String({ minLength: 10, maxLength: 4000 }),
  isAcknowledgment: Type.Optional(Type.Boolean()),
});

/** Route 8 (§2.1 / §2.3). */
export const CreateGoalBody = Type.Object({
  parentProblemId: Uuid,
  parentGoalId: Type.Optional(UuidN),
  source: GoalSource,
  originalText: Type.String({ minLength: 1, maxLength: 4000 }),
  measurableOutcome: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
  targetAt: Type.Optional(InstantN),
  frequencyText: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  frequencyValue: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  modalityText: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  sudRelated: Type.Optional(Type.Boolean()),
  actingConsentId: Type.Optional(UuidN),
  addedByDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
});

/** Route 9 — a status event and/or the editable refinement fields (`original_text` is never here). */
export const UpdateGoalBody = Type.Object({
  event: Type.Optional(
    Type.Object({
      type: Type.Union([
        Type.Literal("start"),
        Type.Literal("meet"),
        Type.Literal("missTarget"),
        Type.Literal("revise"),
        Type.Literal("discontinue"),
      ]),
      revisedText: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    }),
  ),
  measurableOutcome: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
  targetAt: Type.Optional(InstantN),
  frequencyText: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  frequencyValue: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
  modalityText: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
});

/** Route 10. */
export const CreateInterventionBody = Type.Object({
  parentInterventionId: Type.Optional(UuidN),
  goalRefs: Type.Optional(Type.Array(Uuid, { maxItems: 64 })),
  scopeText: Type.String({ minLength: 1, maxLength: 4000 }),
  frequencyText: Type.String({ minLength: 1, maxLength: 500 }),
  frequencyValue: Type.String({ minLength: 1, maxLength: 64 }),
  discipline: Type.String({ minLength: 1, maxLength: 64 }),
  responsibleRoles: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
  addedByDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
});

/** Route 11. */
export const UpdateInterventionBody = Type.Object({
  event: Type.Optional(
    Type.Object({
      type: Type.Union([Type.Literal("discontinue"), Type.Literal("complete")]),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    }),
  ),
  scopeText: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  frequencyText: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  frequencyValue: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  responsibleRoles: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
});

/** Route 12 — the per-kind `data` payload is validated against the §3.4 TypeBox inside the domain. */
export const CreateAssessmentBody = Type.Object({
  kind: Type.String({ minLength: 1, maxLength: 64 }),
  capturedAt: Instant,
  isInitial: Type.Optional(Type.Boolean()),
  sudFlag: Type.Optional(Type.Boolean()),
  familyViolenceFlag: Type.Optional(Type.Boolean()),
  sourceEncounterId: Type.Optional(UuidN),
  data: Type.Unknown(),
});

/** Route 13 — signing carries no body beyond the `If-Match` version (step-up is a session fact). */
// Route 13 (sign) carries NO request body: the signature is the act, and the actor, timestamp and
// expected version all come from the session, the server clock and If-Match. It used to `parse` an
// empty `Type.Object({})` here, which validated nothing and made the route read as payload-bearing
// to every reader and to the published contract (#94).

/** Route 14 — append-only correction of record (M9 D9). */
export const AmendAssessmentBody = Type.Object({
  amendmentReason: Type.String({ minLength: 1, maxLength: 2000 }),
  data: Type.Unknown(),
  amendedFields: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 64 })),
});

/** Route 15 — the §4.2 representative body, verbatim from the spec. */
export const CreateSupervisoryVisitBody = Type.Object({
  aideMembershipId: Uuid,
  supervisingRnMembershipId: Uuid,
  sourceEncounterId: UuidN,
  supervisoryAt: Instant,
  attestationMode: AttestationMode,
  aidePerformanceSatisfactory: Type.Boolean(),
  correctiveActions: Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
  supervisoryNarrative: Type.String({ minLength: 40, maxLength: 8000 }),
});

/** Route 16. */
// Route 4 (aide-supervisory sign) carries NO request body, for the same reason as the assessment
// sign above — the empty-object parse it used to perform validated nothing.

/** Route 17 — the §8.6 documented override rides here; the pure guard enforces the ≥40-char floor. */
export const CreateVolunteerAssignmentBody = Type.Object({
  volunteerMembershipId: Uuid,
  activities: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    minItems: 1,
    maxItems: 32,
  }),
  startsAt: Instant,
  endsAt: Type.Optional(InstantN),
  overrideReason: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
});

/** Route 18. */
export const UpdateVolunteerAssignmentBody = Type.Object({
  activities: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32 }),
  ),
  endsAt: Type.Optional(InstantN),
  coordinatorAcknowledged: Type.Optional(Type.Boolean()),
  inactivate: Type.Optional(
    Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
  ),
  reactivate: Type.Optional(Type.Boolean()),
});

/** Route 20 — the §4.2 representative body, verbatim from the spec. */
export const CreateVolunteerGateBody = Type.Object({
  volunteerMembershipId: Uuid,
  gateKind: GateKind,
  validFrom: Instant,
  validUntil: InstantN,
  sourceDocumentId: Type.Optional(UuidN),
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
});

/** Route 21. */
export const UpdateVolunteerGateBody = Type.Object({
  validUntil: Type.Optional(InstantN),
  sourceDocumentId: Type.Optional(UuidN),
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
});

/** Route 22. */
export const RevokeVolunteerGateBody = Type.Object({
  revokedReason: Type.String({ minLength: 1, maxLength: 2000 }),
});

/** Route 24 — a manual 418.78(e) hour adjustment (negative minutes are legal ONLY on this path). */
export const CreateHourEntryBody = Type.Object({
  providerEntityId: Uuid,
  fiscalYear: Type.Integer({ minimum: 2000, maximum: 2200 }),
  volunteerMembershipId: Uuid,
  durationMinutes: Type.Integer({ minimum: -100_000, maximum: 100_000 }),
  occurredAt: Instant,
  adjustmentReason: Type.String({ minLength: 1, maxLength: 2000 }),
});

// ── §4.2 RESPONSE DTOs (F0 enrichment) ────────────────────────────────────────────────────────────────
// The §4.1 read + mutation routes returned typed service views (`DisciplinePlanDetail`, `CursorPage<…>`,
// the write views) but published NO response contract, so the generated client typed every body as `never`.
// These schemas mirror the `read-service` / `write-service` views 1:1 and are pinned to them by the
// compile-time `Conforms` aliases below — a view field added or renamed breaks `bun run build` rather than
// silently drifting from the client. Enum-shaped columns reuse the request unions above (the service typed
// them as broad `string`, so a literal union is still assignable); `unknown` payloads stay `Type.Unknown()`.
const Str = Type.String();
const StrN = Type.Union([Type.String(), Type.Null()]);
const Int = Type.Integer();

/** §4.6.1 keyset envelope — `{ data, next_cursor, has_more, total_count? }`. */
const cursorPage = <T extends TSchema>(item: T) =>
  Type.Object({
    data: Type.Array(item),
    next_cursor: StrN,
    has_more: Type.Boolean(),
    total_count: Type.Optional(Int),
  });

const RedactedCategorySchema = Type.Union([Type.Literal("sud"), Type.Literal("family_violence")]);

/** Route 1 — a plan as the worklist sees it. */
export const DisciplinePlanListItemResponseSchema = Type.Object({
  planId: Str,
  patientId: Str,
  admissionId: Str,
  providerEntityId: Str,
  locationId: Str,
  kind: PlanKind,
  status: Str,
  nextSupervisoryDueAt: StrN,
  initialAssessmentClockStartedAt: StrN,
  initialAssessmentSignedAt: StrN,
  spiritualCareDeclinedAt: StrN,
  updatedAt: Str,
  version: Int,
});

/** A `discipline_goal` row on the full-plan read. */
export const DisciplineGoalViewResponseSchema = Type.Object({
  goalId: Str,
  parentProblemId: StrN,
  parentGoalId: StrN,
  source: GoalSource,
  status: Str,
  originalText: Str,
  revisedText: StrN,
  measurableOutcome: StrN,
  targetAt: StrN,
  frequencyText: StrN,
  frequencyValue: StrN,
  modalityText: StrN,
  sudRelated: Type.Boolean(),
  addedByDiscipline: Str,
  addedAt: Str,
  version: Int,
});

/** A `discipline_intervention` row on the full-plan read. */
export const DisciplineInterventionViewResponseSchema = Type.Object({
  interventionId: Str,
  parentInterventionId: StrN,
  goalRefs: Type.Array(Str),
  scopeText: Str,
  frequencyText: Str,
  frequencyValue: Str,
  discipline: Str,
  responsibleRoles: Type.Array(Str),
  status: Str,
  discontinuationReason: StrN,
  addedByDiscipline: Str,
  addedAt: Str,
  version: Int,
});

/** A `discipline_assessment` row. */
export const DisciplineAssessmentViewResponseSchema = Type.Object({
  assessmentId: Str,
  kind: Str,
  status: Str,
  capturedAt: Str,
  isInitial: Type.Boolean(),
  sudFlag: Type.Boolean(),
  familyViolenceFlag: Type.Boolean(),
  sourceEncounterId: StrN,
  data: Type.Unknown(),
  amendsAssessmentId: StrN,
  amendmentReason: StrN,
  capturedByMembershipId: Str,
  signedAt: StrN,
  signedByMembershipId: StrN,
  version: Int,
});

/** An `aide_supervisory_visit` row (§2.2.4). */
export const AideSupervisoryVisitViewResponseSchema = Type.Object({
  supervisoryVisitId: Str,
  aideMembershipId: Str,
  supervisingRnMembershipId: Str,
  sourceEncounterId: StrN,
  supervisoryAt: Str,
  attestationMode: AttestationMode,
  aidePerformanceSatisfactory: Type.Boolean(),
  correctiveActions: StrN,
  supervisoryNarrative: Str,
  nextDueAt: Str,
  cadenceDaysAtInsert: Int,
  signedAt: StrN,
  version: Int,
});

/** A `volunteer_assignment` row (§2.2.5). */
export const VolunteerAssignmentViewResponseSchema = Type.Object({
  assignmentId: Str,
  volunteerMembershipId: Str,
  coordinatorMembershipId: Str,
  activities: Type.Array(Str),
  startsAt: Str,
  endsAt: StrN,
  coordinatorAcknowledgedAt: StrN,
  inactivatedAt: StrN,
  inactivationReason: StrN,
  version: Int,
});

/** A `discipline_care_plan_version` row on the version list (route 4). */
export const DisciplinePlanVersionListItemResponseSchema = Type.Object({
  versionId: Str,
  planId: Str,
  sequence: Int,
  status: Str,
  kind: PlanKind,
  idgMeetingId: StrN,
  finalizedAt: StrN,
  signedAt: StrN,
  supersededAt: StrN,
  version: Int,
});

/** One collected signature on a version (route 5). */
export const DisciplineSignatureViewResponseSchema = Type.Object({
  signatureId: Str,
  signerMembershipId: Str,
  signerRole: Str,
  isAcknowledgment: Type.Boolean(),
  signedAt: Str,
});

/** Route 5 / 6 / 7 — one version with its sealed snapshot + quorum + collected signatures. */
export const DisciplinePlanVersionDetailResponseSchema = Type.Object({
  versionId: Str,
  planId: Str,
  sequence: Int,
  status: Str,
  kind: PlanKind,
  idgMeetingId: StrN,
  finalizedAt: StrN,
  signedAt: StrN,
  supersededAt: StrN,
  version: Int,
  stateSnapshot: Type.Unknown(),
  requiredSignerSet: Type.Unknown(),
  signatures: Type.Array(DisciplineSignatureViewResponseSchema),
});

/** Route 2 — the full plan the clinical surface renders. */
export const DisciplinePlanDetailResponseSchema = Type.Object({
  planId: Str,
  patientId: Str,
  admissionId: Str,
  providerEntityId: Str,
  locationId: Str,
  kind: PlanKind,
  status: Str,
  nextSupervisoryDueAt: StrN,
  initialAssessmentClockStartedAt: StrN,
  initialAssessmentSignedAt: StrN,
  spiritualCareDeclinedAt: StrN,
  updatedAt: Str,
  version: Int,
  aideMembershipId: StrN,
  supervisingRnMembershipId: StrN,
  supervisoryCadenceDaysOverride: Type.Union([Int, Type.Null()]),
  spiritualCareDeclined: StrN,
  goals: Type.Array(DisciplineGoalViewResponseSchema),
  interventions: Type.Array(DisciplineInterventionViewResponseSchema),
  assessments: Type.Array(DisciplineAssessmentViewResponseSchema),
  supervisoryVisits: Type.Array(AideSupervisoryVisitViewResponseSchema),
  volunteerAssignments: Type.Array(VolunteerAssignmentViewResponseSchema),
  versions: Type.Array(DisciplinePlanVersionListItemResponseSchema),
  supervisoryCadence: Type.Union([
    Type.Object({
      nextDueAt: Str,
      cadenceDays: Int,
      status: Str,
      hoursOverdue: Int,
    }),
    Type.Null(),
  ]),
  redacted_categories: Type.Array(RedactedCategorySchema),
});

/** Route 3 — the patient-shareable summary (both confidential categories always stripped, §7.9). */
export const DisciplinePlanSummaryResponseSchema = Type.Object({
  planId: Str,
  kind: Str,
  status: Str,
  goals: Type.Array(Type.Object({ goalId: Str, text: Str, status: Str, targetAt: StrN })),
  interventions: Type.Array(
    Type.Object({ interventionId: Str, scopeText: Str, frequencyText: Str, status: Str }),
  ),
  spiritualCareDeclined: Type.Boolean(),
  redacted_categories: Type.Array(RedactedCategorySchema),
});

/** Route 19/20/21/22 — a `volunteer_compliance_gate` row (status re-derived over the validity window). */
export const VolunteerComplianceGateViewResponseSchema = Type.Object({
  gateId: Str,
  volunteerMembershipId: Str,
  gateKind: GateKind,
  storedStatus: Str,
  effectiveStatus: Str,
  validFrom: Str,
  validUntil: StrN,
  revokedAt: StrN,
  sourceDocumentId: StrN,
  version: Int,
});

/** Route 27 — the seam-shaped effective status M17's pre-schedule gate reads. */
export const VolunteerEffectiveStatusViewResponseSchema = Type.Object({
  volunteerMembershipId: Str,
  isActive: Type.Boolean(),
  failingGates: Type.Array(Type.Object({ gateKind: Str, reason: Str })),
});

/** Route 25 — the discipline elements M8 / M14 / M22 pull for a patient's plans. */
export const RelevantElementsViewResponseSchema = Type.Object({
  planId: Str,
  kind: Str,
  status: Str,
  goals: Type.Array(DisciplineGoalViewResponseSchema),
  interventions: Type.Array(DisciplineInterventionViewResponseSchema),
});

/** Route 28 — the supervisory worklist row (the §7.1 ladder resolved per plan). */
export const SupervisoryCadenceRowViewResponseSchema = Type.Object({
  planId: Str,
  patientId: Str,
  admissionId: Str,
  providerEntityId: Str,
  locationId: Str,
  aideMembershipId: StrN,
  supervisingRnMembershipId: StrN,
  nextDueAt: Str,
  cadenceDays: Int,
  status: Str,
  hoursOverdue: Int,
  gateEngaged: Type.Boolean(),
});

/** Route 24 — the 418.78(e) ledger row an hour entry lands on. */
export const VolunteerHourEntryViewResponseSchema = Type.Object({
  hourEntryId: Str,
  ledgerId: Str,
  volunteerMembershipId: Str,
  source: Str,
  durationMinutes: Int,
  occurredAt: Str,
  ledgerTotalMinutes: Int,
});

// ── page envelopes (the list routes return `CursorPage<T>`) ──────────────────────────────────────────
export const DisciplinePlanListPageResponseSchema = cursorPage(
  DisciplinePlanListItemResponseSchema,
);
export const DisciplinePlanVersionListPageResponseSchema = cursorPage(
  DisciplinePlanVersionListItemResponseSchema,
);
export const VolunteerComplianceGateListPageResponseSchema = cursorPage(
  VolunteerComplianceGateViewResponseSchema,
);
export const RelevantElementsPageResponseSchema = cursorPage(RelevantElementsViewResponseSchema);
export const SupervisoryCadencePageResponseSchema = cursorPage(
  SupervisoryCadenceRowViewResponseSchema,
);

// ── compile-time pins: `T` (what the schema publishes) must be assignable to `V` (the service view) ────
type Conforms<T extends V, V> = T;
type _PlanListItem = Conforms<
  Static<typeof DisciplinePlanListItemResponseSchema>,
  DisciplinePlanListItem
>;
type _PlanDetail = Conforms<
  Static<typeof DisciplinePlanDetailResponseSchema>,
  DisciplinePlanDetail
>;
type _PlanSummary = Conforms<
  Static<typeof DisciplinePlanSummaryResponseSchema>,
  DisciplinePlanSummary
>;
type _VersionListItem = Conforms<
  Static<typeof DisciplinePlanVersionListItemResponseSchema>,
  DisciplinePlanVersionListItem
>;
type _VersionDetail = Conforms<
  Static<typeof DisciplinePlanVersionDetailResponseSchema>,
  DisciplinePlanVersionDetail
>;
type _Goal = Conforms<Static<typeof DisciplineGoalViewResponseSchema>, DisciplineGoalView>;
type _Intervention = Conforms<
  Static<typeof DisciplineInterventionViewResponseSchema>,
  DisciplineInterventionView
>;
type _Assessment = Conforms<
  Static<typeof DisciplineAssessmentViewResponseSchema>,
  DisciplineAssessmentView
>;
type _SupervisoryVisit = Conforms<
  Static<typeof AideSupervisoryVisitViewResponseSchema>,
  AideSupervisoryVisitView
>;
type _Assignment = Conforms<
  Static<typeof VolunteerAssignmentViewResponseSchema>,
  VolunteerAssignmentView
>;
type _Gate = Conforms<
  Static<typeof VolunteerComplianceGateViewResponseSchema>,
  VolunteerComplianceGateView
>;
type _EffectiveStatus = Conforms<
  Static<typeof VolunteerEffectiveStatusViewResponseSchema>,
  VolunteerEffectiveStatusView
>;
type _RelevantElements = Conforms<
  Static<typeof RelevantElementsViewResponseSchema>,
  RelevantElementsView
>;
type _SupervisoryCadence = Conforms<
  Static<typeof SupervisoryCadenceRowViewResponseSchema>,
  SupervisoryCadenceRowView
>;
type _HourEntry = Conforms<
  Static<typeof VolunteerHourEntryViewResponseSchema>,
  VolunteerHourEntryView
>;
type _PlanPage = Conforms<
  Static<typeof DisciplinePlanListPageResponseSchema>,
  CursorPage<DisciplinePlanListItem>
>;
type _VersionPage = Conforms<
  Static<typeof DisciplinePlanVersionListPageResponseSchema>,
  CursorPage<DisciplinePlanVersionListItem>
>;
type _GatePage = Conforms<
  Static<typeof VolunteerComplianceGateListPageResponseSchema>,
  CursorPage<VolunteerComplianceGateView>
>;
type _RelevantPage = Conforms<
  Static<typeof RelevantElementsPageResponseSchema>,
  CursorPage<RelevantElementsView>
>;
type _CadencePage = Conforms<
  Static<typeof SupervisoryCadencePageResponseSchema>,
  CursorPage<SupervisoryCadenceRowView>
>;
