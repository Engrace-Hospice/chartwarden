// apps/backend/src/modules/04-audit/audit/audit-meta.ts — M4-T06 audit-of-audit meta event
// (M4 spec §2.6, §10.4 "elevated/cross-tenant read logs meta").
//
// Reading the audit log is itself an accountable action: when an ELEVATED or CROSS-TENANT actor
// queries `audit_event`, M4 records an `audit.elevated_access` meta-event so the watchers are
// themselves watched (insider-threat control, §8.4 STRIDE). A routine org-scoped Compliance read
// is NOT meta-logged (it would drown the signal); only platform-role / cross-tenant reads are.
// The full append-only integrity verification + hash-chain seal are the integrity layer (M4-T11);
// this is just the read-side meta-event the query routes emit.
//
// Like every audit write, it goes through the mandated @wardenx/audit `audit()` surface (the
// field denylist runs there) — never a direct `audit_event` insert.
import { type AuditContext, type AuditExecutor, audit } from "@wardenx/audit";

/** Role prefix that marks a WardenX platform/cross-tenant actor (vs. a tenant member). */
const PLATFORM_ROLE_PREFIX = "platform";

/** The M4 audit-of-audit meta event types (system `audit.*` namespace, §2.3 / D9). */
export const AUDIT_META_EVENTS = {
  /** An elevated / cross-tenant read of the audit log (§2.6, §10.4). */
  elevatedAccess: "audit.elevated_access",
} as const;

/**
 * True when this audit read is ELEVATED: the actor holds a WardenX platform role, or the read
 * targets an organization other than the actor's own (cross-tenant). Such reads flow through M3
 * break-glass + tenant consent (§4.5) and are always meta-logged.
 */
export function isElevatedAuditRead(
  roles: readonly string[],
  actorOrgId: string,
  targetOrgId?: string | null,
): boolean {
  if (roles.some((r) => r.startsWith(PLATFORM_ROLE_PREFIX))) return true;
  return typeof targetOrgId === "string" && targetOrgId !== actorOrgId;
}

/**
 * Record the `audit.elevated_access` meta-event for one elevated/cross-tenant audit read. `query`
 * is a short, PHI-free descriptor of what was read (e.g. the route path) recorded in `context`.
 */
export async function auditElevatedAccess(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { query: string; targetOrgId?: string | null },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: AUDIT_META_EVENTS.elevatedAccess,
    resourceKind: "audit_event",
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    context: { query: input.query, targetOrgId: input.targetOrgId ?? null },
  });
}
