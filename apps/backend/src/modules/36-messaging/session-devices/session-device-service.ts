// M36 WP 5.5 (ADR-0083) - list and revoke staff sessions ("devices"), as the owner (self-service) or as a security officer in the same
// organisation.
//
//  * Revoke is ONE transaction: delete the session row (the next request carrying it is a 401: `getSession` finds nothing), expire every endpoint
//    linked to it, write the audit row. Only AFTER the commit are the live sockets closed (on every api node); if that fails the session is
//    already dead for REST and for any new socket, and the realtime server's own re-check (ADR-0054 item 12) ends the old socket within a minute.
//  * A session that is not the caller's (or, for the admin, not in the caller's organisation), an unknown id and an already revoked one are ONE
//    answer: the same 404. Nothing about existence leaks and the second DELETE of the same id is that same 404 (the row is gone).
//  * The owner's list spans every organisation the owner is signed into (it is their own data); the admin's is bounded to sessions bound to the
//    admin's organisation, and an unknown or foreign user is an empty list, not an error.
import { NotFoundError } from "@chartwarden/types";
import type { DeviceDto, DeviceListDto, DeviceRevokeDto } from "@chartwarden/types";
import { deviceLabel } from "./device-label";
import type {
  SessionDeviceActor,
  SessionDeviceDeps,
  StoredSession,
  Tx,
} from "./session-device-types";

export interface SessionDeviceService {
  listOwn(actor: SessionDeviceActor): Promise<DeviceListDto>;
  revokeOwn(actor: SessionDeviceActor, sessionId: string): Promise<DeviceRevokeDto>;
  /** Security officer: another user's sessions bound to the officer's organisation. */
  listForUser(actor: SessionDeviceActor, targetUserId: string): Promise<DeviceListDto>;
  /** Security officer: revoke one session bound to the officer's organisation. */
  revokeForUser(actor: SessionDeviceActor, sessionId: string): Promise<DeviceRevokeDto>;
}

const lastUsed = (s: StoredSession): Date => s.lastActivityAt ?? s.createdAt;

function toDevices(
  sessions: readonly StoredSession[],
  pushLinked: ReadonlySet<string>,
  currentSessionId: string,
): DeviceListDto {
  const devices: DeviceDto[] = sessions
    .map((s) => ({
      id: s.id,
      label: deviceLabel(s.userAgent),
      current: s.id === currentSessionId,
      created_at: s.createdAt.toISOString(),
      last_used_at: lastUsed(s).toISOString(),
      push_registered: pushLinked.has(s.id),
    }))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) || b.last_used_at.localeCompare(a.last_used_at),
    );
  return { devices };
}

export function createSessionDeviceService(deps: SessionDeviceDeps): SessionDeviceService {
  const now = deps.now ?? (() => new Date());

  async function list(
    actor: SessionDeviceActor,
    owner: { userId: string; organizationId: string | null; audited: boolean },
  ): Promise<DeviceListDto> {
    return deps.transact(
      { organizationId: actor.organizationId, userId: owner.userId },
      async (tx: Tx) => {
        const sessions = await deps.sessions.listStaff(tx, {
          userId: owner.userId,
          organizationId: owner.organizationId,
          now: now(),
        });
        const linked = await deps.endpoints.linkedPushSessionIds(
          tx,
          owner.userId,
          sessions.map((s) => s.id),
        );
        if (owner.audited) {
          await deps.audit(tx, {
            action: "m36.session.admin_listed",
            organizationId: actor.organizationId,
            actorUserId: actor.userId,
            targetUserId: owner.userId,
            byAdmin: true,
            count: sessions.length,
          });
        }
        return toDevices(sessions, linked, actor.sessionId);
      },
    );
  }

  async function revoke(
    actor: SessionDeviceActor,
    target: { userId: string; organizationId: string | null; byAdmin: boolean },
    sessionId: string,
  ): Promise<DeviceRevokeDto> {
    const current = sessionId === actor.sessionId;
    const expired = await deps.transact(
      { organizationId: actor.organizationId, userId: target.userId },
      async (tx: Tx) => {
        const deleted = await deps.sessions.deleteStaff(tx, {
          sessionId,
          userId: target.userId,
          organizationId: target.organizationId,
        });
        if (!deleted) return null;
        const endpointsExpired = await deps.endpoints.expireForSession(
          tx,
          target.userId,
          sessionId,
        );
        await deps.audit(tx, {
          action: "m36.session.revoked",
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          targetUserId: target.userId,
          sessionId,
          byAdmin: target.byAdmin,
          current,
          endpointsExpired,
        });
        return endpointsExpired;
      },
    );
    if (expired === null) throw new NotFoundError("session", sessionId);
    await closeSockets(actor, sessionId);
    return { revoked: true, current, push_endpoints_expired: expired };
  }

  // Never throws: the revoke has committed. A failure is logged without the error text (it can carry connection details).
  async function closeSockets(actor: SessionDeviceActor, sessionId: string): Promise<void> {
    if (!deps.disconnectSession) return;
    try {
      await deps.disconnectSession(sessionId);
    } catch {
      deps.warn?.("session_revoke_socket_close_failed", {
        organizationId: actor.organizationId,
        sessionId,
      });
    }
  }

  return {
    listOwn: (actor) => list(actor, { userId: actor.userId, organizationId: null, audited: false }),
    revokeOwn: (actor, sessionId) =>
      revoke(actor, { userId: actor.userId, organizationId: null, byAdmin: false }, sessionId),
    listForUser: (actor, targetUserId) =>
      list(actor, {
        userId: targetUserId,
        organizationId: actor.organizationId,
        audited: true,
      }),
    async revokeForUser(actor, sessionId) {
      const owner = await deps.transact(
        { organizationId: actor.organizationId, userId: actor.userId },
        (tx) =>
          deps.sessions.findStaffOwner(tx, { sessionId, organizationId: actor.organizationId }),
      );
      if (!owner) throw new NotFoundError("session", sessionId);
      return revoke(
        actor,
        { userId: owner, organizationId: actor.organizationId, byAdmin: true },
        sessionId,
      );
    },
  };
}
