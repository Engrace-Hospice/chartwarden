// apps/backend/src/modules/36-messaging/routes/role-send-typebox.ts - ADR-0081 (PROPOSED) schemas for role-based send. The role is the
// CLOSED list of the directory; `recipient_user_id` is the person the sender confirmed from the resolution (it is named `recipient_user_id`
// so the urgent route's per-pair limiter reads it unchanged). `additionalProperties:false`: no urgency, deadline or tier field to set.
import { type TSchema, Type } from "@sinclair/typebox";
import {
  AFTERHOURS_TRIAGE_LINE_STATES,
  ONCALL_DIRECTORY_ROLES,
  ONCALL_RANKS,
  ROLE_SEND_RESOLUTION_STATUSES,
} from "@chartwarden/types";
import { RichBodySchema, UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const oneOf = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v)));

export const RoleSendResolutionQuerySchema = Type.Object(
  { role: oneOf(ONCALL_DIRECTORY_ROLES), patient_id: Uuid },
  { additionalProperties: false },
);

export const RoleSendResolutionResponseSchema = Type.Object({
  role: oneOf(ONCALL_DIRECTORY_ROLES),
  as_of: Type.String({ format: "date-time" }),
  status: oneOf(ROLE_SEND_RESOLUTION_STATUSES),
  afterhours_triage: Type.Boolean(),
  people: Type.Array(
    Type.Object({
      user_id: Type.String({ format: "uuid" }),
      display_name: nullable(Type.String()),
      rank: oneOf(ONCALL_RANKS),
    }),
  ),
  shift_ends_at: nullable(Type.String({ format: "date-time" })),
  time_zone: nullable(Type.String()),
});

export const SendRoleMessageBodySchema = Type.Object(
  {
    role: oneOf(ONCALL_DIRECTORY_ROLES),
    patient_id: Uuid,
    recipient_user_id: Uuid,
    body_doc: RichBodySchema,
    client_message_id: Uuid,
  },
  { additionalProperties: false },
);

export const RoleSendResponseSchema = Type.Object({
  message_id: Type.String({ format: "uuid" }),
  channel_id: Type.String({ format: "uuid" }),
  patient_id: Type.String({ format: "uuid" }),
  recipient_user_id: Type.String({ format: "uuid" }),
  role: oneOf(ONCALL_DIRECTORY_ROLES),
  created: Type.Boolean(),
});

/** ADR-0082 S4/S5: the after-hours triage lines of some messages of one channel (at most 50 ids, comma-separated). */
export const AfterHoursLinesQuerySchema = Type.Object(
  { message_ids: Type.String({ minLength: 36, maxLength: 50 * 37 }) },
  { additionalProperties: false },
);

export const AfterHoursLinesResponseSchema = Type.Object({
  lines: Type.Array(
    Type.Object({
      message_id: Type.String({ format: "uuid" }),
      state: oneOf(AFTERHOURS_TRIAGE_LINE_STATES),
      text: Type.String(),
    }),
  ),
});
