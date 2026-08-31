// apps/backend/src/modules/07-care-plan/routes/care-plan-typebox.ts — M7-T05 TypeBox route schemas
// (§4.3). Named `care-plan-typebox` (NOT `*schema*`) so the table-ownership import heuristic never
// mistakes a TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope. Schemas mirror §4.3 1:1 (abbreviated where the spec is). Optimistic
// concurrency: the three PATCH routes carry the read version in the `If-Match` header (NOT the body —
// see ./concurrency.ts); the POST state-change routes carry it in the body as `ifVersion`.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type { CarePlanOverdueStatus, RelevantCarePlanElements } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

// Slice ids are synthetic (`cp_1`); routes accept a loose id param. Cross-module ids (patientId) are
// validated as uuids per §4.3.
export const IdParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });
export const PlanVersionParamsSchema = Type.Object({
  planId: Type.String({ minLength: 1, maxLength: 64 }),
  versionId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const PlanElementParamsSchema = Type.Object({
  planId: Type.String({ minLength: 1, maxLength: 64 }),
  elementId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const PatientParamsSchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
});
export const PlanParamsSchema = Type.Object({
  planId: Type.String({ minLength: 1, maxLength: 64 }),
});

const Text = (max = 4000) => Type.String({ minLength: 1, maxLength: max });
const Version = () => Type.Integer({ minimum: 1 });

const PROBLEM_KIND = ["terminal", "related", "unrelated"] as const;
const PROBLEM_SOURCE = [
  "clinical",
  "patient_reported",
  "family_reported",
  "history",
  "intake_extraction",
] as const;
const GOAL_SOURCE = ["clinical", "patient_stated", "family_stated", "agent_stated"] as const;
const INTERVENTION_DISCIPLINE = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "md_np",
  "pt",
  "ot",
  "st",
  "volunteer",
  "music_therapy",
  "dietitian",
  "bereavement",
] as const;
const VERSION_KIND = ["initial", "idg_review", "interim_revision", "discharge"] as const;
const SIGNER_ROLE = [
  "rn_case_manager",
  "hospice_physician",
  "nurse_practitioner",
  "msw",
  "chaplain",
  "medical_director",
] as const;

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

// ── Care plan bootstrap (route: POST /patients/:patientId/care-plan) ──────────────────────────────
export const BootstrapCarePlanSchema = Type.Object({
  admissionId: Type.String({ format: "uuid" }),
});

// ── Versions ──────────────────────────────────────────────────────────────────────────────────────
export const CreateVersionSchema = Type.Object({
  kind: lit(VERSION_KIND),
  idgMeetingId: Type.Optional(Type.String({ format: "uuid" })),
});
export const FinalizeVersionSchema = Type.Object({
  ifVersion: Version(),
  /** A tenant may tighten (add slots) the floor quorum; never loosen (validated server-side). */
  requiredSignerSet: Type.Optional(
    Type.Array(Type.Object({ role: lit(SIGNER_ROLE), count: Type.Integer({ minimum: 1 }) })),
  ),
});
export const SignVersionSchema = Type.Object({
  ifVersion: Version(),
  signerRole: lit(SIGNER_ROLE),
  patientUnderstandingText: Type.Optional(Type.String({ maxLength: 4000 })),
});
export const ReturnToDraftSchema = Type.Object({ ifVersion: Version() });

// ── Problems ────────────────────────────────────────────────────────────────────────────────────
export const CreateProblemSchema = Type.Object({
  icd10Code: Type.Optional(Type.String({ maxLength: 16 })),
  snomedCode: Type.Optional(Type.String({ maxLength: 32 })),
  description: Text(),
  kind: lit(PROBLEM_KIND),
  source: lit(PROBLEM_SOURCE),
  sudRelated: Type.Optional(Type.Boolean()),
  onsetAt: Type.Optional(Type.String({ format: "date-time" })),
});
export const PatchProblemSchema = Type.Object({
  description: Type.Optional(Text()),
  kind: Type.Optional(lit(PROBLEM_KIND)),
  icd10Code: Type.Optional(Type.String({ maxLength: 16 })),
  snomedCode: Type.Optional(Type.String({ maxLength: 32 })),
});
export const ResolveProblemSchema = Type.Object({
  ifVersion: Version(),
  resolutionNote: Text(),
});

// ── Goals ───────────────────────────────────────────────────────────────────────────────────────
export const CreateGoalSchema = Type.Object({
  problemId: Type.String({ minLength: 1, maxLength: 64 }),
  originalText: Text(),
  source: lit(GOAL_SOURCE),
  actingConsentId: Type.Optional(Type.String({ format: "uuid" })),
  measurableOutcome: Type.Optional(Type.String({ maxLength: 4000 })),
  targetAt: Type.Optional(Type.String({ format: "date-time" })),
});
export const PatchGoalSchema = Type.Object({
  revisedText: Type.Optional(Type.String({ maxLength: 4000 })),
  measurableOutcome: Type.Optional(Type.String({ maxLength: 4000 })),
  status: Type.Optional(
    lit(["not_started", "in_progress", "met", "not_met", "revised", "discontinued"] as const),
  ),
  targetAt: Type.Optional(Type.String({ format: "date-time" })),
});

// ── Interventions ───────────────────────────────────────────────────────────────────────────────
export const CreateInterventionSchema = Type.Object({
  problemId: Type.String({ minLength: 1, maxLength: 64 }),
  goalRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }))),
  scopeText: Text(),
  frequencyText: Type.String({ minLength: 1, maxLength: 200 }),
  frequencyValue: Type.String({ minLength: 1, maxLength: 64 }),
  discipline: lit(INTERVENTION_DISCIPLINE),
  responsibleRole: Type.Optional(Type.String({ maxLength: 64 })),
});
export const PatchInterventionSchema = Type.Object({
  scopeText: Type.Optional(Text()),
  frequencyText: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  frequencyValue: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  responsibleRole: Type.Optional(Type.String({ maxLength: 64 })),
});
export const DiscontinueInterventionSchema = Type.Object({
  ifVersion: Version(),
  reason: Text(),
});

// ── List queries ──────────────────────────────────────────────────────────────────────────────────
export const VersionListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export const RelevantElementsQuerySchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  encounterType: Type.Optional(Type.String({ maxLength: 64 })),
  discipline: Type.Optional(Type.String({ maxLength: 64 })),
});

// ── §4.3 RESPONSE DTOs (F0 enrichment) ──────────────────────────────────────────────────────────────
// The read routes returned typed view shapes but published NO response contract, so the generated client
// typed every GET body as `never`. These DTOs mirror the handlers' concrete read output 1:1; the two §7.8
// seam reads are additionally pinned to the @wardenx/types seam DTOs by the compile-time `Conforms`
// aliases below, so a seam-contract field added or renamed breaks `bun run build` rather than drifting.
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const PROBLEM_STATUS = ["active", "resolved", "inactive"] as const;
const GOAL_STATUS = [
  "not_started",
  "in_progress",
  "met",
  "not_met",
  "revised",
  "discontinued",
] as const;
const INTERVENTION_STATUS = ["active", "discontinued", "completed"] as const;
const VERSION_STATUS = ["draft", "in_review", "signed", "superseded"] as const;
const PLAN_STATUS = ["draft", "active", "discharged"] as const;

const RequiredSignerSlotSchema = Type.Object({ role: Type.String(), count: Type.Integer() });

/** One care-plan version projection (the in-memory + Drizzle `versionDto`). */
export const CarePlanVersionResponseSchema = Type.Object({
  id: Type.String(),
  planId: Type.String(),
  sequence: Type.Integer(),
  kind: lit(VERSION_KIND),
  status: lit(VERSION_STATUS),
  idgMeetingId: Nullable(Type.String()),
  requiredSignerSet: Type.Array(RequiredSignerSlotSchema),
  signatures: Type.Array(Type.Object({ signerRole: lit(SIGNER_ROLE), signedAt: Type.String() })),
  draftedAt: Nullable(Type.String()),
  signedAt: Nullable(Type.String()),
  supersededAt: Nullable(Type.String()),
  stateSnapshot: Type.Optional(Type.Unknown()),
  patientUnderstandingText: Type.Optional(Nullable(Type.String())),
  version: Type.Integer(),
});

/** The `{ items, nextCursor }` page the version-list read returns. */
export const CarePlanVersionPageResponseSchema = Type.Object({
  items: Type.Array(CarePlanVersionResponseSchema),
  nextCursor: Nullable(Type.String()),
});

const ProblemRecordResponseSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  planId: Type.String(),
  icd10Code: Nullable(Type.String()),
  snomedCode: Nullable(Type.String()),
  description: Type.String(),
  kind: lit(PROBLEM_KIND),
  source: lit(PROBLEM_SOURCE),
  sudRelated: Type.Boolean(),
  status: lit(PROBLEM_STATUS),
  onsetAt: Nullable(Type.String()),
  resolvedAt: Nullable(Type.String()),
  resolutionNote: Nullable(Type.String()),
  version: Type.Integer(),
});

const GoalRecordResponseSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  planId: Type.String(),
  problemId: Type.String(),
  originalText: Type.String(),
  revisedText: Nullable(Type.String()),
  source: lit(GOAL_SOURCE),
  actingConsentId: Nullable(Type.String()),
  measurableOutcome: Nullable(Type.String()),
  targetAt: Nullable(Type.String()),
  status: lit(GOAL_STATUS),
  statusNote: Nullable(Type.String()),
  version: Type.Integer(),
});

const InterventionRecordResponseSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  planId: Type.String(),
  problemId: Type.String(),
  goalRefs: Type.Array(Type.String()),
  scopeText: Type.String(),
  frequencyText: Type.String(),
  frequencyValue: Type.String(),
  discipline: lit(INTERVENTION_DISCIPLINE),
  responsibleRole: Nullable(Type.String()),
  linkedOrderId: Nullable(Type.String()),
  status: lit(INTERVENTION_STATUS),
  discontinueReason: Nullable(Type.String()),
  version: Type.Integer(),
});

/** The care-plan aggregate the patient read returns (§7.6 SUD-filtered element sets). */
export const CarePlanDetailResponseSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  status: lit(PLAN_STATUS),
  activeVersionId: Nullable(Type.String()),
  version: Type.Integer(),
  versions: Type.Array(CarePlanVersionResponseSchema),
  problems: Type.Array(ProblemRecordResponseSchema),
  goals: Type.Array(GoalRecordResponseSchema),
  interventions: Type.Array(InterventionRecordResponseSchema),
  redacted: Type.Boolean(),
});

/** GET patient care-plan returns the aggregate when present, else the `{ carePlan: null }` envelope. */
export const CarePlanForPatientResponseSchema = Type.Union([
  CarePlanDetailResponseSchema,
  Type.Object({ carePlan: Type.Null() }),
]);

/** The lay-language summary the §7.8 summary read returns. */
export const CarePlanSummaryResponseSchema = Type.Object({
  planId: Type.String(),
  versionId: Nullable(Type.String()),
  activeProblems: Type.Array(Type.Object({ description: Type.String(), kind: lit(PROBLEM_KIND) })),
  patientStatedGoals: Type.Array(
    Type.Object({ text: Type.String(), measurableOutcome: Nullable(Type.String()) }),
  ),
  activeInterventions: Type.Array(
    Type.Object({
      layText: Type.String(),
      discipline: lit(INTERVENTION_DISCIPLINE),
      frequencyText: Type.String(),
    }),
  ),
  redacted: Type.Boolean(),
});

export const CarePlanReadinessResponseSchema = Type.Object({
  planId: Type.String(),
  openVersionId: Nullable(Type.String()),
  openVersionStatus: Type.Optional(lit(VERSION_STATUS)),
  canFinalize: Type.Boolean(),
  canSign: Type.Boolean(),
  blockers: Type.Array(Type.Object({ code: Type.String(), message: Type.String() })),
  signatures: Type.Object({
    required: Type.Array(RequiredSignerSlotSchema),
    collected: Type.Array(
      Type.Object({ signerRole: Type.String(), signedAt: Nullable(Type.String()) }),
    ),
    missing: Type.Array(RequiredSignerSlotSchema),
  }),
});

export const CarePlanProposedChangesResponseSchema = Type.Object({
  versionId: Type.String(),
  kind: lit(VERSION_KIND),
  meetingId: Nullable(Type.String()),
  status: lit(VERSION_STATUS),
  proposals: Type.Array(
    Type.Object({
      id: Type.String(),
      decisionId: Type.String(),
      meetingId: Type.String(),
      sourceOutboxEventId: Type.String(),
      status: Type.String(),
      proposedAt: Nullable(Type.String()),
      inReviewAt: Nullable(Type.String()),
      appliedAt: Nullable(Type.String()),
      conflictReason: Nullable(Type.String()),
    }),
  ),
  changes: Type.Array(
    Type.Object({
      id: Type.String(),
      proposalId: Type.String(),
      decisionId: Type.String(),
      entityType: Type.String(),
      operation: Type.String(),
      targetId: Nullable(Type.String()),
      before: Type.Unknown(),
      proposed: Type.Unknown(),
      status: Type.String(),
    }),
  ),
});

export const CarePlanReviewStatusResponseSchema = Type.Object({
  planId: Type.String(),
  nextReviewDueAt: Nullable(Type.String()),
  status: Type.Union([
    Type.Literal("not_due"),
    Type.Literal("due"),
    Type.Literal("overdue"),
    Type.Literal("review_in_progress"),
  ]),
  overdueByDays: Type.Integer({ minimum: 0 }),
  openReviewVersionId: Nullable(Type.String()),
  openReviewVersionStatus: Nullable(Type.String()),
  canStartReview: Type.Boolean(),
});

/** §7.8 `CarePlanReader.isReviewOverdue` — the 5-/15-day CoP 418.56 gate result. */
export const OverdueStatusResponseSchema = Type.Object({
  planId: Type.String(),
  patientId: Type.String(),
  overdue: Type.Boolean(),
  initialOverdue: Type.Boolean(),
  reviewOverdue: Type.Boolean(),
  initialDueAt: Type.String(),
  nextReviewDueAt: Nullable(Type.String()),
});

/** §7.8 `CarePlanReader.relevantElementsForEncounter` — the encounter element picker. */
export const RelevantElementsResponseSchema = Type.Object({
  planId: Type.String(),
  patientId: Type.String(),
  problems: Type.Array(
    Type.Object({
      problemId: Type.String(),
      icd10Code: Nullable(Type.String()),
      snomedCode: Nullable(Type.String()),
      description: Type.String(),
      kind: lit(PROBLEM_KIND),
      status: lit(PROBLEM_STATUS),
    }),
  ),
  goals: Type.Array(
    Type.Object({
      goalId: Type.String(),
      problemId: Type.String(),
      text: Type.String(),
      source: lit(GOAL_SOURCE),
      status: lit(GOAL_STATUS),
    }),
  ),
  interventions: Type.Array(
    Type.Object({
      interventionId: Type.String(),
      problemId: Type.String(),
      scopeText: Type.String(),
      frequencyText: Type.String(),
      discipline: lit(INTERVENTION_DISCIPLINE),
      status: lit(INTERVENTION_STATUS),
    }),
  ),
  redacted: Type.Boolean(),
});

// Compile-time pins: the two seam DTOs must stay assignable to the §7.8 contract they serialize.
type Conforms<T extends V, V> = T;
type _Overdue = Conforms<Static<typeof OverdueStatusResponseSchema>, CarePlanOverdueStatus>;
type _Relevant = Conforms<Static<typeof RelevantElementsResponseSchema>, RelevantCarePlanElements>;

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
