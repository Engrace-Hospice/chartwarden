// apps/backend/src/modules/34-saas-tenant-platform/jobs/bundle-expiry-worker.ts — GAP-163.
//
// The live `tenant.bundle_expiry_sweep` consumer (§3.7 F09 / D19). The cron was scheduled but nothing consumed
// the queue, so DSAR + tenant-export bundles holding PHI were never reaped after their 7-day presigned-URL TTL.
// This binds the package sweep (`runBundleExpirySweep`) over the two export repositories and the object-store
// destroy, ORG-SCOPED: each active org is swept in its own `withOrgContext` (RLS), the same posture as the
// DSAR / tenant-export workers. A failing org is logged and counted — it never starves the rest.
import type { DbClient } from "@chartwarden/db";
import {
  type BundleExpirySweepPorts,
  type BundleExpirySweepResult,
  type BundleExportKind,
  DsarExportRepository,
  TenantExportRepository,
  runBundleExpirySweep,
} from "@chartwarden/saas-tenant-platform";
import { withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { M34_JOB_SCHEDULES, M34_QUEUES } from "./index";

const SYSTEM_USER_ID = "";
const REAP_EVENT_KIND = "bundle_expired_reaped";

interface ExpiringRow {
  readonly id: string;
  readonly bundleMinioObjectKey: string | null;
  readonly bundlePresignedUrlExpiresAt: Date | null;
}

/** The structural slice of the DSAR / tenant-export repositories the sweep needs (fakeable in tests). */
export interface BundleExpiryRepos {
  readonly dsar: {
    listByPresignedExpiry(): Promise<readonly ExpiringRow[]>;
    update(
      id: string,
      patch: { bundleMinioObjectKey: null; bundlePresignedUrlExpiresAt: null },
    ): Promise<unknown>;
    appendEvent(values: {
      organizationId: string;
      dsarExportJobId: string;
      eventKind: string;
    }): Promise<unknown>;
  };
  readonly tenantExport: {
    listByPresignedExpiry(): Promise<readonly ExpiringRow[]>;
    update(
      id: string,
      patch: { bundleMinioObjectKey: null; bundlePresignedUrlExpiresAt: null },
    ): Promise<unknown>;
    appendEvent(values: {
      organizationId: string;
      tenantExportJobId: string;
      eventKind: string;
    }): Promise<unknown>;
  };
}

export interface BundleExpiryPortsArgs {
  readonly organizationId: string;
  readonly repos: BundleExpiryRepos;
  readonly destroyObject: (args: {
    readonly organizationId: string;
    readonly objectKey: string;
  }) => Promise<void>;
  readonly now: () => Date;
}

const CLEARED = { bundleMinioObjectKey: null, bundlePresignedUrlExpiresAt: null } as const;

/** Build the package sweep's ports for ONE org over its (already org-scoped) repositories. */
export function buildBundleExpiryPorts(args: BundleExpiryPortsArgs): BundleExpirySweepPorts {
  const { organizationId, repos } = args;
  const tag = (kind: BundleExportKind, rows: readonly ExpiringRow[]) =>
    rows.map((row) => ({
      jobId: row.id,
      kind,
      presignedUrlExpiresAt: row.bundlePresignedUrlExpiresAt,
      minioObjectKey: row.bundleMinioObjectKey,
    }));
  return {
    now: args.now,
    async listExpiringBundles() {
      const [dsar, tenantExport] = await Promise.all([
        repos.dsar.listByPresignedExpiry(),
        repos.tenantExport.listByPresignedExpiry(),
      ]);
      return [...tag("dsar", dsar), ...tag("tenant_export", tenantExport)];
    },
    deleteBundleObject: (_kind, objectKey) => args.destroyObject({ organizationId, objectKey }),
    async clearBundleArtifact(kind, jobId) {
      await (kind === "dsar" ? repos.dsar : repos.tenantExport).update(jobId, CLEARED);
    },
    async recordReapEvent(kind, jobId) {
      if (kind === "dsar") {
        await repos.dsar.appendEvent({
          organizationId,
          dsarExportJobId: jobId,
          eventKind: REAP_EVENT_KIND,
        });
        return;
      }
      await repos.tenantExport.appendEvent({
        organizationId,
        tenantExportJobId: jobId,
        eventKind: REAP_EVENT_KIND,
      });
    },
  };
}

export interface BundleExpiryRunDeps {
  readonly listActiveOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly sweepOrg: (organizationId: string) => Promise<BundleExpirySweepResult>;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface BundleExpiryRunSummary {
  readonly orgs: number;
  readonly reaped: number;
  readonly failedOrgs: number;
}

/** Sweep every active org; one org's failure is logged + counted and never stops the others. */
export async function runBundleExpiryForAllOrgs(
  deps: BundleExpiryRunDeps,
): Promise<BundleExpiryRunSummary> {
  const orgs = await deps.listActiveOrgs();
  let reaped = 0;
  let failedOrgs = 0;
  for (const { organizationId } of orgs) {
    try {
      reaped += (await deps.sweepOrg(organizationId)).reaped.length;
    } catch (error) {
      failedOrgs += 1;
      deps.warn?.("m34.bundle_expiry_sweep: org sweep failed", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { orgs: orgs.length, reaped, failedOrgs };
}

export interface BundleExpiryWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly listActiveOrgs: BundleExpiryRunDeps["listActiveOrgs"];
  /** The M22 `ObjectStorePort.destroyAllVersions` adapter (composition root; tenant-bucket derived there). */
  readonly destroyObject: BundleExpiryPortsArgs["destroyObject"];
  readonly now?: () => Date;
  readonly warn?: BundleExpiryRunDeps["warn"];
}

/** Construct the `tenant.bundle_expiry_sweep` Worker: one org-scoped sweep per active org per tick. */
export function registerM34BundleExpiryWorker(deps: BundleExpiryWorkerDeps): Worker {
  const now = deps.now ?? (() => new Date());
  const sweepOrg = (organizationId: string): Promise<BundleExpirySweepResult> =>
    withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, (tx) => {
      const client = tx as unknown as DbClient;
      return runBundleExpirySweep(
        buildBundleExpiryPorts({
          organizationId,
          repos: {
            dsar: new DsarExportRepository(client) as unknown as BundleExpiryRepos["dsar"],
            tenantExport: new TenantExportRepository(
              client,
            ) as unknown as BundleExpiryRepos["tenantExport"],
          },
          destroyObject: deps.destroyObject,
          now,
        }),
      );
    });
  return new Worker(
    M34_QUEUES.bundleExpirySweep,
    async () =>
      runBundleExpiryForAllOrgs({
        listActiveOrgs: deps.listActiveOrgs,
        sweepOrg,
        warn: deps.warn,
      }),
    { connection: deps.connection, concurrency: 1 },
  );
}

/**
 * Register the nightly repeatable tick for `tenant.bundle_expiry_sweep` (§4.3). Scheduled on its own — the
 * sibling cron queues (baa / support-session / dsar-sla) have no consumer yet, and scheduling a queue nothing
 * drains only grows its backlog. Returns the schedule `Queue` so the composition root can `close()` it.
 */
export async function scheduleM34BundleExpiryJob(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M34_QUEUES.bundleExpirySweep, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: M34_JOB_SCHEDULES.bundleExpirySweep }, removeOnComplete: true },
  );
  return queue;
}
