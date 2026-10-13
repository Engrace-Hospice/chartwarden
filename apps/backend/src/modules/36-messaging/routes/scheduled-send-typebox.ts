// apps/backend/src/modules/36-messaging/routes/scheduled-send-typebox.ts — WP 2.6 request/response schemas (kept apart
// from scheduled-send-routes.ts so the OpenAPI emitter imports schemas only, not the auth stack).
import { Type } from "@sinclair/typebox";
import { SCHEDULE_BLOCK_REASONS } from "@wardenx/messaging";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });

export const ScheduledMessageParamsSchema = Type.Object({ id: Uuid });

export const ScheduledListQuerySchema = Type.Object({ channelId: Type.Optional(Uuid) });

export const CreateScheduledBodySchema = Type.Object({
  // The service enforces blank (422) and the 8000-character ceiling (422).
  body: Type.String({ maxLength: 100_000 }),
  parentMessageId: Type.Optional(Uuid),
  /** ISO 8601 instant; the service bounds it (at least 1 minute, at most 30 days ahead). */
  scheduledFor: Type.String({ minLength: 10, maxLength: 40 }),
  /** IANA zone the sender chose the time in (display only). */
  timeZone: Type.Optional(Type.String({ maxLength: 64 })),
});

export const RescheduleBodySchema = Type.Object({
  scheduledFor: Type.String({ minLength: 10, maxLength: 40 }),
});

export const ScheduledMessageViewSchema = Type.Object({
  id: Type.String(),
  channelId: Type.String(),
  parentMessageId: Type.Union([Type.String(), Type.Null()]),
  body: Type.String(),
  scheduledFor: Type.String(),
  timeZone: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("blocked")]),
  blockedReason: Type.Union([
    ...SCHEDULE_BLOCK_REASONS.map((reason) => Type.Literal(reason)),
    Type.Null(),
  ]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export const ScheduledListResponseSchema = Type.Object({
  scheduledMessages: Type.Array(ScheduledMessageViewSchema),
});

export const CancelScheduledResponseSchema = Type.Object({ cancelled: Type.Boolean() });
