// apps/backend/src/modules/36-messaging/routes/retention-governance-typebox.ts - WP 5.6 (ADR-0086, PROPOSED) schemas for the retention and
// legal-hold governance routes. Wire keys are snake_case (the contract in packages/types/src/messaging-retention.ts). Ids, counts, dates and
// the hold name only: the response schemas carry no message body and no person or patient name, and Fastify strips anything else.
import { Type } from "@sinclair/typebox";
import { MESSAGE_RETENTION_CLASSES } from "@chartwarden/types";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const UuidList = Type.Array(Uuid, { maxItems: 200 });
const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableInt = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

export const HoldParamsSchema = Type.Object({ id: Uuid }, { additionalProperties: false });

export const ApplyHoldBodySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    reason: Type.String({ minLength: 10, maxLength: 2000 }),
    channel_ids: Type.Optional(UuidList),
    user_ids: Type.Optional(UuidList),
    patient_ids: Type.Optional(UuidList),
    org_wide: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ReleaseHoldBodySchema = Type.Object(
  {
    reason: Type.String({ minLength: 10, maxLength: 2000 }),
    confirmed_eligible_count: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const RetentionOverviewResponseSchema = Type.Object({
  classes: Type.Array(
    Type.Object({
      class: Type.Union(MESSAGE_RETENTION_CLASSES.map((c) => Type.Literal(c))),
      period_years: Type.Integer({ minimum: 1 }),
      source: Type.Literal("platform_default"),
      eligible: NullableInt,
      held: NullableInt,
      capped: Type.Boolean(),
      certificate_id: NullableString,
      certificate_status: NullableString,
    }),
  ),
  next_scan_at: Type.String(),
  last_scan_at: NullableString,
  destruction_built: Type.Literal(false),
});

export const HoldResponseSchema = Type.Object({
  id: Uuid,
  name: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("released")]),
  scope: Type.Object({
    channel_ids: Type.Array(Type.String()),
    user_ids: Type.Array(Type.String()),
    patient_ids: Type.Array(Type.String()),
    org_wide: Type.Boolean(),
  }),
  placed_by: Type.String(),
  placed_at: Type.String(),
  released_at: NullableString,
  held_messages: Type.Integer({ minimum: 0 }),
});

export const HoldListResponseSchema = Type.Object({ holds: Type.Array(HoldResponseSchema) });

export const ReleasePreviewResponseSchema = Type.Object({
  hold_id: Uuid,
  held_messages: Type.Integer({ minimum: 0 }),
  eligible_on_release: Type.Integer({ minimum: 0 }),
});
