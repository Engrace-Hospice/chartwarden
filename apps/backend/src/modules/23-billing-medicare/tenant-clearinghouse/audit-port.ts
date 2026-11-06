// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/audit-port.ts — the field-level audit row of a tenant's own
// clearinghouse change. The row-level write-audit trigger on `tenant_clearinghouse_config` records THAT the row changed (and, in
// its context, that the sealed secret did); it cannot say WHICH fields the person chose to change or WHO in the tenant did it
// (the actor there is the session user only). This port adds that, the way the platform operator's lane records its own:
// field NAMES and codes, never a value, in the SAME transaction as the change. M23 may not write `audit_event` itself (only
// `@chartwarden/audit` may), so the composition root binds the port over the sanctioned helper (`m23-clearinghouse-audit.ts`).
import type { DbClient } from "@chartwarden/db";

export const CLEARINGHOUSE_AUDIT_EVENTS = {
  put: "m23.tenant_clearinghouse.changed",
  baaRecorded: "m23.tenant_clearinghouse.baa_recorded",
  verified: "m23.tenant_clearinghouse.verified",
  activated: "m23.tenant_clearinghouse.activated",
} as const;
export type ClearinghouseAuditEvent =
  (typeof CLEARINGHOUSE_AUDIT_EVENTS)[keyof typeof CLEARINGHOUSE_AUDIT_EVENTS];

export interface ClearinghouseAuditEntry {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly eventType: ClearinghouseAuditEvent;
  /** The config row's id. */
  readonly resourceId: string;
  /** Names of the fields the change touched (never values). */
  readonly changedFields: readonly string[];
  /** Non-sensitive facts (a code, a status, an outcome). */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
  readonly request?: {
    readonly correlationId?: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
  };
}

export interface ClearinghouseAuditPort {
  record(tx: DbClient, entry: ClearinghouseAuditEntry): Promise<void>;
}
