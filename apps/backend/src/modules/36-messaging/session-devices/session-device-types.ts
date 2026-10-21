// M36 WP 5.5 (ADR-0083) - the ports of the device and session manager. The `session` table is M2's (a Better Auth row) and `delivery_endpoint` is
// M36's, so neither side touches the other's table: the service below orchestrates them inside ONE transaction through these ports, and the
// composition (./binding.ts) supplies the database-backed ones. Unit tests supply fakes.
import type { DbClient } from "@chartwarden/db";

export type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The only columns the manager ever reads from a session: never the token, the IP address or the active organisation. */
export interface StoredSession {
  readonly id: string;
  readonly userId: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastActivityAt: Date | null;
}

/** Staff-class sessions only (portal, auditor and external sessions are other modules' and have no realtime channel). */
export interface SessionStorePort {
  /** `organizationId: null` = every organisation (the owner's own list); otherwise only sessions bound to that organisation. Unexpired only. */
  listStaff(
    tx: Tx,
    query: { userId: string; organizationId: string | null; now: Date },
  ): Promise<readonly StoredSession[]>;
  /** The owner of a session bound to this organisation, or null (another organisation, pre-org, unknown: indistinguishable). */
  findStaffOwner(
    tx: Tx,
    query: { sessionId: string; organizationId: string },
  ): Promise<string | null>;
  /** Delete the row (the revocation). True when a row of this owner (and organisation, when given) was deleted. */
  deleteStaff(
    tx: Tx,
    query: { sessionId: string; userId: string; organizationId: string | null },
  ): Promise<boolean>;
}

/** `delivery_endpoint.session_id` (migration 1130): the endpoint a session registered. */
export interface EndpointLinkPort {
  /** Which of these sessions have a verified endpoint linked to them. */
  linkedPushSessionIds(
    tx: Tx,
    userId: string,
    sessionIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
  /** Expire every non-expired endpoint linked to the session; returns how many. */
  expireForSession(tx: Tx, userId: string, sessionId: string): Promise<number>;
}

export interface SessionAuditEntry {
  readonly action: "m36.session.revoked" | "m36.session.admin_listed";
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly targetUserId: string;
  /** Absent for a list. */
  readonly sessionId?: string;
  readonly byAdmin: boolean;
  readonly current?: boolean;
  readonly endpointsExpired?: number;
  /** Listed sessions, for a list. */
  readonly count?: number;
}

export interface SessionDeviceDeps {
  /** One database transaction with `app.org_id` and `app.user_id` set (the user is the endpoint owner: `delivery_endpoint` RLS is by user). */
  transact<T>(
    scope: { organizationId: string; userId: string },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T>;
  readonly sessions: SessionStorePort;
  readonly endpoints: EndpointLinkPort;
  audit(tx: Tx, entry: SessionAuditEntry): Promise<void>;
  /** Close every live socket of the session on every api node. Called only after the revoke has committed. */
  disconnectSession?(sessionId: string): Promise<void>;
  now?(): Date;
  warn?(event: string, context: Record<string, string | number>): void;
}

/** Who is asking: the authenticated actor and the session that made the request. */
export interface SessionDeviceActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly sessionId: string;
}
