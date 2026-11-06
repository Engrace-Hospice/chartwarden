// apps/backend/src/modules/02-identity/organization-lifecycle.ts — §11 D19 org lifecycle (#205 hard
// half). The real admin capability the M35 spec's own worked example names: "a `platform_admin`
// suspends the org via M2 admin route" (§11 D19 example). Before this, `organization.status` had NO
// UPDATE anywhere in the codebase — the enum only ever took its INSERT-time default (`created`) — so
// M35's four `m2.organization.*` / `m2.session.created` subscriptions had no producer at all (#205).
//
// Deliberately a SMALL, self-contained transition graph — not the M34 declarative-effect-list machine
// (packages/saas-tenant-platform/src/services/lifecycle-effects.ts). `organization.status` is a plain
// 4-value enum with exactly three real effects per transition (status write, session revocation,
// outbox publish), so a switch is more honest than a generalized engine three states don't need. See
// M34's own effect list for what happens when the generalized version's executor silently drops a
// kind it doesn't handle (apps/backend/src/modules/34-saas-tenant-platform/routes/platform/
// service-drizzle.ts) — the fix there is the cautionary precedent for building this one narrowly.
//
// AUTH-TIME ENFORCEMENT (the other half of "suspend" actually meaning something): suspend/close revoke
// every session already bound to the org in the SAME transaction (a plain DELETE — `session` is
// NON_ORG_SCOPED, migration 0001, so this needs no RLS context of its own); `select-organization`
// (routes/identity-routes.ts) additionally refuses to bind a FRESH session to a non-`active` org via
// the injected `OrganizationStatusReader` (identity-ports.ts) — closing the direction session revocation
// alone cannot: a suspended org's user retrying sign-in afterward.
import type { AuditContext } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import { auditOrganizationTransition } from "./audit/identity-audit";

export type OrganizationLifecycleStatus = "created" | "active" | "suspended" | "closed";
export type OrganizationLifecycleEvent = "activate" | "suspend" | "close";

/** The §11 D19 transition graph. `closed` is terminal — mirrors M34's own offboarding (not reversible). */
const ORGANIZATION_LIFECYCLE_GRAPH: Readonly<
  Record<OrganizationLifecycleStatus, readonly OrganizationLifecycleEvent[]>
> = {
  created: ["activate"],
  active: ["suspend", "close"],
  suspended: ["activate", "close"],
  closed: [],
};

const OUTBOX_EVENT_FOR: Readonly<Record<OrganizationLifecycleEvent, string>> = {
  activate: "m2.organization.activated",
  suspend: "m2.organization.suspended",
  close: "m2.organization.closed",
};

const AUDIT_EVENT_FOR = {
  activate: "m2.organization.activated",
  suspend: "m2.organization.suspended",
  close: "m2.organization.closed",
} as const;

const nextOrganizationStatus = (
  from: OrganizationLifecycleStatus,
  event: OrganizationLifecycleEvent,
): OrganizationLifecycleStatus => {
  if (!ORGANIZATION_LIFECYCLE_GRAPH[from].includes(event)) {
    throw new ChartWardenError(
      "ILLEGAL_ORGANIZATION_TRANSITION",
      `organization cannot '${event}' from '${from}'`,
      409,
    );
  }
  return event === "activate" ? "active" : event === "suspend" ? "suspended" : "closed";
};

/** The raw, tx-taking outbox publisher (the `bindCallerModule(txOutboxPublisher, "m2")` shape — the
 *  M28 `FhirWriteOutboxPort` precedent: declared locally so this file takes no edge on `index.ts`). */
export interface OrganizationLifecycleOutboxPort {
  publish(
    tx: DbClient,
    input: {
      eventName: string;
      payload: Record<string, unknown>;
      organizationId: string | null;
      aggregateKind: string;
      aggregateId: string;
    },
  ): Promise<void>;
}

/**
 * "Is this organization's tenant still provisioning or onboarding?" - the one M34 fact an activation needs. Injected by the
 * composition root (M2 does not import M34). While it holds, `activate` is refused: the organization opens only through the
 * two-party go-live approval (M34), never through this writer on one operator's say-so.
 */
export interface OrganizationActivationGuard {
  isOnboarding(organizationId: string): Promise<boolean>;
}

export interface OrganizationTransitionResult {
  readonly status: OrganizationLifecycleStatus;
  readonly sessionsRevoked: number;
}

export interface OrganizationLifecycleWriter {
  transition(
    organizationId: string,
    event: OrganizationLifecycleEvent,
    ctx: {
      readonly reason: string;
      readonly actorUserId: string;
      readonly actorMembershipId: string;
    },
  ): Promise<OrganizationTransitionResult>;
  getStatus(organizationId: string): Promise<OrganizationLifecycleStatus | null>;
}

/**
 * The `organization.status` reader (the authenticate gate and `select-organization` use it; it never writes). Its own factory, so a
 * caller that only reads is not handed a writer and does not have to name an activation guard it has no use for.
 */
export function createDrizzleOrganizationStatusReader(
  db: DbClient,
): (organizationId: string) => Promise<OrganizationLifecycleStatus | null> {
  return async (organizationId) => {
    const [row] = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
      tx
        .select({ status: schema.organizations.status })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, organizationId))
        .limit(1),
    );
    return row ? (row.status as OrganizationLifecycleStatus) : null;
  };
}

export interface OrganizationLifecycleDeps {
  /**
   * Refuses `activate` while the tenant is onboarding (go-live is the only way in). REQUIRED: a writer built without it would
   * let one operator open an onboarding organization, so every caller names it (a test that does not exercise it passes an
   * explicit `{ isOnboarding: async () => false }`).
   */
  readonly activationGuard: OrganizationActivationGuard;
  /** `outbox` omitted → the transition still lands and the event is dropped (the M28 `NOOP_FHIR_OUTBOX` precedent). */
  readonly outbox?: OrganizationLifecycleOutboxPort;
  /** Called AFTER the transition commits (ADR-0049 D6: evicts the tenant-host cache so a suspended or closed
   *  tenant's host stops resolving at once, not after the cache TTL). */
  readonly onTransitioned?: (organizationId: string) => void;
}

/** Build the production Drizzle writer. */
export function createDrizzleOrganizationLifecycleWriter(
  db: DbClient,
  deps: OrganizationLifecycleDeps,
): OrganizationLifecycleWriter {
  const { activationGuard, outbox, onTransitioned } = deps;
  return {
    async transition(organizationId, event, ctx) {
      // Before the transaction: a refused activation takes no connection and writes nothing (no status, audit or outbox row).
      if (event === "activate" && (await activationGuard.isOnboarding(organizationId))) {
        throw new ChartWardenError(
          "GO_LIVE_TWO_PARTY_REQUIRED",
          "this organization's tenant is still provisioning or onboarding: it opens only when the compliance officer attests and a different platform operator approves go-live",
          409,
        );
      }
      const result = await withOrgContext(
        db,
        { organizationId, userId: ctx.actorUserId },
        async (tx) => {
          const [row] = await tx
            .select({ status: schema.organizations.status })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, organizationId))
            .limit(1);
          if (!row) throw new NotFoundError("organization");
          const from = row.status as OrganizationLifecycleStatus;
          const to = nextOrganizationStatus(from, event);

          await tx
            .update(schema.organizations)
            .set({ status: to, updatedAt: new Date() })
            .where(eq(schema.organizations.id, organizationId));

          // Sessions ALREADY bound to this org, revoked immediately (§11 D19) — `select-organization`
          // (identity-routes.ts) is the OTHER half, refusing a fresh bind to a non-active org.
          let sessionsRevoked = 0;
          if (event === "suspend" || event === "close") {
            const deleted = await tx
              .delete(schema.sessions)
              .where(eq(schema.sessions.activeOrganizationId, organizationId))
              .returning({ id: schema.sessions.id });
            sessionsRevoked = deleted.length;
          }

          const occurredAt = new Date().toISOString();
          const auditCtx: AuditContext = {
            organizationId,
            userId: ctx.actorUserId,
            actorKind: "user",
            correlationId: `m2-org-lifecycle-${organizationId}-${occurredAt}`,
          };
          await auditOrganizationTransition(tx, auditCtx, {
            eventType: AUDIT_EVENT_FOR[event],
            organizationId,
            fromStatus: from,
            toStatus: to,
            reason: ctx.reason,
            sessionsRevoked,
          });

          await outbox?.publish(tx, {
            eventName: OUTBOX_EVENT_FOR[event],
            payload: {
              organizationId,
              reason: ctx.reason,
              actorMembershipId: ctx.actorMembershipId,
              occurredAt,
            },
            organizationId,
            aggregateKind: "organization",
            aggregateId: organizationId,
          });

          return { status: to, sessionsRevoked };
        },
      );
      onTransitioned?.(organizationId);
      return result;
    },

    getStatus: createDrizzleOrganizationStatusReader(db),
  };
}

/**
 * The go-live approval's half (M34): activate an organization that is still `created`. Any other status is left alone, on
 * purpose: an organization an operator already activated by hand is live (nothing to do), and a suspended or closed one is not
 * this caller's to reopen. A concurrent activation that lands first (ILLEGAL_ORGANIZATION_TRANSITION from `active`) is the same
 * outcome, not a failure. Returns what it did so the caller can log it.
 */
export async function activateCreatedOrganization(
  writer: Pick<OrganizationLifecycleWriter, "getStatus" | "transition">,
  organizationId: string,
  ctx: {
    readonly reason: string;
    readonly actorUserId: string;
    readonly actorMembershipId: string;
  },
): Promise<"activated" | "unchanged"> {
  if ((await writer.getStatus(organizationId)) !== "created") return "unchanged";
  try {
    await writer.transition(organizationId, "activate", ctx);
    return "activated";
  } catch (error) {
    if (error instanceof ChartWardenError && error.code === "ILLEGAL_ORGANIZATION_TRANSITION") {
      return "unchanged";
    }
    throw error;
  }
}
