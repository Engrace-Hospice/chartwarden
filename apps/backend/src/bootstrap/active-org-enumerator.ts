// apps/backend/src/bootstrap/active-org-enumerator.ts — the platform-scoped ACTIVE-ORG enumerator
// (#107 item 2; the M2 org-reader-under-withPlatformContext the cron fan-outs bind).
//
// Background workers that fan ORG-scoped jobs out across every tenant (M30's §4.8 crons today; reusable by
// any future platform cron) need to list the active orgs WITHOUT a tenant request context. The only sanctioned
// cross-tenant read path is `withPlatformContext` (M1 @chartwarden/tenancy): a GATED (allowlisted jobId), AUDITED
// (PlatformBypassAuditor writes one `platform.bypass_invoked` row per entry), separately-pooled platform
// credential. This helper wraps that path into a tiny `{ listActiveOrgs() }` reader the composition root binds
// into a worker's deps. It lives in the bootstrap layer (M1 composition) because it needs the platform pool +
// the bypass auditor + the `organizations` schema — none of which a feature-module package may assemble.
//
// "Active" = organization_status 'active' (the org-lifecycle activated state; 'created'/'suspended'/'closed'
// are excluded — a cron must not fan out to a not-yet-activated or suspended tenant).
import { type DbClient, schema } from "@chartwarden/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import { inArray, sql } from "drizzle-orm";

/** One active org the enumeration returns (structurally the M30 `ActiveOrg` / any cron's fan-out unit). */
export interface ActiveOrgRow {
  readonly organizationId: string;
}

/** The reader the composition root injects into a platform cron's deps (structural ActiveOrgListPort). */
export interface ActiveOrgEnumerator {
  listActiveOrgs(): Promise<readonly ActiveOrgRow[]>;
}

export interface ActiveOrgEnumeratorDeps {
  /** The separately-pooled platform login role (the cross-tenant credential; NOT the tenant pool). */
  readonly platformDb: DbClient | undefined;
  /** Audits every withPlatformContext entry (fail-closed: an unaudited bypass throws, never serves). */
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  /** The registered platform job id the caller is allowlisted under (wire*Tenancy registered it at boot). */
  readonly jobId: string;
  /** Recorded in the bypass audit event. */
  readonly reason?: string;
  /** Defaults to ['active']; the outbox relay also includes created/suspended orgs with pending events. */
  readonly statuses?: readonly ("created" | "active" | "suspended" | "closed")[];
  /**
   * Opt-in. When set, the transaction's `statement_timeout` is capped to this many ms BEFORE the bypass audit and the org
   * read run, so a stuck statement is cancelled by PostgreSQL itself and its pooled connection is released, instead of
   * outliving a caller that stopped waiting for it (CW-RUST-M02 P2 prerequisite 6: the parity sweep). Unset = no cap,
   * exactly as for every other cron that binds this enumerator.
   */
  readonly statementTimeoutMs?: number;
}

/**
 * Build the active-org enumerator. Each `listActiveOrgs()` enters ONE audited `withPlatformContext` tx under
 * `jobId` (refused with PlatformContextDeniedError if the job is not allowlisted) and reads the org ids whose
 * status is 'active'. Returns a structural ActiveOrgListPort the composition root passes as a worker dep.
 */
export function buildActiveOrgEnumerator(deps: ActiveOrgEnumeratorDeps): ActiveOrgEnumerator {
  const platformDb = deps.platformDb;
  const capMs = deps.statementTimeoutMs;
  // The cap goes first, so it covers the audit write as well as the read (both run in the one transaction).
  const auditBypass: PlatformBypassAuditor<DbClient> =
    capMs === undefined
      ? deps.auditBypass
      : async (tx, event) => {
          await tx.execute(sql`SELECT set_config('statement_timeout', ${String(capMs)}, true)`);
          await deps.auditBypass(tx, event);
        };
  return {
    listActiveOrgs: () => {
      // Fail LOUD, never an empty list: without DATABASE_PLATFORM_URL the only pool left is the tenant pool, on which
      // `organization` RLS hides every row — an enumerator bound there "succeeds" with zero orgs and the cron
      // silently does nothing (the M14 packets-cron incident). A thrown error surfaces as a failed job / DLQ alert.
      if (!platformDb) {
        return Promise.reject(
          new Error(
            `active-org enumeration for job '${deps.jobId}' requires the platform pool (DATABASE_PLATFORM_URL); refusing to enumerate on the tenant pool`,
          ),
        );
      }
      return withPlatformContext<DbClient, readonly ActiveOrgRow[]>(
        platformDb,
        {
          jobId: deps.jobId,
          reason: deps.reason ?? "active-org enumeration (platform cron fan-out)",
          crossTenant: true,
        },
        auditBypass,
        (tx) =>
          tx
            .select({ organizationId: schema.organizations.id })
            .from(schema.organizations)
            .where(inArray(schema.organizations.status, [...(deps.statuses ?? ["active"])])),
      );
    },
  };
}
