// apps/backend/src/modules/07-care-plan/routes/change-proposal-typebox.ts — WF09: the TypeBox contract for the plan-of-care CHANGE
// PROPOSALS a visit records (draft create / replace / withdraw, the review list, accept / dismiss). Named `*-typebox` (not
// `*schema*`) for the table-ownership import heuristic, like care-plan-typebox.ts. The OpenAPI enrichment registry embeds these same
// objects, so the contract cannot drift from the validator.
//
// A proposal body mirrors what the manual Care Plans route for its kind accepts, field for field (care-plan-typebox.ts), except:
// goals and problems default their source to `clinical`; a goal or intervention names EITHER an existing `problemId` OR the
// `parentProposalId` of a problem proposal made in the same visit; a goal status move never targets `not_started`.
import {
  CARE_PLAN_CHANGE_PROPOSAL_DISCIPLINES,
  CARE_PLAN_CHANGE_PROPOSAL_DISMISSAL_REASONS,
  CARE_PLAN_CHANGE_PROPOSAL_GOAL_SOURCES,
  CARE_PLAN_CHANGE_PROPOSAL_GOAL_STATUSES,
  CARE_PLAN_CHANGE_PROPOSAL_KINDS,
  CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_KINDS,
  CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_SOURCES,
  CARE_PLAN_CHANGE_PROPOSAL_STATUSES,
} from "@chartwarden/db/schema";
import { type Static, type TSchema, Type } from "@sinclair/typebox";

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const Uuid = () => Type.String({ format: "uuid" });
const Text = (max = 4000) => Type.String({ minLength: 1, maxLength: max });
const Strict = { additionalProperties: false } as const;

/** The most live (draft / pending) proposals one visit may carry: a sanity cap, far above a real visit. */
export const MAX_PROPOSALS_PER_ENCOUNTER = 50;

export const ChangeProposalParamsSchema = Type.Object({ planId: Uuid(), proposalId: Uuid() });
export const ChangeProposalPlanParamsSchema = Type.Object({ planId: Uuid() });
export const ChangeProposalPatientParamsSchema = Type.Object({ patientId: Uuid() });

// ── The change a proposal carries (one variant per kind) ─────────────────────────────────────────────
export const ProblemAddChangeSchema = Type.Object(
  {
    kind: Type.Literal("problem_add"),
    description: Text(),
    problemKind: lit(CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_KINDS),
    problemSource: Type.Optional(lit(CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_SOURCES)),
    icd10Code: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    snomedCode: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    sudRelated: Type.Optional(Type.Boolean()),
    onsetAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  Strict,
);
export const ProblemResolveChangeSchema = Type.Object(
  { kind: Type.Literal("problem_resolve"), problemId: Uuid(), resolutionNote: Text() },
  Strict,
);
export const GoalAddChangeSchema = Type.Object(
  {
    kind: Type.Literal("goal_add"),
    problemId: Type.Optional(Uuid()),
    parentProposalId: Type.Optional(Uuid()),
    originalText: Text(),
    goalSource: Type.Optional(lit(CARE_PLAN_CHANGE_PROPOSAL_GOAL_SOURCES)),
    measurableOutcome: Type.Optional(Text()),
    targetAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  Strict,
);
export const GoalUpdateChangeSchema = Type.Object(
  {
    kind: Type.Literal("goal_update"),
    goalId: Uuid(),
    revisedText: Type.Optional(Text()),
    measurableOutcome: Type.Optional(Text()),
    goalStatus: Type.Optional(lit(CARE_PLAN_CHANGE_PROPOSAL_GOAL_STATUSES)),
    targetAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  Strict,
);
export const InterventionAddChangeSchema = Type.Object(
  {
    kind: Type.Literal("intervention_add"),
    problemId: Type.Optional(Uuid()),
    parentProposalId: Type.Optional(Uuid()),
    goalRefs: Type.Optional(Type.Array(Uuid(), { maxItems: 20 })),
    scopeText: Text(),
    frequencyText: Type.String({ minLength: 1, maxLength: 200 }),
    frequencyValue: Type.String({ minLength: 1, maxLength: 64 }),
    discipline: lit(CARE_PLAN_CHANGE_PROPOSAL_DISCIPLINES),
    responsibleRole: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  Strict,
);
export const InterventionDiscontinueChangeSchema = Type.Object(
  { kind: Type.Literal("intervention_discontinue"), interventionId: Uuid(), reason: Text() },
  Strict,
);

const CHANGE_VARIANTS = [
  ProblemAddChangeSchema,
  ProblemResolveChangeSchema,
  GoalAddChangeSchema,
  GoalUpdateChangeSchema,
  InterventionAddChangeSchema,
  InterventionDiscontinueChangeSchema,
] as const;

/** PUT body: replaces a draft's change wholesale (the visit it belongs to never changes). */
export const ReplaceChangeProposalSchema = Type.Union([...CHANGE_VARIANTS]);
export type ChangeProposalChange = Static<typeof ReplaceChangeProposalSchema>;

/** POST body: the same change plus the visit it was recorded in. */
export const CreateChangeProposalSchema = Type.Union(
  CHANGE_VARIANTS.map((variant) =>
    Type.Object({ sourceEncounterId: Uuid(), ...variant.properties }, Strict),
  ),
);
export type CreateChangeProposalInput = Static<typeof CreateChangeProposalSchema>;

// ── Queries and decisions ────────────────────────────────────────────────────────────────────────────
/** The plan's review list: only released proposals, `pending` unless a decided history is asked for. */
export const ChangeProposalPlanListQuerySchema = Type.Object({
  status: Type.Optional(
    Type.Union([Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("dismissed")]),
  ),
});
export type ChangeProposalPlanListQuery = Static<typeof ChangeProposalPlanListQuerySchema>;
/** The patient-keyed list: one visit's proposals (the caller's own drafts included), or every pending one. */
export const ChangeProposalPatientListQuerySchema = Type.Object({
  sourceEncounterId: Type.Optional(Uuid()),
  status: Type.Optional(lit(CARE_PLAN_CHANGE_PROPOSAL_STATUSES)),
});
export const DismissChangeProposalSchema = Type.Object(
  { reason: Type.Optional(lit(CARE_PLAN_CHANGE_PROPOSAL_DISMISSAL_REASONS)) },
  Strict,
);

// ── Responses ────────────────────────────────────────────────────────────────────────────────────────
const MemberRefSchema = Type.Object({
  membershipId: Type.String(),
  /** The clinician's name, or null when it cannot be resolved. Never an email or username. */
  displayName: Nullable(Type.String()),
});

/** Every proposed field, null when the kind does not carry it. The keys echo the request body's, so a composer can edit in place. */
export const ChangeProposalChangeViewSchema = Type.Object({
  description: Nullable(Type.String()),
  problemKind: Nullable(lit(CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_KINDS)),
  problemSource: Nullable(lit(CARE_PLAN_CHANGE_PROPOSAL_PROBLEM_SOURCES)),
  icd10Code: Nullable(Type.String()),
  snomedCode: Nullable(Type.String()),
  onsetAt: Nullable(Type.String({ format: "date-time" })),
  resolutionNote: Nullable(Type.String()),
  originalText: Nullable(Type.String()),
  goalSource: Nullable(lit(CARE_PLAN_CHANGE_PROPOSAL_GOAL_SOURCES)),
  measurableOutcome: Nullable(Type.String()),
  targetAt: Nullable(Type.String({ format: "date-time" })),
  revisedText: Nullable(Type.String()),
  goalStatus: Nullable(lit(CARE_PLAN_CHANGE_PROPOSAL_GOAL_STATUSES)),
  goalRefs: Type.Array(Type.String()),
  scopeText: Nullable(Type.String()),
  frequencyText: Nullable(Type.String()),
  frequencyValue: Nullable(Type.String()),
  discipline: Nullable(lit(CARE_PLAN_CHANGE_PROPOSAL_DISCIPLINES)),
  responsibleRole: Nullable(Type.String()),
  reason: Nullable(Type.String()),
});

export const ChangeProposalTargetViewSchema = Type.Object({
  type: lit(["problem", "goal", "intervention"] as const),
  /** Null only when the target is the problem proposal named by `parentProposalId`. */
  id: Nullable(Type.String()),
  /** What the plan calls it: the problem's description, the goal's text, the intervention's scope. */
  label: Nullable(Type.String()),
});

export const CarePlanChangeProposalViewSchema = Type.Object({
  id: Type.String(),
  carePlanId: Type.String(),
  patientId: Type.String(),
  sourceEncounterId: Type.String(),
  kind: lit(CARE_PLAN_CHANGE_PROPOSAL_KINDS),
  status: lit(CARE_PLAN_CHANGE_PROPOSAL_STATUSES),
  sudRelated: Type.Boolean(),
  change: ChangeProposalChangeViewSchema,
  /** The element the change touches (null for a new problem). */
  target: Nullable(ChangeProposalTargetViewSchema),
  parentProposalId: Nullable(Type.String()),
  proposedBy: MemberRefSchema,
  proposedAt: Type.String({ format: "date-time" }),
  releasedAt: Nullable(Type.String({ format: "date-time" })),
  decidedBy: Nullable(MemberRefSchema),
  decidedAt: Nullable(Type.String({ format: "date-time" })),
  dismissalReason: Nullable(lit(CARE_PLAN_CHANGE_PROPOSAL_DISMISSAL_REASONS)),
  /** The problem / goal / intervention an accepted proposal created or changed. */
  resultElementId: Nullable(Type.String()),
});
export type CarePlanChangeProposalView = Static<typeof CarePlanChangeProposalViewSchema>;

export const CarePlanChangeProposalListResponseSchema = Type.Object({
  patientId: Type.String(),
  proposals: Type.Array(CarePlanChangeProposalViewSchema),
  /** True when Part 2 proposals were withheld from this caller (§7.6). */
  redacted: Type.Boolean(),
});

export const WithdrawChangeProposalResponseSchema = Type.Object({
  proposalId: Type.String(),
  status: Type.Literal("withdrawn"),
});
export const AcceptChangeProposalResponseSchema = Type.Object({
  proposalId: Type.String(),
  status: Type.Literal("accepted"),
  resultElementType: lit(["problem", "goal", "intervention"] as const),
  resultElementId: Type.String(),
  decidedAt: Type.String({ format: "date-time" }),
});
export const DismissChangeProposalResponseSchema = Type.Object({
  proposalId: Type.String(),
  status: Type.Literal("dismissed"),
  decidedAt: Type.String({ format: "date-time" }),
  dismissalReason: Nullable(lit(CARE_PLAN_CHANGE_PROPOSAL_DISMISSAL_REASONS)),
});
