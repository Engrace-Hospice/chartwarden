// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/ops-service.ts - M34 GAP-164.
//
// The platform-ops DSAR read the §4.1 table specs but the first build deferred:
//   - GET  /platform/dsar-export-jobs                       (cross-tenant DSAR list with SLA filtering)
// (The onboarding read and skip moved to onboarding/wizard-service.ts with the wizard.) One small service with an
// in-memory twin (slice/inject tests) and a Drizzle twin that runs every call inside ONE audited
// `withPlatformContext` transaction (F03/F09). The DSAR list is PHI-minimal by construction: it projects job identity,
// status and SLA facts only - never the patient id, the requestor-verification evidence or the bundle handles.
import { type DbClient, schema } from "@chartwarden/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { type CursorPage, decodeCursor, encodeCursor, pageSizeOf } from "./concurrency";

export const DSAR_OPEN_STATUSES = [
  "requested",
  "generating",
  "review_pending",
  "extended",
] as const;

export interface PlatformDsarJobView {
  readonly id: string;
  readonly organizationId: string;
  readonly orgSlug: string;
  readonly status: string;
  readonly requestSource: string;
  readonly requestedAt: string;
  readonly slaDueAt: string;
  readonly extendedUntil: string | null;
  readonly fulfilledAt: string | null;
  /** The job is still open and its (extended) SLA has passed. */
  readonly slaBreached: boolean;
}

export interface PlatformDsarFilter {
  readonly status?: string;
  readonly organizationId?: string;
  /** true => only open jobs past their SLA; false => only those within it. */
  readonly slaBreached?: boolean;
}

export interface PlatformOpsService {
  listDsarJobs(
    filter: PlatformDsarFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<PlatformDsarJobView>>;
}

/** PURE - open and past the (extended) SLA. */
export function isDsarSlaBreached(
  job: { status: string; slaDueAt: Date; extendedUntil: Date | null },
  now: Date,
): boolean {
  if (!(DSAR_OPEN_STATUSES as readonly string[]).includes(job.status)) return false;
  const due = job.extendedUntil ?? job.slaDueAt;
  return due.getTime() < now.getTime();
}

// ── in-memory twin ───────────────────────────────────────────────────────────────────────────────────

export interface InMemoryPlatformOpsSeed {
  readonly dsarJobs?: readonly PlatformDsarJobView[];
}

export function createInMemoryPlatformOpsService(
  seed: InMemoryPlatformOpsSeed = {},
  now: () => Date = () => new Date(),
): { service: PlatformOpsService } {
  const dsar = [...(seed.dsarJobs ?? [])];
  return {
    service: {
      async listDsarJobs(filter, _cursor, limit) {
        const size = pageSizeOf(limit);
        const rows = dsar
          .filter((j) => (filter.status ? j.status === filter.status : true))
          .filter((j) =>
            filter.organizationId ? j.organizationId === filter.organizationId : true,
          )
          .filter((j) =>
            filter.slaBreached === undefined ? true : j.slaBreached === filter.slaBreached,
          )
          .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
        return { items: rows.slice(0, size), nextCursor: null, hasMore: rows.length > size };
      },
    },
  };
}

// ── Drizzle twin ─────────────────────────────────────────────────────────────────────────────────────

export interface DrizzlePlatformOpsDeps {
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly platformJobId: string;
  readonly now?: () => Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

type Rows<T> = { rows?: T[] };

export function createDrizzlePlatformOpsService(deps: DrizzlePlatformOpsDeps): PlatformOpsService {
  const now = deps.now ?? (() => new Date());
  const inPlatform = <T>(reason: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withPlatformContext<DbClient, T>(
      deps.platformDb,
      { jobId: deps.platformJobId, reason, crossTenant: true },
      deps.auditBypass,
      fn,
    );

  return {
    async listDsarJobs(filter, cursor, limit) {
      return inPlatform("platform-ops cross-tenant DSAR list", async (tx) => {
        const size = pageSizeOf(limit);
        const after = cursor ? decodeCursor(cursor) : null;
        const open = sql.join(
          DSAR_OPEN_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        );
        const res = await tx.execute(sql`
          SELECT j.id, j.organization_id AS "organizationId", o.slug AS "orgSlug", j.status,
                 j.request_source AS "requestSource", j.requested_at AS "requestedAt",
                 j.sla_due_at AS "slaDueAt", j.extended_until AS "extendedUntil",
                 j.fulfilled_at AS "fulfilledAt",
                 to_char(j.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTs",
                 (j.status::text IN (${open}) AND COALESCE(j.extended_until, j.sla_due_at) < ${now().toISOString()}::timestamptz) AS "slaBreached"
            FROM dsar_export_job j
            JOIN ${schema.organizations} o ON o.id = j.organization_id
           WHERE (${filter.status ?? null}::text IS NULL OR j.status::text = ${filter.status ?? null})
             AND (${filter.organizationId ?? null}::uuid IS NULL OR j.organization_id = ${filter.organizationId ?? null}::uuid)
             AND (${after?.createdAt ?? null}::timestamptz IS NULL
                  OR (j.requested_at, j.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
             AND (${filter.slaBreached ?? null}::boolean IS NULL
                  OR (j.status::text IN (${open}) AND COALESCE(j.extended_until, j.sla_due_at) < ${now().toISOString()}::timestamptz) = ${filter.slaBreached ?? null}::boolean)
           ORDER BY j.requested_at DESC, j.id DESC
           LIMIT ${size + 1}`);
        const rows =
          (
            res as unknown as Rows<
              Record<string, unknown> & { id: string; cursorTs: string; slaBreached: boolean }
            >
          ).rows ?? [];
        const page = rows.slice(0, size);
        const last = page[page.length - 1];
        const hasMore = rows.length > size;
        return {
          items: page.map(
            (r): PlatformDsarJobView => ({
              id: r.id,
              organizationId: String(r.organizationId),
              orgSlug: String(r.orgSlug),
              status: String(r.status),
              requestSource: String(r.requestSource),
              requestedAt: new Date(String(r.requestedAt)).toISOString(),
              slaDueAt: new Date(String(r.slaDueAt)).toISOString(),
              extendedUntil: r.extendedUntil
                ? new Date(String(r.extendedUntil)).toISOString()
                : null,
              fulfilledAt: r.fulfilledAt ? new Date(String(r.fulfilledAt)).toISOString() : null,
              slaBreached: Boolean(r.slaBreached),
            }),
          ),
          nextCursor:
            hasMore && last ? encodeCursor({ createdAt: last.cursorTs, id: last.id }) : null,
          hasMore,
        };
      });
    },
  };
}
