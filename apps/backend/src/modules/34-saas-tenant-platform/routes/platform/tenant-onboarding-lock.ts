// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/tenant-onboarding-lock.ts — the advisory lock that
// makes "the tenant is still onboarding" hold for the whole of a platform operator's onboarding-data write.
//
// A write reads `tenant_account.status` and then writes rows; the app role holds no UPDATE on `tenant_account`, so it
// cannot `FOR SHARE` the row. Instead every such write takes the SHARED lock below before it reads the status, and
// anything that moves a tenant OUT of provisioning/onboarding (the activation sweep, `transitionStatus`) takes the
// EXCLUSIVE lock on the same key. Writers do not block each other; an activation waits for in-flight writes to commit,
// and a write that starts after it sees `active` and answers 409. Both are transaction-scoped: nothing to release.
import { type SQL, sql } from "drizzle-orm";

/** The only statuses in which a platform operator may enter data for a tenant. */
export const ONBOARDING_WRITABLE_STATUSES: ReadonlySet<string> = new Set([
  "provisioning",
  "onboarding",
]);

/** Structural view of a Drizzle transaction: it can execute a SQL fragment (the tenant or the platform pool's). */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

const keyOf = (organizationId: string): SQL =>
  sql`hashtextextended(${`tenant-onboarding:${organizationId}`}::text, 0)`;

/** Shared: an onboarding-data write holds it from before its status read until its transaction ends. */
export const lockTenantOnboardingShared = (tx: SqlExecutor, organizationId: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${keyOf(organizationId)})`);

/** Exclusive: taken by whatever moves the tenant out of provisioning/onboarding; waits for in-flight writes. */
export const lockTenantOnboardingExclusive = (tx: SqlExecutor, organizationId: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(${keyOf(organizationId)})`);
