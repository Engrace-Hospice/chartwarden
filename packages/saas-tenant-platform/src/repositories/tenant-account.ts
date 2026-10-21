// @chartwarden/saas-tenant-platform · repositories — `tenant_account` (+ its status-event ledger and
// the platform → first-admin `tenant_invitation`) data port (M34 §3.3, §3.4).
//
// A thin Drizzle reader/writer over the M34-owned tables: the lifecycle service (§2.2) and the
// privileged platform routes (§4.1) call these to insert lifecycle rows, list by org, fetch by id,
// and append the immutable status-event ledger that records every tenant-lifecycle transition.
//
// CONVENTION (mirrors packages/audit drizzle-audit-query + packages/auth rbac/drizzle-store): the
// repo takes the Drizzle client (`SaasDb`) in its constructor and issues plain Drizzle queries; the
// SERVICE layer wraps each call in `withOrgContext` (M1 @chartwarden/tenancy) so Postgres RLS scopes
// every statement to `app.org_id`. The repo therefore accepts either the pooled `DbClient` or a
// transaction handle from `withOrgContext` — both satisfy `SaasDb`. The repo never opens its own
// transaction and never sets RLS GUCs: scoping is the service's job (single home for that rule).
import { type DbClient, schema } from "@chartwarden/db";
import { type SQL, and, desc, eq, lt, or } from "drizzle-orm";

/**
 * The minimal Drizzle surface every M34 repository needs: the pooled client or a transaction handle
 * opened by `withOrgContext`. Typed as `DbClient` so both satisfy it structurally; the service
 * decides which to pass (a `tx` inside `withOrgContext`, or `db` for platform-context jobs).
 */
export type SaasDb = DbClient;

const A = schema.tenantAccount;
const SE = schema.tenantAccountStatusEvent;
const INV = schema.tenantInvitation;

/** A keyset page cursor for the status-event ledger (newest-first by (occurredAt, id)). */
export interface StatusEventCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

/** "strictly older than the cursor" predicate over (occurredAt, id) — stable keyset pagination. */
function olderThan(table: typeof SE, cursor?: StatusEventCursor): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(table.occurredAt, cursor.occurredAt),
    and(eq(table.occurredAt, cursor.occurredAt), lt(table.id, cursor.id)),
  );
}

/**
 * Data port for `tenant_account`, its status-event ledger, and the platform `tenant_invitation`.
 * All reads are org-scoped by the surrounding `withOrgContext`; the platform-ops cross-tenant
 * listing (`listByStatus`) is invoked under `withPlatformContext` by the lifecycle service.
 */
export class TenantAccountRepository {
  constructor(private readonly db: SaasDb) {}

  // ── tenant_account ────────────────────────────────────────────────────────────────────────

  /** Insert a new tenant_account row (lifecycle service, at provisioning). Returns the inserted row. */
  async create(values: schema.NewTenantAccount): Promise<schema.TenantAccount> {
    const [row] = await this.db.insert(A).values(values).returning();
    if (!row) throw new Error("tenant_account insert returned no row");
    return row;
  }

  /** Fetch a tenant_account by its id, or `null`. */
  async findById(id: string): Promise<schema.TenantAccount | null> {
    const [row] = await this.db.select().from(A).where(eq(A.id, id)).limit(1);
    return row ?? null;
  }

  /** Fetch the single tenant_account for an organization (1:1, D1), or `null`. */
  async findByOrganizationId(organizationId: string): Promise<schema.TenantAccount | null> {
    const [row] = await this.db
      .select()
      .from(A)
      .where(eq(A.organizationId, organizationId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Apply a lifecycle status transition: stamp `status` (+ optional lifecycle timestamps and
   * `metadata`) and bump `updatedAt`. The matching `tenant_account_status_event` ledger row is
   * appended separately via {@link appendStatusEvent} in the same transaction by the service.
   */
  async updateStatus(
    id: string,
    patch: Partial<
      Pick<
        schema.NewTenantAccount,
        | "status"
        | "provisionedAt"
        | "activatedAt"
        | "suspendedAt"
        | "offboardingInitiatedAt"
        | "finalExportCompletedAt"
        | "retentionEndsAt"
        | "destroyedAt"
        | "metadata"
      >
    >,
  ): Promise<schema.TenantAccount> {
    const [row] = await this.db
      .update(A)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(A.id, id))
      .returning();
    if (!row) throw new Error(`tenant_account ${id} not found for status update`);
    return row;
  }

  /**
   * Platform-ops cross-tenant listing by lifecycle status (e.g. all `destruction_pending` tenants
   * the shred worker must sweep). Invoked under `withPlatformContext`; RLS is bypassed there, so
   * this is intentionally org-agnostic.
   */
  async listByStatus(
    status: schema.TenantAccount["status"],
  ): Promise<readonly schema.TenantAccount[]> {
    return this.db.select().from(A).where(eq(A.status, status)).orderBy(desc(A.createdAt));
  }

  // ── tenant_account_status_event ───────────────────────────────────────────────────────────

  /** Append an immutable lifecycle-transition row to the status-event ledger. */
  async appendStatusEvent(
    values: schema.NewTenantAccountStatusEvent,
  ): Promise<schema.TenantAccountStatusEvent> {
    const [row] = await this.db.insert(SE).values(values).returning();
    if (!row) throw new Error("tenant_account_status_event insert returned no row");
    return row;
  }

  /** Newest-first keyset page of a tenant's status-event ledger. */
  async listStatusEvents(
    tenantAccountId: string,
    opts: { limit?: number; cursor?: StatusEventCursor } = {},
  ): Promise<readonly schema.TenantAccountStatusEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where = and(eq(SE.tenantAccountId, tenantAccountId), olderThan(SE, opts.cursor));
    return this.db
      .select()
      .from(SE)
      .where(where)
      .orderBy(desc(SE.occurredAt), desc(SE.id))
      .limit(limit);
  }

  // ── tenant_invitation (platform → first-admin; D18) ─────────────────────────────────────────

  /** Issue a platform → first-admin invitation (single-use, one-per-tenant-at-provisioning). */
  async createInvitation(values: schema.NewTenantInvitation): Promise<schema.TenantInvitation> {
    const [row] = await this.db.insert(INV).values(values).returning();
    if (!row) throw new Error("tenant_invitation insert returned no row");
    return row;
  }

  /** Look up an invitation by its SHA256 token hash (the raw token is never persisted). */
  async findInvitationByTokenHash(tokenHash: string): Promise<schema.TenantInvitation | null> {
    const [row] = await this.db.select().from(INV).where(eq(INV.tokenHash, tokenHash)).limit(1);
    return row ?? null;
  }

  /** List a tenant's invitations newest-first (e.g. to mark a prior `pending` invite `expired`). */
  async listInvitations(tenantAccountId: string): Promise<readonly schema.TenantInvitation[]> {
    return this.db
      .select()
      .from(INV)
      .where(eq(INV.tenantAccountId, tenantAccountId))
      .orderBy(desc(INV.issuedAt));
  }

  /** Transition an invitation's status (consume / expire / revoke), stamping the relevant fields. */
  async updateInvitationStatus(
    id: string,
    patch: Partial<Pick<schema.NewTenantInvitation, "status" | "consumedAt" | "consumedByUserId">>,
  ): Promise<schema.TenantInvitation> {
    const [row] = await this.db.update(INV).set(patch).where(eq(INV.id, id)).returning();
    if (!row) throw new Error(`tenant_invitation ${id} not found for status update`);
    return row;
  }
}
