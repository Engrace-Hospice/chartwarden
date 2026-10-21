// apps/backend/src/modules/02-identity/audit/auth-event-audit.ts — the M4-backed sink for the M2 §8.1
// authentication trail (GAP-002 / GAP-004).
//
// `@chartwarden/auth` classifies each Better Auth request into an {@link AuthAuditEvent}; this file persists it
// through the mandated @chartwarden/audit surface, never a direct `audit_event` insert:
//   - an event with a bound organization (logout, 2FA, passkey, session revoke from an org-bound session) is
//     written ORG-scoped under `withOrgContext`, so the tenant's audit read surface shows it with its actor;
//   - a pre-org event (login, failed login, lockout, password reset) has no tenant yet and goes through the
//     SECURITY DEFINER platform writer (migration 0187). The acting user then rides in `context`, because
//     that writer hardcodes a null actor column.
// Payloads hold ids, hashes and ip prefixes only (see auth-audit.ts in @chartwarden/auth).
import { type AuditContext, type AuditExecutor, audit, auditPlatformEvent } from "@chartwarden/audit";
import type { AuthAuditEvent, AuthAuditSink } from "@chartwarden/auth";
import type { PlatformAuditExecutor } from "@chartwarden/audit";
import { withOrgContext } from "@chartwarden/tenancy";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Structural slice of the Drizzle client the sink needs: platform writes + `withOrgContext`. */
export type AuthAuditDb = PlatformAuditExecutor & Parameters<typeof withOrgContext>[0];

export interface AuthAuditSinkDeps {
  readonly db: AuthAuditDb;
  /** Correlation id minted per event (the bridge has no request context of its own). */
  readonly newCorrelationId?: () => string;
}

const resourceOf = (event: AuthAuditEvent): { kind: string; id?: string } => {
  if (event.sessionId !== undefined) return { kind: "session", id: event.sessionId };
  if (event.userId !== undefined) return { kind: "user", id: event.userId };
  return { kind: "credential" };
};

/** Build the production sink. Throws propagate to the bridge's `onAuditError` (logged, never fatal). */
export function createAuthAuditSink(deps: AuthAuditSinkDeps): AuthAuditSink {
  const correlation = deps.newCorrelationId ?? (() => crypto.randomUUID());
  return async (event) => {
    const resource = resourceOf(event);
    const resourceId = resource.id !== undefined && UUID_SHAPE.test(resource.id) ? resource.id : undefined;
    const context = {
      ...event.context,
      ipPrefix: event.ipPrefix,
      ...(event.userId === undefined ? {} : { userId: event.userId }),
      ...(resourceId === undefined && resource.id !== undefined ? { resourceRef: resource.id } : {}),
    };
    const severity = event.severity;
    if (event.organizationId !== undefined) {
      const ctx: AuditContext = {
        organizationId: event.organizationId,
        userId: event.userId ?? null,
        actorKind: "user",
        correlationId: correlation(),
        ...(event.userAgent === undefined ? {} : { userAgent: event.userAgent }),
      };
      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: event.userId ?? "" },
        (tx) =>
          audit(tx as unknown as AuditExecutor, ctx, {
            eventType: event.eventType,
            resourceKind: resource.kind,
            ...(resourceId === undefined ? {} : { resourceId }),
            outcome: event.outcome,
            severity,
            retentionClass: "compliance",
            context,
          }),
      );
      return;
    }
    await auditPlatformEvent(deps.db, {
      eventType: event.eventType,
      resourceKind: resource.kind,
      ...(resourceId === undefined ? {} : { resourceId }),
      outcome: event.outcome,
      severity,
      correlationId: correlation(),
      retentionClass: "compliance",
      context,
    });
  };
}
