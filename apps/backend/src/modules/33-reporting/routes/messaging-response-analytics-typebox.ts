// apps/backend/src/modules/33-reporting/routes/messaging-response-analytics-typebox.ts - M33 serving M36 WP 6.2 (ADR-0110).
// Query and response shapes for GET /api/v1/messaging/analytics/response. The response has no person, patient or content field by design.
import { ANALYTICS_GROUP_BY } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";

const nullableNumber = Type.Union([Type.Number(), Type.Null()]);

export const ResponseAnalyticsQuerySchema = Type.Object({
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
  groupBy: Type.Optional(Type.Union(ANALYTICS_GROUP_BY.map((g) => Type.Literal(g)))),
});

const KpisSchema = Type.Object({
  requests: Type.Integer(),
  acknowledged: Type.Integer(),
  ackedBeforeDeadlineRate: nullableNumber,
  escalationRate: nullableNumber,
  medianAckSeconds: nullableNumber,
  handoffsOffered: Type.Union([Type.Integer(), Type.Null()]),
  handoffsAccepted: Type.Union([Type.Integer(), Type.Null()]),
  medianHandoffAcceptSeconds: nullableNumber,
});

const CellSchema = Type.Object({
  group: Type.String(),
  requests: Type.Integer(),
  acknowledged: Type.Integer(),
  ackedBeforeDeadlineRate: nullableNumber,
  escalationRate: nullableNumber,
  medianAckSeconds: nullableNumber,
});

export const ResponseAnalyticsResponseSchema = Type.Union([
  Type.Object({ status: Type.Literal("insufficient_data"), minCohort: Type.Integer() }),
  Type.Object({
    status: Type.Literal("ok"),
    from: Type.String(),
    to: Type.String(),
    minCohort: Type.Integer(),
    groupBy: Type.Union(ANALYTICS_GROUP_BY.map((g) => Type.Literal(g))),
    kpis: KpisSchema,
    cells: Type.Array(CellSchema),
    suppressedGroups: Type.Integer(),
  }),
]);
