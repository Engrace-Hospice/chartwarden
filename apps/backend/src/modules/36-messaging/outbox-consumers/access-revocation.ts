// apps/backend/src/modules/36-messaging/outbox-consumers/access-revocation.ts — WP 1.1 / WP 1.4 (audit F3,
// ADR-0054 item 6 + addendum A1/A3): a person who loses their M2 membership, is suspended, or is offboarded must
// lose M36 access NOW, not when the next poll or request notices.
//
//   event (outbox)                 -> action
//   m2.membership.revoked          -> soft-remove the user's channel memberships in that org, drop their sockets
//   m2.user.deactivated (org)      -> soft-remove the user's channel memberships in that org, drop their sockets
//   m2.user.deactivated (platform) -> drop their sockets (no org to act in; canViewChannel already denies a
//                                     deactivated user, so leftover rows are hygiene, not an access path)
//   m2.membership.suspended        -> drop their sockets only (rows stay: a reinstated member resumes; reads are
//                                     already denied while suspended by canViewChannel -> isActiveMessagingUser)
//
// TENANT: from the envelope `event.organizationId`, NEVER the payload. `userId` on revoked/suspended is optional in
// the catalog (rows published before ADR-0054 A3 lack it); such a row is a no-op, because the identity route already
// reaped that user's sessions in the same request. Every action is idempotent, so a redelivery converges.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
  PlatformDispatchableOutboxEvent,
  PlatformOutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_ACCESS_REVOCATION_CONSUMER = "m36.access-revocation" as const;
export const M36_ACCESS_REVOCATION_PLATFORM_CONSUMER = "m36.access-revocation.platform" as const;

export const M36_ACCESS_REVOCATION_EVENT_TYPES = [
  "m2.membership.suspended",
  "m2.membership.revoked",
  "m2.user.deactivated",
] as const;

export interface AccessRevocationDeps {
  /** Soft-remove every active `channel_member` row for the user in the org (M36 DB adapter). */
  readonly endChannelMemberships: (orgId: string, userId: string) => Promise<unknown>;
  /** Drop the user's live sockets IN THIS ORG on every api node (ADR-0054 item 6). Absent while realtime is not wired. */
  readonly disconnectUser?: (orgId: string, userId: string) => Promise<void>;
  /**
   * Drop every socket of the person in any org. Used for a platform-scoped deactivation, which the M2 route publishes
   * under the OPERATOR's bound org (so it lands here, not on the platform consumer): the person's own orgs are not on the event.
   */
  readonly disconnectAccount?: (userId: string) => Promise<void>;
}

export interface PlatformAccessRevocationDeps {
  /** Drop every socket of the person, whatever org it was opened for. */
  readonly disconnectAccount?: (userId: string) => Promise<void>;
}

function optionalString(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = optionalString(p, key);
  if (!v) throw new Error(`${M36_ACCESS_REVOCATION_CONSUMER}: ${eventName} payload has no ${key}`);
  return v;
}

async function handleEvent(
  event: DispatchableOutboxEvent,
  deps: AccessRevocationDeps,
): Promise<void> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.eventType) {
    case "m2.membership.suspended": {
      const userId = optionalString(p, "userId");
      // Only the suspend arm drops access; the same event name never carries a reinstate (that is its own event).
      if (userId && p.to === "suspended") await deps.disconnectUser?.(event.organizationId, userId);
      return;
    }
    case "m2.membership.revoked": {
      const userId = optionalString(p, "userId");
      if (!userId) return;
      await deps.endChannelMemberships(event.organizationId, userId);
      await deps.disconnectUser?.(event.organizationId, userId);
      return;
    }
    case "m2.user.deactivated": {
      const userId = requireString(p, "userId", event.eventType);
      await deps.endChannelMemberships(event.organizationId, userId);
      if (p.scope === "platform") await deps.disconnectAccount?.(userId);
      else await deps.disconnectUser?.(event.organizationId, userId);
      return;
    }
    default:
      throw new Error(`${M36_ACCESS_REVOCATION_CONSUMER}: unexpected event ${event.eventType}`);
  }
}

export function buildM36AccessRevocationConsumer(
  deps: AccessRevocationDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M36_ACCESS_REVOCATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_ACCESS_REVOCATION_EVENT_TYPES,
    handle: (event) => handleEvent(event, deps),
  };
}

/** Platform-wide offboarding (`organization_id IS NULL`): no org to end memberships in, so sockets only. */
export function buildM36AccessRevocationPlatformConsumer(
  deps: PlatformAccessRevocationDeps,
): PlatformOutboxConsumerBinding {
  return {
    consumerName: M36_ACCESS_REVOCATION_PLATFORM_CONSUMER,
    consumerModule: "m36",
    eventTypes: ["m2.user.deactivated"],
    handle: async (event: PlatformDispatchableOutboxEvent) => {
      const userId = requireString(
        (event.payload ?? {}) as Record<string, unknown>,
        "userId",
        event.eventType,
      );
      await deps.disconnectAccount?.(userId);
    },
  };
}
