// apps/backend/src/modules/36-messaging/routes/ack-typebox.ts - WP 4.2 request + response schemas for the acknowledgment-request
// routes. The create body has NO class, deadline, role or status field: the class is derived from the message, the deadline
// from the platform policy, and the only choice the sender makes is one named colleague. `additionalProperties:false`.
import { type TSchema, Type } from "@sinclair/typebox";
import { ACK_CLASSES, ACK_ESCALATION_NOTES, ACK_EVENT_TYPES, ACK_STATUSES } from "@wardenx/types";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const UuidOut = Type.String({ format: "uuid" });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const oneOf = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v)));

export const AckParamsSchema = Type.Object({ id: Uuid });

export const CreateAckBodySchema = Type.Object(
  { message_id: Uuid, assigned_user_id: Uuid },
  { additionalProperties: false },
);
export const ReassignAckBodySchema = Type.Object(
  { assigned_user_id: Uuid },
  { additionalProperties: false },
);
/** Acknowledge and resolve take no input: the actor is the session, the target is the path. */
export const EmptyAckBodySchema = Type.Object({}, { additionalProperties: false });

const AckRequest = Type.Object({
  id: UuidOut,
  message_id: UuidOut,
  channel_id: UuidOut,
  patient_id: UuidOut,
  ack_class: oneOf(ACK_CLASSES),
  status: oneOf(ACK_STATUSES),
  requester_user_id: UuidOut,
  assigned_user_id: UuidOut,
  requested_at: Type.String({ format: "date-time" }),
  window_started_at: Type.String({ format: "date-time" }),
  deadline_at: Type.String({ format: "date-time" }),
  current_tier: Type.Integer(),
  acknowledged_at: nullable(Type.String({ format: "date-time" })),
  acknowledged_by_user_id: nullable(UuidOut),
  resolved_at: nullable(Type.String({ format: "date-time" })),
  cancelled_at: nullable(Type.String({ format: "date-time" })),
  version: Type.Integer(),
  escalation_note: Type.Optional(nullable(oneOf(ACK_ESCALATION_NOTES))),
  viewer_actions: Type.Object({
    can_acknowledge: Type.Boolean(),
    can_reassign: Type.Boolean(),
    can_resolve: Type.Boolean(),
  }),
});

const AckEvent = Type.Object({
  id: UuidOut,
  event_type: oneOf(ACK_EVENT_TYPES),
  actor_user_id: nullable(UuidOut),
  actor_kind: oneOf(["user", "system"] as const),
  from_status: nullable(oneOf(ACK_STATUSES)),
  to_status: nullable(oneOf(ACK_STATUSES)),
  assigned_user_id: nullable(UuidOut),
  previous_assigned_user_id: nullable(UuidOut),
  tier: Type.Integer(),
  created_at: Type.String({ format: "date-time" }),
});

export const AckRequestResponseSchema = Type.Object({
  request: AckRequest,
  changed: Type.Boolean(),
});
export const AckCreateResponseSchema = Type.Object({
  request: AckRequest,
  changed: Type.Boolean(),
  created: Type.Boolean(),
});
export const AckDetailResponseSchema = Type.Object({
  request: AckRequest,
  events: Type.Array(AckEvent),
});
export const AckChannelListResponseSchema = Type.Object({ requests: Type.Array(AckRequest) });
