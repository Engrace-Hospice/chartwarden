// apps/backend/src/modules/36-messaging/routes/promotion-typebox.ts - WP 3.7 chart-promotion schemas (request + OpenAPI response).
// The target pair is a closed enum (ADR-0063 D2): there is no order, medication or prescribing literal anywhere in it.
// The DTO carries no message text and no body hash: a promotion is a pointer plus attribution.
import { type TSchema, Type } from "@sinclair/typebox";
import {
  CHART_PROMOTION_ACTIONS,
  CHART_PROMOTION_REASON_CODES,
  CHART_PROMOTION_STATUSES,
  CHART_PROMOTION_TARGET_KINDS,
  CHART_PROMOTION_TARGET_MODULES,
} from "@chartwarden/types";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const PromotionParamsSchema = Type.Object({ promotionId: Uuid });

export const ListPromotionsQuerySchema = Type.Object({
  status: Type.Optional(literals(["active", "closed", "all"] as const)),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

/** Each literal is closed here (an `m11` or `order` is a 422 at the transport); the PAIR is checked by the service (PROMOTION_TARGET_INVALID). */
export const RequestPromotionBodySchema = Type.Object(
  {
    target_module: literals(CHART_PROMOTION_TARGET_MODULES),
    target_kind: literals(CHART_PROMOTION_TARGET_KINDS),
    suggested_target_ref: Type.Optional(Uuid),
  },
  { additionalProperties: false },
);

export const PromotionSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  message_id: Type.String({ format: "uuid" }),
  channel_id: Type.String({ format: "uuid" }),
  patient_id: Type.String({ format: "uuid" }),
  target_module: literals(CHART_PROMOTION_TARGET_MODULES),
  target_kind: literals(CHART_PROMOTION_TARGET_KINDS),
  suggested_target_ref: nullable(Type.String({ format: "uuid" })),
  status: literals(CHART_PROMOTION_STATUSES),
  requested_by: Type.String({ format: "uuid" }),
  requested_by_display_name: nullable(Type.String()),
  requested_at: Type.String({ format: "date-time" }),
  source_author_user_id: Type.String({ format: "uuid" }),
  source_author_display_name: nullable(Type.String()),
  source_sent_at: Type.String({ format: "date-time" }),
  result_ref: nullable(Type.String({ format: "uuid" })),
  decided_by: nullable(Type.String({ format: "uuid" })),
  decided_at: nullable(Type.String({ format: "date-time" })),
  reason_code: nullable(literals(CHART_PROMOTION_REASON_CODES)),
  allowed_actions: Type.Array(literals(CHART_PROMOTION_ACTIONS)),
});

export const PromotionResponseSchema = Type.Object({ promotion: PromotionSchema });
export const RequestPromotionResponseSchema = Type.Object({
  promotion: PromotionSchema,
  created: Type.Boolean(),
});
export const MessagePromotionsResponseSchema = Type.Object({
  promotions: Type.Array(PromotionSchema),
});
/** `enabled:false` (tenant flag off) lets the web hide the UI without a 404 storm. */
export const PromotionListResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  promotions: Type.Array(PromotionSchema),
});
