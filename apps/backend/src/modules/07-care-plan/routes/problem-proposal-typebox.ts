// apps/backend/src/modules/07-care-plan/routes/problem-proposal-typebox.ts — F-238 dx-writeback: the
// TypeBox schemas for the DocLens problem-proposal routes (list / accept / dismiss). Named `*-typebox` (not
// `*schema*`) for the table-ownership import heuristic, like care-plan-typebox.ts. The OpenAPI enrichment
// registry embeds these same objects, so the contract cannot drift from the validator.
import { Type } from "@sinclair/typebox";

const Id = () => Type.String({ minLength: 1, maxLength: 64 });

export const ProblemProposalParamsSchema = Type.Object({
  planId: Id(),
  proposalId: Id(),
});

export const ProblemProposalListQuerySchema = Type.Object({
  status: Type.Optional(
    Type.Union([Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("dismissed")]),
  ),
});

/**
 * Accept: the clinician's explicit act (AI Governance §2.1.1 "explicit clinician acknowledgment"). `kind` is
 * REQUIRED and chosen here — terminal/related/unrelated is the hospice physician's determination, never the
 * document's "principal" label. `icd10Code` lets the accepting clinician correct the code (a human code);
 * omitted → the as-written code is kept. `acknowledgeExtracted` must be `true`: the caller affirms the
 * diagnosis came from an extracted referral document and was reviewed.
 */
export const AcceptProblemProposalSchema = Type.Object({
  ifVersion: Type.Integer({ minimum: 1 }),
  kind: Type.Union([Type.Literal("terminal"), Type.Literal("related"), Type.Literal("unrelated")]),
  icd10Code: Type.Optional(Type.Union([Type.String({ minLength: 3, maxLength: 16 }), Type.Null()])),
  acknowledgeExtracted: Type.Literal(true),
});

export const DismissProblemProposalSchema = Type.Object({
  ifVersion: Type.Integer({ minimum: 1 }),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
});

const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

export const ProblemProposalViewSchema = Type.Object({
  id: Type.String(),
  carePlanId: Type.String(),
  description: Type.String(),
  icd10Code: Nullable(Type.String()),
  icd10Source: Type.Union([Type.Literal("document"), Type.Literal("reviewer_edit"), Type.Null()]),
  icd10Validation: Type.Union([
    Type.Literal("valid"),
    Type.Literal("not_valid_as_of"),
    Type.Literal("unvalidated"),
    Type.Null(),
  ]),
  documentRole: Type.Union([
    Type.Literal("principal"),
    Type.Literal("secondary"),
    Type.Literal("history"),
    Type.Literal("unspecified"),
  ]),
  sudRelated: Type.Boolean(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("accepted"),
    Type.Literal("dismissed"),
  ]),
  duplicateOfProblemId: Nullable(Type.String()),
  acceptedProblemId: Nullable(Type.String()),
  sourceIntakeBatchId: Type.String(),
  decidedAt: Nullable(Type.String({ format: "date-time" })),
  createdAt: Type.String({ format: "date-time" }),
  version: Type.Integer(),
});

export const ProblemProposalListResponseSchema = Type.Object({
  proposals: Type.Array(ProblemProposalViewSchema),
  /** True when SUD-flagged proposals were withheld from this caller (§7.6). */
  redacted: Type.Boolean(),
});

export const AcceptProblemProposalResponseSchema = Type.Object({
  proposalId: Type.String(),
  problemId: Type.String(),
  status: Type.Literal("accepted"),
  version: Type.Integer(),
});

export const DismissProblemProposalResponseSchema = Type.Object({
  proposalId: Type.String(),
  status: Type.Literal("dismissed"),
  version: Type.Integer(),
});
