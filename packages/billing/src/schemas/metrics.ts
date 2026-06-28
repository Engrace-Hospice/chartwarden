// @wardenx/billing — metrics schema: route #38 `GET /metrics` (per-window aggregate metrics for the M33
// reporting consumer) — §4.1. Mirrors `ClaimMetricsProvider.windowAggregate` (aggregate-only; no PHI).
import { type Static, Type } from "@sinclair/typebox";
import { CentsSchema, IsoDateTimeSchema, Uuid } from "./common";

/** The aggregation dimension (mirrors the `MetricsDimension` seam union). */
export const MetricsDimensionApi = Type.Union([
  Type.Literal("state"),
  Type.Literal("tob"),
  Type.Literal("denial_reason"),
  Type.Literal("rule_failure"),
  Type.Literal("override_role"),
  Type.Literal("mac_jurisdiction"),
]);

export const MetricsQuery = Type.Object({
  providerEntityId: Type.Optional(Type.Union([Uuid, Type.Literal("all")])),
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  dim: MetricsDimensionApi,
});
export type MetricsQuery = Static<typeof MetricsQuery>;

/** One dimension bucket (mirrors `MetricsBucket`). */
export const MetricsBucketView = Type.Object({
  key: Type.String(),
  count: Type.Integer({ minimum: 0 }),
  amountCents: CentsSchema,
});
export type MetricsBucketView = Static<typeof MetricsBucketView>;

export const MetricsResponse = Type.Object({
  dim: MetricsDimensionApi,
  window: Type.Object({ from: IsoDateTimeSchema, to: IsoDateTimeSchema }),
  buckets: Type.Array(MetricsBucketView),
});
export type MetricsResponse = Static<typeof MetricsResponse>;
