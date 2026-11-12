// apps/backend/src/modules/34-saas-tenant-platform/jobs/support-session-ports.ts — slice 7 (7S).
//
// THE ONE PLACE the support-session service's side-effect ports are bound (audit, outbox, alerts, the member-to-person
// lookup), per transaction. Three callers share it, so what the sweep did with inline ports is what a start, a manual close, an
// elevation, a tenant's revoke and an operator's resolve now do too:
//   * the platform route service (start / elevate / close) on the PLATFORM transaction,
//   * the tenant route service (issue / revoke) on the tenant's own ORG transaction,
//   * the close sweep (jobs/platform-sweeps-worker.ts) on its platform transaction.
// Before this file the platform service's ports were deny-stubs (`M34InfraPortUnbound`), so no support session could ever be
// started in production; the sweep alone held real ports. A port that is not bound at the composition root is a boot-visible
// fact (`apps/backend/src/index.ts` builds `createSupportSessionPorts` once and hands the result to all three).
//
// What each port does, and what it must not:
//   audit   — a CRITICAL audit_event through the SECURITY DEFINER platform writer (`auditPlatformEvent`: callable from both the
//             platform and the tenant role). It is a platform-scoped row (no organization column), so the tenant, the session and
//             the grant are named in its context. `actorKind` and `supportSessionId` are stamped into that context; the true
//             `actor_kind` column on PHI reads is a later slice's (it needs the enum value and a consumer of the session seam).
//   outbox  — the catalog-validating publisher, in the same transaction, for the TENANT's organization (the grant's), pinned
//             to the aggregate (`support_session` or `support_consent_grant`).
//   alerts  — the M36 emitter, `warn`, matched on the seeded rules' event type. A failed emit is logged and never thrown: an
//             alert must not undo the close or the grant it reports. Nothing in an alert names the operator.
//   members — the user behind a membership, for the person-level distinct-actor check.
import { auditPlatformEvent } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import {
  type NowPort,
  type SupportGrantOperations,
  SupportRepository,
  type SupportSessionServiceDeps,
  createSupportGrantOperations,
} from "@chartwarden/saas-tenant-platform";
import { eq } from "drizzle-orm";

/** The catalog-validating outbox publisher shape (the same one the platform sweeps are handed). */
export interface SupportPortOutbox {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The M36 emitter slice the support alerts go through. */
export interface SupportPortAlerts {
  emit(
    orgId: string,
    input: {
      eventType: string;
      payload: Record<string, unknown>;
      severity: "info" | "warn" | "critical";
      correlationId: string;
    },
  ): Promise<unknown>;
}

export interface SupportSessionPortDeps {
  readonly outbox: SupportPortOutbox;
  readonly alerts: SupportPortAlerts;
  readonly now: NowPort;
  readonly patientBelongsToOrganization?: (
    organizationId: string,
    patientId: string,
  ) => Promise<boolean>;
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
}

/** What the composition root builds once: the clock and the per-transaction dependency bundle. */
export interface SupportSessionPorts {
  readonly now: NowPort;
  /** The tx-bound repository + the four ports + the clock, for one transaction. */
  bind(tx: DbClient): SupportSessionServiceDeps;
}

const GRANT_EVENT_PREFIX = "m34.support_consent_grant.";

/** Build the ports once; call `bind(tx)` inside each transaction that runs a support service. */
export function createSupportSessionPorts(deps: SupportSessionPortDeps): SupportSessionPorts {
  return {
    now: deps.now,
    bind: (tx) => ({
      repo: new SupportRepository(tx),
      now: deps.now,
      audit: {
        emitCriticalAudit: async (event) => {
          await auditPlatformEvent(tx, {
            eventType: event.action,
            resourceKind: "support_session",
            resourceId: event.supportSessionId,
            outcome: "success",
            severity: "critical",
            correlationId: `m34-${event.action}-${event.supportSessionId}`,
            context: {
              organizationId: event.organizationId,
              actorMembershipId: event.actorMembershipId,
              actorKind: event.actorKind,
              supportSessionId: event.supportSessionId,
              supportConsentGrantId: event.supportConsentGrantId,
              ...(event.context ?? {}),
            },
          });
        },
      },
      outbox: {
        publish: async (eventName, payload, organizationId) => {
          const grantEvent = eventName.startsWith(GRANT_EVENT_PREFIX);
          await deps.outbox.publish(tx, {
            eventName,
            payload,
            organizationId,
            aggregateKind: grantEvent ? "support_consent_grant" : "support_session",
            aggregateId: String(grantEvent ? payload.grantId : payload.sessionId),
          });
        },
      },
      alerts: {
        emitAlert: async (alert) => {
          // The alert must never undo the close or the grant it reports: a failed emit is logged, not thrown.
          try {
            await deps.alerts.emit(alert.organizationId, {
              eventType: alert.alertKey,
              payload: { tenantAccountId: alert.tenantAccountId, ...(alert.context ?? {}) },
              severity: "warn",
              correlationId: `m34-${alert.alertKey}-${String(alert.context?.sessionId ?? alert.context?.grantId)}`,
            });
          } catch (error) {
            deps.warn?.("m34.support_session: alert failed", {
              organizationId: alert.organizationId,
              alertKey: alert.alertKey,
              errorClass: error instanceof Error ? error.name : "UnknownError",
            });
          }
        },
      },
      members: {
        userIdOf: async (membershipId) => {
          const [row] = await tx
            .select({ userId: schema.memberships.userId })
            .from(schema.memberships)
            .where(eq(schema.memberships.id, membershipId))
            .limit(1);
          return row?.userId ?? null;
        },
      },
      patients: {
        allBelongToOrganization: async (organizationId, patientIds) => {
          if (!deps.patientBelongsToOrganization) return false;
          for (const patientId of new Set(patientIds)) {
            if (!(await deps.patientBelongsToOrganization(organizationId, patientId))) return false;
          }
          return true;
        },
      },
    }),
  };
}

/** The three grant operations bound to these ports: what the tenant routes and the help requests (7B) are handed. */
export function createSupportGrantOperationsOver(
  ports: SupportSessionPorts,
): SupportGrantOperations {
  return createSupportGrantOperations({ depsFor: ports.bind, now: ports.now });
}
