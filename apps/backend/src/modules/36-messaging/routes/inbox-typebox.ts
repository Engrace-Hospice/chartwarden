// apps/backend/src/modules/36-messaging/routes/inbox-typebox.ts - WP 6.1 (ADR-0091) schemas for the smart work inbox. The query takes
// only `limit` (an unknown key is a 422). The response is generic titles, codes, ids and instants: no message text, no patient name.
import {
  SMART_INBOX_BANDS,
  SMART_INBOX_LIMIT_MAX,
  SMART_INBOX_REASON_CODES,
} from "@chartwarden/types";
import { type TSchema, Type } from "@sinclair/typebox";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const oneOf = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v)));

export const InboxQuerySchema = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SMART_INBOX_LIMIT_MAX })) },
  { additionalProperties: false },
);

const Item = Type.Object({
  key: Type.String(),
  band: oneOf(SMART_INBOX_BANDS),
  rank: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  reasons: Type.Array(Type.Object({ code: oneOf(SMART_INBOX_REASON_CODES), text: Type.String() })),
  since: Type.String({ format: "date-time" }),
  due_at: nullable(Type.String({ format: "date-time" })),
  channel_id: nullable(Type.String({ format: "uuid" })),
  target: oneOf(["acknowledgment_request", "task", "handoff", "conversation"] as const),
  target_id: nullable(Type.String({ format: "uuid" })),
  restricted: Type.Boolean(),
  count: nullable(Type.Integer({ minimum: 0 })),
});

export const InboxResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  items: Type.Array(Item),
  band_counts: Type.Object({
    urgent_ack: Type.Integer({ minimum: 0 }),
    handoff_awaiting: Type.Integer({ minimum: 0 }),
    task_assigned: Type.Integer({ minimum: 0 }),
    mention: Type.Integer({ minimum: 0 }),
    care_team_unread: Type.Integer({ minimum: 0 }),
  }),
  complete: Type.Boolean(),
  urgent_complete: Type.Boolean(),
  unavailable_sources: Type.Array(oneOf(SMART_INBOX_BANDS)),
});
