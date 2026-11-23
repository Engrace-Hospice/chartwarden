import { Type } from "@sinclair/typebox";

const Id = Type.String({ format: "uuid" });
const NonPostingState = Type.Union([
  Type.Literal("investigating"),
  Type.Literal("follow_up_required"),
  Type.Literal("reviewed_not_posted"),
  Type.Literal("reopened"),
]);
const ReasonCodes = Type.Array(Type.String({ minLength: 2, maxLength: 64 }), { maxItems: 32 });
const Summary = Type.Record(Type.String(), Type.Any());
export const MedicaidEraReviewQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.String({ pattern: "^[0-9]{1,3}$" })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);
const Item = Type.Object({
  id: Id,
  providerEntityId: Id,
  assessmentTrustStatus: Type.Literal("legacy_unverified"),
  vendor: Type.Literal("claimmd"),
  sourceEnvironment: Type.Union([Type.Literal("test"), Type.Literal("production"), Type.Null()]),
  canonicalPayerId: Type.Union([Id, Type.Null()]),
  programId: Type.Union([Type.String(), Type.Null()]),
  decisionStatus: Type.String(),
  reasonCodes: ReasonCodes,
  claimMatchStatus: Type.String(),
  duplicateStatus: Type.String(),
  workflowState: Type.String(),
  version: Type.Integer(),
  createdAt: Type.String({ format: "date-time" }),
});
export const MedicaidEraReviewPageSchema = Type.Object({
  items: Type.Array(Item),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export const MedicaidEraReviewDetailSchema = Type.Object({
  id: Id,
  organizationId: Id,
  providerEntityId: Id,
  assessmentTrustStatus: Type.Literal("legacy_unverified"),
  vendor: Type.Literal("claimmd"),
  accountReference: Type.Union([Type.String(), Type.Null()]),
  sourceEnvironment: Type.Union([Type.Literal("test"), Type.Literal("production"), Type.Null()]),
  sourceDigest: Type.Union([Type.String({ pattern: "^[0-9a-f]{64}$" }), Type.Null()]),
  canonicalPayerId: Type.Union([Id, Type.Null()]),
  programId: Type.Union([Type.String(), Type.Null()]),
  assessmentVersion: Type.String(),
  decisionStatus: Type.String(),
  reasonCodes: ReasonCodes,
  claimMatchStatus: Type.String(),
  duplicateStatus: Type.String(),
  safeSummary: Type.Union([Summary, Type.Null()]),
  workflowState: Type.String(),
  version: Type.Integer(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});
export const MedicaidEraReviewHistorySchema = Type.Object({
  items: Type.Array(
    Type.Object({
      version: Type.Integer(),
      action: Type.String(),
      reasonCode: Type.Union([Type.String(), Type.Null()]),
      actorMembershipId: Type.Union([Id, Type.Null()]),
      trustStatus: Type.Union([
        Type.Literal("legacy_unverified"),
        Type.Literal("evaluator_attested"),
      ]),
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
});
export const MedicaidEraEvaluateParamsSchema = Type.Object({ artifactId: Id });
export const MedicaidEraEvaluateResultSchema = Type.Union([
  Type.Object({
    status: Type.Literal("review_saved"),
    reviewId: Id,
    version: Type.Integer(),
    replay: Type.Boolean(),
  }),
  Type.Object({
    status: Type.Union([Type.Literal("unavailable"), Type.Literal("held")]),
    reasonCode: Type.String(),
  }),
]);
export const MedicaidEraDispositionSchema = Type.Object(
  {
    expectedVersion: Type.Integer({ minimum: 1 }),
    state: NonPostingState,
    reasonCode: Type.String({ minLength: 2, maxLength: 64, pattern: "^[A-Z0-9_]+$" }),
  },
  { additionalProperties: false },
);
export const MedicaidEraDispositionResultSchema = Type.Object({
  id: Id,
  version: Type.Integer(),
  workflowState: Type.String(),
  replay: Type.Boolean(),
});
export const MedicaidEraNoteSchema = Type.Object(
  {
    expectedVersion: Type.Integer({ minimum: 1 }),
    reasonCode: Type.String({ minLength: 2, maxLength: 64, pattern: "^[A-Z0-9_]+$" }),
  },
  { additionalProperties: false },
);
