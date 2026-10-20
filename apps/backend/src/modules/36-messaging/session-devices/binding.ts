// M36 WP 5.5 (ADR-0083) - the composition of the device and session manager: M2's staff-session store, M36's endpoint link, the audit writer and
// the realtime socket close (injected by the composition root: the Valkey emitter reaches every api node). One transaction per call, with
// `app.org_id` and `app.user_id` set to the session OWNER (delivery_endpoint's RLS is by user), while the audit row names the real actor.
import { type AuditExecutor, audit } from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray, ne } from "drizzle-orm";
import { createStaffSessionStore } from "../../02-identity/staff-session-store";
import { createSessionDeviceService } from "./session-device-service";
import type { SessionDeviceService } from "./session-device-service";
import type {
  EndpointLinkPort,
  SessionAuditEntry,
  SessionDeviceDeps,
  Tx,
} from "./session-device-types";

const DE = schema.deliveryEndpoints;

export function createDbEndpointLink(): EndpointLinkPort {
  return {
    async linkedPushSessionIds(tx, userId, sessionIds) {
      if (sessionIds.length === 0) return new Set();
      const rows = await tx
        .select({ sessionId: DE.sessionId })
        .from(DE)
        .where(
          and(
            eq(DE.userId, userId),
            eq(DE.channel, "push"),
            eq(DE.verificationStatus, "verified"),
            inArray(DE.sessionId, [...sessionIds]),
          ),
        );
      return new Set(rows.flatMap((r) => (r.sessionId === null ? [] : [r.sessionId])));
    },

    // Every channel a session registered, not only push: the link is the session's, and an sms/email endpoint it registered is just as dead.
    async expireForSession(tx, userId, sessionId) {
      const expired = await tx
        .update(DE)
        .set({ verificationStatus: "expired" })
        .where(
          and(
            eq(DE.userId, userId),
            eq(DE.sessionId, sessionId),
            ne(DE.verificationStatus, "expired"),
          ),
        )
        .returning({ id: DE.id });
      return expired.length;
    },
  };
}

async function writeAudit(tx: Tx, entry: SessionAuditEntry): Promise<void> {
  const revoked = entry.action === "m36.session.revoked";
  await audit(
    tx as unknown as AuditExecutor,
    {
      organizationId: entry.organizationId,
      userId: entry.actorUserId,
      actorKind: "user",
      correlationId: crypto.randomUUID(),
    },
    {
      eventType: entry.action,
      resourceKind: revoked ? "session" : "user",
      resourceId: revoked ? entry.sessionId : entry.targetUserId,
      outcome: "success",
      severity: revoked && entry.byAdmin ? "warn" : "info",
      retentionClass: "compliance",
      context: {
        targetUserId: entry.targetUserId,
        byAdmin: entry.byAdmin,
        ...(entry.current === undefined ? {} : { current: entry.current }),
        ...(entry.endpointsExpired === undefined
          ? {}
          : { endpointsExpired: entry.endpointsExpired }),
        ...(entry.count === undefined ? {} : { count: entry.count }),
      },
    },
  );
}

export interface SessionDeviceBindingInput {
  readonly db: DbClient;
  /** Closes the session's sockets on every api node (the Valkey emitter); absent when realtime is off: there are no sockets to close. */
  readonly disconnectSession?: ((sessionId: string) => Promise<void>) | undefined;
  readonly warn?: SessionDeviceDeps["warn"];
}

export function buildSessionDeviceService(input: SessionDeviceBindingInput): SessionDeviceService {
  return createSessionDeviceService({
    transact: (scope, fn) => withOrgContext(input.db, scope, fn),
    sessions: createStaffSessionStore(),
    endpoints: createDbEndpointLink(),
    audit: writeAudit,
    ...(input.disconnectSession ? { disconnectSession: input.disconnectSession } : {}),
    ...(input.warn ? { warn: input.warn } : {}),
  });
}
