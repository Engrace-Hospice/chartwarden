// apps/backend/src/modules/36-messaging/routes/retention-governance-typebox.ts - WP 5.6 (ADR-0086, PROPOSED) schemas for the retention and
// legal-hold governance routes. Wire keys are snake_case (the contract in packages/types/src/messaging-retention.ts). Ids, counts, dates and
// the hold name and the staff members' display names only: the response schemas carry no message body, reason text or patient name, and
// Fastify strips anything else.
import {
  MESSAGE_REDACTION_REASON_MAX_LENGTH,
  MESSAGE_REDACTION_REASON_MIN_LENGTH,
  MESSAGE_RETENTION_CLASSES,
  RETENTION_DESTRUCTION_MODES,
} from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
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
  destruction_mode: Type.Union(RETENTION_DESTRUCTION_MODES.map((m) => Type.Literal(m))),
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
  placed_by_name: NullableString,
  placed_at: Type.String(),
  released_at: NullableString,
  held_messages: Type.Integer({ minimum: 0 }),
});

export const HoldListResponseSchema = Type.Object({ holds: Type.Array(HoldResponseSchema) });

// ---- Redaction (ADR-0055 item 7; migration 1156). Ids, names, instants and a hold flag: never the message or the reason text.
export const RedactionParamsSchema = Type.Object({ id: Uuid }, { additionalProperties: false });

export const RequestRedactionBodySchema = Type.Object(
  {
    message_id: Uuid,
    reason: Type.String({
      minLength: MESSAGE_REDACTION_REASON_MIN_LENGTH,
      maxLength: MESSAGE_REDACTION_REASON_MAX_LENGTH,
    }),
  },
  { additionalProperties: false },
);

export const RedactionResponseSchema = Type.Object({
  id: Uuid,
  message_id: Uuid,
  status: Type.Union([Type.Literal("requested"), Type.Literal("approved")]),
  requested_by: Type.String(),
  requested_by_name: NullableString,
  requested_at: Type.String(),
  approved_by: NullableString,
  approved_by_name: NullableString,
  approved_at: NullableString,
  under_legal_hold: Type.Boolean(),
});

export const RedactionListResponseSchema = Type.Object({
  redactions: Type.Array(RedactionResponseSchema),
});

export const ReleasePreviewResponseSchema = Type.Object({
  hold_id: Uuid,
  held_messages: Type.Integer({ minimum: 0 }),
  eligible_on_release: Type.Integer({ minimum: 0 }),
});
