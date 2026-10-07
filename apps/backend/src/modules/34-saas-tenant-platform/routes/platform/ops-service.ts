// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/ops-service.ts - M34 GAP-164.
//
// The platform-ops read/skip surface the §4.1 table specs but the first build deferred:
//   - GET  /platform/dsar-export-jobs                       (cross-tenant DSAR list with SLA filtering)
//   - GET  /platform/tenants/:orgSlug/onboarding            (a tenant's full task list + current step)
//   - POST /platform/tenants/:orgSlug/onboarding/:taskId/skip (platform-ops skip with a recorded rationale)
// One small service with an in-memory twin (slice/inject tests) and a Drizzle twin that runs every call inside
// ONE audited `withPlatformContext` transaction (F03/F09). The DSAR list is PHI-minimal by construction: it
// projects job identity, status and SLA facts only - never the patient id, the requestor-verification evidence
// or the bundle handles.
import { type DbClient, schema } from "@wardenx/db";
import { OnboardingRepository } from "@wardenx/saas-tenant-platform";
import { type PlatformBypassAuditor, withPlatformContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError } from "@wardenx/types";
import { and, eq, sql } from "drizzle-orm";
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

export interface PlatformOnboardingTaskView {
  readonly id: string;
  readonly templateKey: string;
  readonly status: string;
  readonly isCanonical: boolean;
  readonly canonicalOrder: number | null;
  readonly dueAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly blockerReason: string | null;
  /** Present only on a skipped task: the platform-ops rationale and actor. */
  readonly skipRationale: string | null;
}

export interface PlatformOnboardingView {
  readonly tenantAccountId: string;
  readonly orgSlug: string;
  readonly tenantStatus: string;
  /** The first canonical task (by order) that is not yet done or skipped; null when all settled. */
  readonly currentStep: string | null;
  readonly tasks: readonly PlatformOnboardingTaskView[];
}

export interface PlatformOpsActor {
  readonly userId: string;
  readonly membershipId: string;
}

export interface PlatformOpsService {
  listDsarJobs(
    filter: PlatformDsarFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<PlatformDsarJobView>>;
  getOnboarding(orgSlug: string): Promise<PlatformOnboardingView>;
  skipOnboardingTask(
    orgSlug: string,
    taskId: string,
    actor: PlatformOpsActor,
    skipRationale: string,
  ): Promise<PlatformOnboardingTaskView>;
}

/** PURE - the first canonical step not yet settled (the machine's `currentStep`). */
export function currentOnboardingStep(
  tasks: readonly Pick<
    PlatformOnboardingTaskView,
    "templateKey" | "status" | "isCanonical" | "canonicalOrder"
  >[],
): string | null {
  const open = tasks
    .filter((t) => t.isCanonical && t.status !== "done" && t.status !== "skipped")
    .sort((a, b) => (a.canonicalOrder ?? 0) - (b.canonicalOrder ?? 0));
  return open[0]?.templateKey ?? null;
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

/** The statuses a platform-ops skip may act on (a settled task is refused, never silently rewritten). */
export const SKIPPABLE_TASK_STATUSES = ["pending", "in_progress", "blocked"] as const;

// ── in-memory twin ───────────────────────────────────────────────────────────────────────────────────

export interface InMemoryPlatformOpsSeed {
  readonly dsarJobs?: readonly PlatformDsarJobView[];
  readonly onboarding?: readonly (PlatformOnboardingView & { readonly organizationId?: string })[];
}

export function createInMemoryPlatformOpsService(
  seed: InMemoryPlatformOpsSeed = {},
  now: () => Date = () => new Date(),
): { service: PlatformOpsService; skips: readonly { taskId: string; actor: PlatformOpsActor }[] } {
  const dsar = [...(seed.dsarJobs ?? [])];
  const onboarding = new Map((seed.onboarding ?? []).map((o) => [o.orgSlug, { ...o }]));
  const skips: { taskId: string; actor: PlatformOpsActor }[] = [];
  return {
    skips,
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
      async getOnboarding(orgSlug) {
        const o = onboarding.get(orgSlug);
        if (!o) throw new NotFoundError("tenant", orgSlug);
        return { ...o, currentStep: currentOnboardingStep(o.tasks) };
      },
      async skipOnboardingTask(orgSlug, taskId, actor, skipRationale) {
        const o = onboarding.get(orgSlug);
        const task = o?.tasks.find((t) => t.id === taskId);
        if (!o || !task) throw new NotFoundError("onboarding_task", taskId);
        if (!(SKIPPABLE_TASK_STATUSES as readonly string[]).includes(task.status)) {
          throw new ConflictError(`a ${task.status} task cannot be skipped`);
        }
        const skipped: PlatformOnboardingTaskView = {
          ...task,
          status: "skipped",
          skipRationale,
        };
        onboarding.set(orgSlug, {
          ...o,
          tasks: o.tasks.map((t) => (t.id === taskId ? skipped : t)),
        });
        skips.push({ taskId, actor });
        void now;
        return skipped;
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

  const loadAccount = async (tx: DbClient, orgSlug: string) => {
    const [row] = await tx
      .select({ account: schema.tenantAccount, slug: schema.organizations.slug })
      .from(schema.tenantAccount)
      .innerJoin(
        schema.organizations,
        eq(schema.tenantAccount.organizationId, schema.organizations.id),
      )
      .where(eq(schema.organizations.slug, orgSlug))
      .limit(1);
    if (!row) throw new NotFoundError("tenant", orgSlug);
    return row;
  };

  const taskViews = async (
    tx: DbClient,
    tenantAccountId: string,
  ): Promise<PlatformOnboardingTaskView[]> => {
    const repo = new OnboardingRepository(tx);
    const [templates, tasks] = await Promise.all([
      repo.listTemplates(),
      repo.listTasksByTenant(tenantAccountId),
    ]);
    const byKey = new Map(templates.map((t) => [t.key, t]));
    return tasks.map((t) => taskView(t, byKey.get(t.templateKey)));
  };

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
            JOIN organization o ON o.id = j.organization_id
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

    async getOnboarding(orgSlug) {
      return inPlatform("platform-ops tenant onboarding read", async (tx) => {
        const { account, slug } = await loadAccount(tx, orgSlug);
        const tasks = await taskViews(tx, account.id);
        return {
          tenantAccountId: account.id,
          orgSlug: slug,
          tenantStatus: account.status,
          currentStep: currentOnboardingStep(tasks),
          tasks,
        };
      });
    },

    async skipOnboardingTask(orgSlug, taskId, actor, skipRationale) {
      return inPlatform("platform-ops onboarding skip", async (tx) => {
        const { account } = await loadAccount(tx, orgSlug);
        const T = schema.onboardingTask;
        // Scope the task to THIS tenant (a task id from another tenant is a 404, never a cross-tenant write).
        const [task] = await tx
          .select()
          .from(T)
          .where(and(eq(T.id, taskId), eq(T.tenantAccountId, account.id)))
          .limit(1);
        if (!task) throw new NotFoundError("onboarding_task", taskId);
        if (!(SKIPPABLE_TASK_STATUSES as readonly string[]).includes(task.status)) {
          throw new ConflictError(`a ${task.status} task cannot be skipped`);
        }
        const evidence = {
          ...((task.completionEvidence as Record<string, unknown>) ?? {}),
          skip: {
            rationale: skipRationale,
            skippedByMembershipId: actor.membershipId,
            skippedByUserId: actor.userId,
            skippedAt: now().toISOString(),
          },
        };
        // Guard on the status we read so a racing complete/skip leaves exactly one winner, and assert the
        // row count: an update that matched nothing is a conflict, not a success.
        const updated = await tx
          .update(T)
          .set({ status: "skipped", blockerReason: null, completionEvidence: evidence })
          .where(and(eq(T.id, task.id), eq(T.status, task.status)))
          .returning();
        const row = updated[0];
        if (!row)
          throw new ConflictError("the onboarding task changed concurrently; reload and retry");
        const [template] = await new OnboardingRepository(tx)
          .listTemplates()
          .then((ts) => ts.filter((t) => t.key === row.templateKey));
        return taskView(row, template);
      });
    },
  };
}

function taskView(
  t: schema.OnboardingTask,
  template: { isCanonical: boolean; canonicalOrder: number | null } | undefined,
): PlatformOnboardingTaskView {
  const skip = (t.completionEvidence as { skip?: { rationale?: string } } | null)?.skip;
  return {
    id: t.id,
    templateKey: t.templateKey,
    status: t.status,
    isCanonical: template?.isCanonical ?? false,
    canonicalOrder: template?.canonicalOrder ?? null,
    dueAt: iso(t.dueAt),
    startedAt: iso(t.startedAt),
    completedAt: iso(t.completedAt),
    blockerReason: t.blockerReason,
    skipRationale: t.status === "skipped" ? (skip?.rationale ?? null) : null,
  };
}
