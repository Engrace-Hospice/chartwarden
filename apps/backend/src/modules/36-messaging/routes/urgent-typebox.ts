// apps/backend/src/modules/36-messaging/routes/urgent-typebox.ts - WP 4.1 request + response schemas. The body is the SBAR
// document (validated by the send pipeline's sanitiser and the SBAR policy, not here); there is no urgency, recipient-role
// or deadline field to set: the only choice the sender makes is one named colleague. `additionalProperties:false`.
import { Uuid } from "@chartwarden/shared/route-kit";
import { type TSchema, Type } from "@sinclair/typebox";
import { RichBodySchema } from "./messaging-typebox";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const SendUrgentMessageBodySchema = Type.Object(
  {
    body_doc: RichBodySchema,
    recipient_user_id: Uuid(),
    client_message_id: Uuid(),
  },
  { additionalProperties: false },
);

export const UrgentMessageResponseSchema = Type.Object({
  message_id: Uuid(),
  channel_id: Uuid(),
  patient_id: Uuid(),
  recipient_user_id: Uuid(),
  created: Type.Boolean(),
});

const Recipient = Type.Object({
  user_id: Uuid(),
  display_name: nullable(Type.String()),
});

export const UrgentMessageOptionsResponseSchema = Type.Union([
  Type.Object({ enabled: Type.Literal(false) }),
  Type.Object({
    enabled: Type.Literal(true),
    patient_linked: Type.Boolean(),
    patient_id: nullable(Uuid()),
    recipients: Type.Array(Recipient),
  }),
]);
