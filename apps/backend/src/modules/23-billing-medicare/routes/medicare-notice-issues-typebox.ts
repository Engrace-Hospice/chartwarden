import { Type } from "@sinclair/typebox";

const uuid = Type.String({ format: "uuid" });
export const MedicareNoticeIssueListQuery = Type.Object({
  status: Type.Optional(
    Type.Union(
      ["active", "acknowledged", "assigned", "resolved", "superseded"].map((x) => Type.Literal(x)),
    ),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const MedicareNoticeIssueParams = Type.Object({ id: uuid });
export const MedicareNoticeIssueVersionBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
});
export const MedicareNoticeIssueAssignBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
  assignedMembershipId: Type.Union([uuid, Type.Null()]),
});
export const MedicareNoticeIssueResponse = Type.Object({
  id: uuid,
  organizationId: uuid,
  noticeType: Type.Union(["noe", "notr", "transfer", "cancellation"].map((x) => Type.Literal(x))),
  noticeId: uuid,
  issueCode: Type.String(),
  occurrenceKey: Type.String(),
  status: Type.Union(
    ["active", "acknowledged", "assigned", "resolved", "superseded"].map((x) => Type.Literal(x)),
  ),
  severity: Type.Union(["info", "warning", "critical"].map((x) => Type.Literal(x))),
  responsibleArea: Type.String(),
  ddeWorkItemId: Type.Union([uuid, Type.Null()]),
  assignedMembershipId: Type.Union([uuid, Type.Null()]),
  acknowledgedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  firstDetectedAt: Type.String({ format: "date-time" }),
  lastEvaluatedAt: Type.String({ format: "date-time" }),
  version: Type.Integer(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});
export const MedicareNoticeIssueHistoryResponse = Type.Array(
  Type.Object({
    eventType: Type.String(),
    reasonCode: Type.String(),
    occurredAt: Type.String({ format: "date-time" }),
  }),
);
