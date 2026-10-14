// apps/backend/src/modules/36-messaging/routes/presence-typebox.ts - WP 2.12 request/response schemas for presence.
import { type Static, Type } from "@sinclair/typebox";

/** POST body: `typing: true` also refreshes the typing marker (typing implies present). Omitted body = heartbeat. */
export const PresenceHeartbeatBodySchema = Type.Object(
  { typing: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);
export type PresenceHeartbeatBody = Static<typeof PresenceHeartbeatBodySchema>;

/** GET response: ids only (the web resolves names from the channel's own member list). */
export const PresenceResponseSchema = Type.Object({
  present: Type.Array(Type.String()),
  typing: Type.Array(Type.String()),
});
