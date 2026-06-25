// @wardenx/saas-tenant-platform · repositories — tenant export data port: `tenant_export_job` +
// `tenant_export_job_event` (M34 §3.7).
//
// The org-scoped side of the DSAR/tenant-export split (D9): an NDJSON-per-table + PDFs + manifest.json
// archive, tar.gz packaged, 7-day presigned URL (D19), used for migration / BAA-termination / compliance
// audit / surveyor requests. This repo inserts the job, drives its status, records the bundle artifact
// handles (MinIO key, sha256, size, module inventory, presigned-URL expiry, download stamp), and appends
// the per-module shard-receipt event ledger. The bundle assembly + SEC-052 download controls live in the
// worker / route.
import { type DbClient, schema } from "@wardenx/db";
import { type SQL, and, asc, desc, eq, isNotNull, lt, or } from "drizzle-orm";

const J = schema.tenantExportJob;
const E = schema.tenantExportJobEvent;

/** Keyset cursor for the per-module event ledger (newest-first by (occurredAt, id)). */
export interface TenantExportEventCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

function eventOlderThan(cursor?: TenantExportEventCursor): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(E.occurredAt, cursor.occurredAt),
    and(eq(E.occurredAt, cursor.occurredAt), lt(E.id, cursor.id)),
  );
}

/** Data port for the org-scoped tenant export job + its event ledger. */
export class TenantExportRepository {
  constructor(private readonly db: DbClient) {}

  // ── tenant_export_job ──────────────────────────────────────────────────────────────────────

  /** Create a tenant export job (status 'requested'; purpose captured per SEC-052 justification). */
  async create(values: schema.NewTenantExportJob): Promise<schema.TenantExportJob> {
    const [row] = await this.db.insert(J).values(values).returning();
    if (!row) throw new Error("tenant_export_job insert returned no row");
    return row;
  }

  /** Fetch a tenant export job by id, or `null`. */
  async findById(id: string): Promise<schema.TenantExportJob | null> {
    const [row] = await this.db.select().from(J).where(eq(J.id, id)).limit(1);
    return row ?? null;
  }

  /** The org's tenant export jobs, newest-first. RLS scopes to the active org. */
  async listByOrganization(): Promise<readonly schema.TenantExportJob[]> {
    return this.db.select().from(J).orderBy(desc(J.requestedAt));
  }

  /** Jobs by status (e.g. 'fulfilled' bundles whose MinIO object the 7-day sweep should reap). */
  async listByStatus(
    status: schema.TenantExportJob["status"],
  ): Promise<readonly schema.TenantExportJob[]> {
    return this.db.select().from(J).where(eq(J.status, status)).orderBy(desc(J.requestedAt));
  }

  /**
   * Fulfilled jobs with a presigned-URL expiry, soonest-expiring first — drives the 7-day MinIO
   * object-expiry reaper (object auto-deletes after 7 days from fulfillment).
   */
  async listByPresignedExpiry(): Promise<readonly schema.TenantExportJob[]> {
    return this.db
      .select()
      .from(J)
      .where(isNotNull(J.bundlePresignedUrlExpiresAt))
      .orderBy(asc(J.bundlePresignedUrlExpiresAt));
  }

  /**
   * Patch the job's status and any of the bundle-artifact fields. The matching
   * `tenant_export_job_event` ledger row is appended by the service in the same transaction.
   */
  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewTenantExportJob,
        | "status"
        | "fulfilledAt"
        | "bundleMinioObjectKey"
        | "bundleSha256"
        | "bundleSizeBytes"
        | "bundleModuleInventory"
        | "bundlePresignedUrlExpiresAt"
        | "bundleDownloadedAt"
      >
    >,
  ): Promise<schema.TenantExportJob> {
    const [row] = await this.db.update(J).set(patch).where(eq(J.id, id)).returning();
    if (!row) throw new Error(`tenant_export_job ${id} not found for update`);
    return row;
  }

  // ── tenant_export_job_event ─────────────────────────────────────────────────────────────────

  /** Append a per-module shard-receipt event row for the export job. */
  async appendEvent(values: schema.NewTenantExportJobEvent): Promise<schema.TenantExportJobEvent> {
    const [row] = await this.db.insert(E).values(values).returning();
    if (!row) throw new Error("tenant_export_job_event insert returned no row");
    return row;
  }

  /** Newest-first keyset page of a tenant export job's event ledger. */
  async listEvents(
    tenantExportJobId: string,
    opts: { limit?: number; cursor?: TenantExportEventCursor } = {},
  ): Promise<readonly schema.TenantExportJobEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.db
      .select()
      .from(E)
      .where(and(eq(E.tenantExportJobId, tenantExportJobId), eventOlderThan(opts.cursor)))
      .orderBy(desc(E.occurredAt), desc(E.id))
      .limit(limit);
  }
}
