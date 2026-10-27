import { SNOOZE_MAX_MINUTES, SNOOZE_MIN_MINUTES } from "@chartwarden/types";
// apps/backend/src/modules/36-messaging/routes/snooze-reminder-typebox.ts - WP 4.10 (ADR-0077) request/response schemas (schemas only,
// so the OpenAPI emitter does not import the auth stack).
import { Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });

export const MessageParamsSchema = Type.Object({ id: Uuid });

/** The bounds are enforced again (typed 422) by the service and by a database CHECK; here they only shape the contract. */
export const SnoozeBodySchema = Type.Object(
  {
    duration_minutes: Type.Integer({ minimum: SNOOZE_MIN_MINUTES, maximum: SNOOZE_MAX_MINUTES }),
  },
  { additionalProperties: false },
);

export const SnoozeResponseSchema = Type.Object({
  channel_id: Type.String(),
  snoozed_until: Type.Union([Type.String(), Type.Null()]),
  snoozable: Type.Boolean(),
});

export const ClearedResponseSchema = Type.Object({ cleared: Type.Boolean() });

/** ISO 8601 instant WITH an offset; the service bounds it (1 minute to 30 days ahead) and answers a typed 422. */
export const ReminderBodySchema = Type.Object(
  { remind_at: Type.String({ minLength: 10, maxLength: 40 }) },
  { additionalProperties: false },
);

export const ReminderResponseSchema = Type.Object({
  id: Type.String(),
  channel_id: Type.String(),
  message_id: Type.String(),
  remind_at: Type.String(),
});

export const ReminderListResponseSchema = Type.Object({
  reminders: Type.Array(ReminderResponseSchema),
  max_pending: Type.Integer(),
});
