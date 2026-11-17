import { pageQuery } from "@chartwarden/shared/route-kit";
import { Type } from "@sinclair/typebox";

const uuid = () => Type.String({ format: "uuid" });
const date = () => Type.String({ format: "date" });
export const NoeExceptionPathSchema = Type.Object({ id: uuid() });
export const NoeExceptionReviewPathSchema = Type.Object({ id: uuid(), reviewId: uuid() });
export const NoeExceptionListQuerySchema = Type.Object({ ...pageQuery() });
export const CreateNoeExceptionReviewSchema = Type.Object({
  category: Type.Union([
    Type.Literal("operations_disruption"),
    Type.Literal("cms_mac_system_issue"),
    Type.Literal("new_hospice_access_delay"),
    Type.Literal("other_external_determination"),
  ]),
  justificationDocumentId: uuid(),
  evidenceDocumentIds: Type.Array(uuid(), { maxItems: 20 }),
});
export const RecordNoeExceptionRequestSchema = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
  requestDate: date(),
  requestReference: Type.Optional(Type.String({ maxLength: 200 })),
  evidenceDocumentId: uuid(),
});
export const RecordNoeExceptionDecisionSchema = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
  decision: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
  authority: Type.Union([Type.Literal("a_b_mac"), Type.Literal("cms")]),
  decisionDate: date(),
  evidenceDocumentId: uuid(),
});
export const AddNoeExceptionEvidenceSchema = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
  evidenceDocumentIds: Type.Array(uuid(), { minItems: 1, maxItems: 20 }),
});

const NoeExceptionReviewStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("evidence_required"),
  Type.Literal("ready_for_external_request"),
  Type.Literal("request_recorded"),
  Type.Literal("awaiting_external_determination"),
  Type.Literal("external_approved_recorded"),
  Type.Literal("external_denied_recorded"),
  Type.Literal("withdrawn"),
]);
const nullableString = Type.Union([Type.String(), Type.Null()]);
export const NoeExceptionReviewViewSchema = Type.Object({
  id: uuid(),
  noeId: uuid(),
  category: Type.Union([
    Type.Literal("operations_disruption"),
    Type.Literal("cms_mac_system_issue"),
    Type.Literal("new_hospice_access_delay"),
    Type.Literal("other_external_determination"),
  ]),
  justificationDocumentId: uuid(),
  status: NoeExceptionReviewStatusSchema,
  evidenceDocumentIds: Type.Array(uuid()),
  externalRequestReference: nullableString,
  externalRequestDate: Type.Union([date(), Type.Null()]),
  externalAuthority: Type.Union([Type.Literal("a_b_mac"), Type.Literal("cms"), Type.Null()]),
  externalDecision: Type.Union([Type.Literal("approved"), Type.Literal("denied"), Type.Null()]),
  externalDecisionProvenance: Type.Union([Type.Literal("operator_attested_document"), Type.Null()]),
  externalDecisionDate: Type.Union([date(), Type.Null()]),
  externalDecisionDocumentId: Type.Union([uuid(), Type.Null()]),
  version: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});
export const NoeExceptionReviewListResponseSchema = Type.Object({
  items: Type.Array(NoeExceptionReviewViewSchema),
});
export const NoeExceptionReviewHistoryResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      eventType: Type.String(),
      fromStatus: Type.Union([NoeExceptionReviewStatusSchema, Type.Null()]),
      toStatus: NoeExceptionReviewStatusSchema,
      occurredAt: Type.String({ format: "date-time" }),
      evidenceDocumentIds: Type.Array(uuid()),
    }),
  ),
});
