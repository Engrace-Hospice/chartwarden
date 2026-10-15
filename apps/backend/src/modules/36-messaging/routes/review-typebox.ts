// apps/backend/src/modules/36-messaging/routes/review-typebox.ts - WP 3.8 lifecycle review-queue schemas (request + OpenAPI
// response). Ids are canonical uuids. The close reason is a closed enum here (a typed 422 names the field); there is no
// free-text justification anywhere - the code is the justification.
import { type TSchema, Type } from "@sinclair/typebox";
import {
  REVIEW_ACTIONS,
  REVIEW_CAUSES,
  REVIEW_ITEM_KINDS,
  REVIEW_RESOLUTIONS,
  REVIEW_SOURCES,
  REVIEW_STATES,
  TASK_CLOSE_REASONS,
} from "@wardenx/types";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const ReviewParamsSchema = Type.Object({ reviewItemId: Uuid });

export const ListReviewItemsQuerySchema = Type.Object({
  state: Type.Optional(literals(["open", "resolved", "all"] as const)),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const ReassignReviewBodySchema = Type.Object(
  { to_user_id: Uuid },
  { additionalProperties: false },
);

export const CloseReviewBodySchema = Type.Object(
  { reason: literals(TASK_CLOSE_REASONS) },
  { additionalProperties: false },
);

const ReviewTaskSchema = Type.Object({
  status: Type.String(),
  clinical_concern: Type.Boolean(),
  needs_owner: Type.Boolean(),
  due_at: nullable(Type.String({ format: "date-time" })),
  assignee_user_id: Type.String({ format: "uuid" }),
  assignee_display_name: nullable(Type.String()),
  created_by_user_id: Type.String({ format: "uuid" }),
  created_by_display_name: nullable(Type.String()),
  message_id: Type.String({ format: "uuid" }),
  channel_id: Type.String({ format: "uuid" }),
});

export const ReviewItemSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  source: literals(REVIEW_SOURCES),
  cause: literals(REVIEW_CAUSES),
  state: literals(REVIEW_STATES),
  resolution: nullable(literals(REVIEW_RESOLUTIONS)),
  resolution_reason: nullable(literals(TASK_CLOSE_REASONS)),
  restricted: Type.Boolean(),
  patient_id: nullable(Type.String({ format: "uuid" })),
  patient_display_name: nullable(Type.String()),
  mrn_suffix: nullable(Type.String()),
  item_kind: literals(REVIEW_ITEM_KINDS),
  item_id: Type.String({ format: "uuid" }),
  task: nullable(ReviewTaskSchema),
  reassigned_to_user_id: nullable(Type.String({ format: "uuid" })),
  reassigned_to_display_name: nullable(Type.String()),
  resolved_by_user_id: nullable(Type.String({ format: "uuid" })),
  resolved_by_display_name: nullable(Type.String()),
  resolved_at: nullable(Type.String({ format: "date-time" })),
  created_at: Type.String({ format: "date-time" }),
  allowed_actions: Type.Array(literals(REVIEW_ACTIONS)),
});

export const ReviewItemResponseSchema = Type.Object({ item: ReviewItemSchema });
/** `enabled:false` (tenant flag off) lets the web hide the tab without a 404 storm. */
export const ReviewListResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  items: Type.Array(ReviewItemSchema),
});
