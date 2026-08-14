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
import { type SQL, and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";

const J = schema.tenantExportJob;
const E = schema.tenantExportJobEvent;

/** Keyset cursor for the per-module event ledger (newest-first by (occurredAt, id)). */
export interface TenantExportEventCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

/** Keyset cursor for the platform-ops job list (newest-first by (requestedAt, id)). */
export interface TenantExportJobCursor {
  readonly requestedAt: Date;
  readonly id: string;
}

function eventOlderThan(cursor?: TenantExportEventCursor): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(E.occurredAt, cursor.occurredAt),
    and(eq(E.occurredAt, cursor.occurredAt), lt(E.id, cursor.id)),
  );
}

function jobOlderThan(cursor?: TenantExportJobCursor): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(J.requestedAt, cursor.requestedAt),
    and(eq(J.requestedAt, cursor.requestedAt), lt(J.id, cursor.id)),
  );
}

/**
 * The SEC-052 held predicate (GAP-098): an `oversized_hold` event with no LATER `oversized_approved`.
 * Paired at the call site with `status = 'generating'`, this is exactly the two-part test the approve
 * route makes on its single-row read, so a job this predicate calls held is one that route accepts.
 *
 * ⚠️ THE SUPERSEDER SET IS RESTRICTED TO `oversized_approved` ON PURPOSE, and the first draft that
 * compared against ANY newer event was WRONG — caught live. `markGenerating` and
 * `holdForOversizedApproval` run in the SAME per-job transaction, and `occurred_at` defaults to the
 * transaction timestamp, so the `generating` and `oversized_hold` rows routinely carry an IDENTICAL
 * timestamp. The `(occurred_at, id)` tiebreak then falls to a random v4 uuid — and roughly half the
 * time the `generating` row sorts "newer" than the hold, so a genuinely held bundle silently drops off
 * the queue. Only an approval can end a hold, so only an approval is a candidate superseder; an
 * approval that ties a hold to the microsecond is not a LATER approval.
 */
function heldForOversizedApproval(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${E} h
    WHERE h.tenant_export_job_id = ${J.id}
      AND h.event_kind = 'oversized_hold'
      AND NOT EXISTS (
        SELECT 1 FROM ${E} released
        WHERE released.tenant_export_job_id = ${J.id}
          AND released.event_kind = 'oversized_approved'
          AND (released.occurred_at, released.id) > (h.occurred_at, h.id)
      )
  )`;
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
   * CROSS-TENANT keyset page for the §4.1 platform-ops list (GAP-098). Runs under
   * `withPlatformContext` — RLS is bypassed there, so this is the ONE read on this table that spans
   * organizations, and it is named for that rather than reusing `listByOrganization` (whose name
   * would then be a lie about what it returns depending on the caller's context).
   *
   * `heldOnly` is the reason this method exists at all. A SEC-052 oversized hold does NOT get its own
   * status — the job stays `generating` and the hold lives in the ledger (GAP-094), so a status filter
   * alone cannot distinguish "still assembling" from "assembled and waiting for a co-signer". It is
   * BOTH conditions together (`status = 'generating'` AND {@link heldForOversizedApproval}), which is
   * the same pair the approve route checks, so a job this list calls held is one that route accepts.
   */
  async listPlatformPage(opts: {
    organizationId?: string;
    status?: schema.TenantExportJob["status"];
    heldOnly?: boolean;
    cursor?: TenantExportJobCursor;
    limit?: number;
  }): Promise<readonly schema.TenantExportJob[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.db
      .select()
      .from(J)
      .where(
        and(
          opts.organizationId ? eq(J.organizationId, opts.organizationId) : undefined,
          opts.status ? eq(J.status, opts.status) : undefined,
          // Both halves, matching the approve route: an approval flips status OFF `generating`, so the
          // status conjunct alone already excludes every released job; the ledger conjunct is what
          // separates a held bundle from one still being assembled.
          opts.heldOnly ? eq(J.status, "generating") : undefined,
          opts.heldOnly ? heldForOversizedApproval() : undefined,
          jobOlderThan(opts.cursor),
        ),
      )
      .orderBy(desc(J.requestedAt), desc(J.id))
      .limit(limit);
  }

  /**
   * The hold state for each of `jobIds` — the newest `oversized_hold` that no `oversized_approved`
   * has superseded, or absent when the job is not held. One batched read, so a page costs two round
   * trips regardless of its length.
   *
   * DERIVED THE SAME WAY {@link heldForOversizedApproval} FILTERS, deliberately: the list's `held`
   * FILTER and the per-row `heldForOversizedApproval` FLAG must never disagree, or a `?held=true`
   * page would render rows labelled "not held". So this reads only the two event kinds that
   * participate and applies the same "no LATER approval" rule — never a plain newest-event-of-any-kind
   * lookup, which the same-transaction timestamp tie would make non-deterministic (see that function).
   */
  async holdStateForJobs(
    jobIds: readonly string[],
  ): Promise<ReadonlyMap<string, schema.TenantExportJobEvent>> {
    if (jobIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(E)
      .where(
        and(
          inArray(E.tenantExportJobId, [...jobIds]),
          inArray(E.eventKind, ["oversized_hold", "oversized_approved"]),
        ),
      )
      .orderBy(desc(E.occurredAt), desc(E.id));
    // Newest-first within each job: the first HOLD wins unless an APPROVAL was seen before it (i.e.
    // is newer). A tie between the two orders by id, matching the SQL predicate's own tiebreak.
    const held = new Map<string, schema.TenantExportJobEvent>();
    const released = new Set<string>();
    for (const row of rows) {
      const job = row.tenantExportJobId;
      if (held.has(job) || released.has(job)) continue;
      if (row.eventKind === "oversized_approved") released.add(job);
      else held.set(job, row);
    }
    return held;
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
