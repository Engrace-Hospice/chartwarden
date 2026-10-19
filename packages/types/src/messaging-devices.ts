// M36 WP 5.5 (ADR-0082) - the device and session manager. A "device" is one signed-in staff SESSION (M2 `session` row) as its owner or a security
// officer sees it: a coarse label, when it was made and last used, whether it has a push endpoint, and whether it is the one making the request.
// Never returned: the session token, the IP address, the raw user agent, a push endpoint value or any other secret.

/** The permission that lets a security officer list and revoke ANOTHER user's sessions in the organisation (granted to no tenant role by default). */
export const SESSIONS_MANAGE_PERMISSION = "messaging.sessions.manage";

/** The fresh-step-up operation key the admin revoke demands (platform floor policy: webauthn or totp within the default window). */
export const SESSIONS_REVOKE_STEP_UP_KEY = "messaging.sessions.revoke";

export interface DeviceDto {
  /** The session id (not the token, which is never exposed). It is the key of DELETE. */
  readonly id: string;
  /** "Chrome · macOS": browser family and operating system only; "Unknown device" when the agent is missing or unrecognised. */
  readonly label: string;
  /** True for the session that made this request. */
  readonly current: boolean;
  readonly created_at: string;
  /** The last authenticated activity (the creation time until the first one). */
  readonly last_used_at: string;
  /** A verified push endpoint is linked to this session; revoking the session expires it. */
  readonly push_registered: boolean;
}

export interface DeviceListDto {
  readonly devices: readonly DeviceDto[];
}

export interface DeviceRevokeDto {
  readonly revoked: true;
  /** True when the revoked session is the one that made the request: the caller is signed out and must sign in again. */
  readonly current: boolean;
  /** How many push (or other) endpoints linked to the session were expired in the same transaction. */
  readonly push_endpoints_expired: number;
}
