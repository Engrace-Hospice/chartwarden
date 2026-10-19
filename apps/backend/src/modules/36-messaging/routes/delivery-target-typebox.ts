// apps/backend/src/modules/36-messaging/routes/delivery-target-typebox.ts - WP 4.8 response schema for the deep-link resolver.
// Three ids and nothing else: no patient, no channel name, no text.
import { Type } from "@sinclair/typebox";

const UuidOut = Type.String({ format: "uuid" });

export const DeliveryTargetResponseSchema = Type.Object({
  channel_id: UuidOut,
  message_id: UuidOut,
  /** The open acknowledgment request on that message, or null. */
  ack_request_id: Type.Union([UuidOut, Type.Null()]),
});
