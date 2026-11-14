import { Type } from "@sinclair/typebox";
import { pageQuery } from "@chartwarden/shared/route-kit";

const uuid = () => Type.String({ format: "uuid" });
const date = () => Type.String({ format: "date" });
export const NoeExceptionPathSchema = Type.Object({ id: uuid() });
export const NoeExceptionReviewPathSchema = Type.Object({ id: uuid(), reviewId: uuid() });
export const NoeExceptionListQuerySchema = Type.Object({ ...pageQuery() });
export const CreateNoeExceptionReviewSchema = Type.Object({
  category: Type.Union([
    Type.Literal("operations_disruption"), Type.Literal("cms_mac_system_issue"),
    Type.Literal("new_hospice_access_delay"), Type.Literal("other_external_determination"),
  ]),
  justificationDocumentId: uuid(),
  evidenceDocumentIds: Type.Array(uuid(), { maxItems: 20 }),
});
export const RecordNoeExceptionRequestSchema = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }), requestDate: date(), requestReference: Type.Optional(Type.String({ maxLength: 200 })), evidenceDocumentId: uuid(),
});
export const RecordNoeExceptionDecisionSchema = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }), decision: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
  authority: Type.Union([Type.Literal("a_b_mac"), Type.Literal("cms")]), decisionDate: date(), evidenceDocumentId: uuid(),
});
export const AddNoeExceptionEvidenceSchema = Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }), evidenceDocumentIds: Type.Array(uuid(), { minItems: 1, maxItems: 20 }) });
