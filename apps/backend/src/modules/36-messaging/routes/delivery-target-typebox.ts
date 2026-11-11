// apps/backend/src/modules/36-messaging/routes/delivery-target-typebox.ts - WP 4.8 response schema for the deep-link resolver.
// Three ids and nothing else: no patient, no channel name, no text.
import { Uuid } from "@chartwarden/shared/route-kit";
import { Type } from "@sinclair/typebox";

export const DeliveryTargetResponseSchema = Type.Object({
  channel_id: Uuid(),
  message_id: Uuid(),
  /** The open acknowledgment request on that message, or null. */
  ack_request_id: Type.Union([Uuid(), Type.Null()]),
});
