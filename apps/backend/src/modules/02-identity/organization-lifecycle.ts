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
import type { AuditContext } from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
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
    throw new WardenXError(
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

/** Build the production Drizzle writer. `outbox` omitted → transition still lands, event is dropped
 *  (the M28 `NOOP_FHIR_OUTBOX` precedent), matching every other optional M2 outbox port. */
export function createDrizzleOrganizationLifecycleWriter(
  db: DbClient,
  outbox?: OrganizationLifecycleOutboxPort,
): OrganizationLifecycleWriter {
  return {
    async transition(organizationId, event, ctx) {
      return withOrgContext(db, { organizationId, userId: ctx.actorUserId }, async (tx) => {
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
      });
    },

    async getStatus(organizationId) {
      const [row] = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select({ status: schema.organizations.status })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, organizationId))
          .limit(1),
      );
      return row ? (row.status as OrganizationLifecycleStatus) : null;
    },
  };
}
