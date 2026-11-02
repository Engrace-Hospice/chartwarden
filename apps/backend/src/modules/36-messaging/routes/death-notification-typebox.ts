// apps/backend/src/modules/36-messaging/routes/death-notification-typebox.ts - schemas for the death-notification routes. Wire keys are snake_case
// (packages/types/src/messaging-death-notification.ts). Ids, enums and instants only; the one address in a request body is the funeral home's contact,
// is never stored and never echoed back.
import {
  DEATH_NOTIFICATION_KINDS,
  DEATH_NOTIFICATION_STATES,
} from "@chartwarden/types";
import { type TSchema, Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const Instant = Type.String({ format: "date-time" });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const DeathNotificationBoardParamsSchema = Type.Object({ boardId: Uuid });
export const DeathNotificationParamsSchema = Type.Object({ notificationId: Uuid });

export const SendFuneralHomeBodySchema = Type.Object(
  {
    funeral_home_entity_id: Uuid,
    recipient_email: Type.String({
      minLength: 3,
      maxLength: 254,
      pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
    }),
  },
  { additionalProperties: false },
);

export const DeathNotificationSchema = Type.Object({
  id: Uuid,
  board_id: Uuid,
  recipient_kind: literals(DEATH_NOTIFICATION_KINDS),
  state: literals(DEATH_NOTIFICATION_STATES),
  created_at: Instant,
  acked_at: nullable(Instant),
  acked_by: nullable(Uuid),
  can_ack: Type.Boolean(),
});

export const DeathNotificationListResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  notifications: Type.Array(DeathNotificationSchema),
});
export const DeathNotificationResponseSchema = Type.Object({
  notification: DeathNotificationSchema,
});
