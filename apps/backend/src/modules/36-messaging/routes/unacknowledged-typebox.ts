// apps/backend/src/modules/36-messaging/routes/unacknowledged-typebox.ts - WP 4.9 (ADR-0076) schemas for the supervisor's
// unacknowledged queue. The query accepts ONLY the narrowing filters (status, overdue) and the paging keys: an unknown key is a 400,
// never a silently ignored filter. The response is ids, enums, counts and instants; no message text, no patient name.
import { type TSchema, Type } from "@sinclair/typebox";
import {
  ACK_CLASSES,
  ACK_ESCALATION_NOTES,
  ACK_QUEUE_LIMIT_MAX,
  ACK_QUEUE_STATUSES,
} from "@wardenx/types";

const UuidOut = Type.String({ format: "uuid" });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const oneOf = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v)));

export const UnacknowledgedQuerySchema = Type.Object(
  {
    status: Type.Optional(oneOf(ACK_QUEUE_STATUSES)),
    overdue: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: ACK_QUEUE_LIMIT_MAX })),
  },
  { additionalProperties: false },
);

const Item = Type.Object({
  restricted: Type.Boolean(),
  id: nullable(UuidOut),
  channel_id: nullable(UuidOut),
  message_id: nullable(UuidOut),
  patient_id: nullable(UuidOut),
  ack_class: oneOf(ACK_CLASSES),
  status: oneOf(ACK_QUEUE_STATUSES),
  assigned_user_id: nullable(UuidOut),
  assigned_display_name: nullable(Type.String()),
  requested_at: Type.String({ format: "date-time" }),
  deadline_at: Type.String({ format: "date-time" }),
  overdue: Type.Boolean(),
  overdue_seconds: Type.Integer({ minimum: 0 }),
  current_tier: Type.Integer(),
  escalation_note: nullable(oneOf(ACK_ESCALATION_NOTES)),
  delivery_failed: Type.Boolean(),
  requester_display_name: nullable(Type.String()),
  request_ref: UuidOut,
});

export const UnacknowledgedResponseSchema = Type.Object({
  items: Type.Array(Item),
  next_cursor: nullable(Type.String()),
  audit_request_id: nullable(UuidOut),
  complete: Type.Boolean(),
  filtered: Type.Boolean(),
  counts: Type.Object({
    unfiltered: Type.Integer({ minimum: 0 }),
    matching: Type.Integer({ minimum: 0 }),
    overdue: Type.Integer({ minimum: 0 }),
    failed_unreachable: Type.Integer({ minimum: 0 }),
  }),
});
