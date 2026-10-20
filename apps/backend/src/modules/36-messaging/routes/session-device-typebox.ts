// apps/backend/src/modules/36-messaging/routes/session-device-typebox.ts - WP 5.5 (ADR-0083, PROPOSED) schemas for the device and session manager.
// The response carries only the coarse, safe fields (see packages/types messaging-devices.ts): no token, no IP address, no raw user agent.
import { Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

// A Better Auth session id: a short random alphanumeric string. A pattern keeps odd bytes out of the path before any query.
const SESSION_ID_PATTERN = "^[A-Za-z0-9_-]{1,128}$";

export const DeviceParamsSchema = Type.Object(
  { id: Type.String({ pattern: SESSION_ID_PATTERN }) },
  { additionalProperties: false },
);

export const DeviceSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  current: Type.Boolean(),
  created_at: Type.String({ format: "date-time" }),
  last_used_at: Type.String({ format: "date-time" }),
  push_registered: Type.Boolean(),
});

export const DeviceListResponseSchema = Type.Object({ devices: Type.Array(DeviceSchema) });

export const DeviceRevokeResponseSchema = Type.Object({
  revoked: Type.Literal(true),
  current: Type.Boolean(),
  push_endpoints_expired: Type.Integer({ minimum: 0 }),
});

export const SessionAdminListQuerySchema = Type.Object(
  { user_id: Type.String({ pattern: UUID_PATTERN }) },
  { additionalProperties: false },
);
