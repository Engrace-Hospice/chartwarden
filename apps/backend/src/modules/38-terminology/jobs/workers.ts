import {
  type EmbedderPort,
  type EmbeddingStorePort,
  type ExpansionWriterPort,
  type LoadVersionDeps,
  type LoadableSystemId,
  type LoaderLogger,
  type ScheduledSourceDeps,
  isLoadableSystem,
  refreshExpansionsForSystem,
  runLoadVersion,
  runRefreshEmbeddings,
  runScheduledActivation,
  runScheduledSource,
} from "@wardenx/terminology-loader";
// apps/backend/src/modules/38-terminology/jobs/workers.ts — BullMQ registration for the nine §4.3 workers
// (GAP-108): load_version, refresh_expansions, refresh_embeddings, tenant_deprecation_scan and the five
// scheduled_* source jobs, plus the repeatable schedules. The processors are the loader package's orchestrators
// (pure over ports) and the tenant scan; this file only binds them to BullMQ.
//
// ONE concurrency lane for the load queue: activation takes a per-system advisory lock in the database anyway,
// and two loads of one system must never interleave. `terminology.scheduled_icd10cm` carries TWO repeatable jobs
// (`dry_run` Sep 15 — fetch + stage only; `activate` Oct 1 — resume the staged version), per §4.3.
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import {
  ICD10CM_ACTIVATE_JOB,
  ICD10CM_DRY_RUN_JOB,
  TERMINOLOGY_JOB_ATTEMPTS,
  TERMINOLOGY_JOB_BACKOFF_MS,
  TERMINOLOGY_JOB_SCHEDULES,
  TERMINOLOGY_QUEUES,
  parseLoadVersionJobData,
  parseSystemJobData,
  parseTenantScanJobData,
} from "./queues";
import { type ScanProgress, type TenantScanDeps, runTenantDeprecationScanJob } from "./tenant-scan";

/** Systems the `scheduled_other` catch-all walks (HCPCS quarterly, CARC/RARC ad hoc, CVX, NDC, revenue seed, PCS). */
export const SCHEDULED_OTHER_SYSTEMS = [
  "hcpcs",
  "icd10pcs",
  "carc",
  "rarc",
  "cvx",
  "ndc",
  "revenue",
] as const satisfies readonly LoadableSystemId[];

export interface M38WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly load: LoadVersionDeps;
  readonly scheduled: ScheduledSourceDeps;
  readonly expansions: { readonly writer: ExpansionWriterPort };
  readonly embeddings: {
    readonly store: EmbeddingStorePort;
    readonly embedder: EmbedderPort;
    /** Queue the next slice when the per-run cap left concepts un-embedded. */
    continueRun(system: LoadableSystemId, versionId: string | null): Promise<void>;
  };
  readonly scan: TenantScanDeps;
  /** Mark a version `failed` when its load job exhausted its retries (the version must not sit `loading` forever). */
  readonly failVersion: (versionId: string, reason: string) => Promise<void>;
  readonly log: LoaderLogger;
}

function requireLoadable(system: string): LoadableSystemId {
  if (!isLoadableSystem(system))
    throw new Error(`terminology job: '${system}' is not a loadable system`);
  return system;
}

/** BullMQ keeps `progress` across attempts; completed orgs are recorded there so a retry skips them. */
function scanProgressOf(job: Job): ScanProgress {
  const stored = job.progress as { completedOrgs?: unknown } | number;
  const done = new Set<string>(
    typeof stored === "object" && Array.isArray(stored.completedOrgs)
      ? (stored.completedOrgs as string[])
      : [],
  );
  return {
    completedOrgs: done,
    async markCompleted(organizationId) {
      done.add(organizationId);
      await job.updateProgress({ completedOrgs: [...done] });
    },
  };
}

async function runScheduledOther(deps: M38WorkerDeps): Promise<Record<string, string>> {
  const outcomes: Record<string, string> = {};
  const failures: unknown[] = [];
  for (const system of SCHEDULED_OTHER_SYSTEMS) {
    try {
      const out = await runScheduledSource(deps.scheduled, system, {
        mode: "current",
        activate: true,
      });
      outcomes[system] = out.outcome === "skipped" ? `skipped:${out.reason}` : "enqueued";
    } catch (err) {
      failures.push(err);
      outcomes[system] = "failed";
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `terminology.scheduled_other: ${failures.length} source(s) failed`,
    );
  return outcomes;
}

function embeddingsProcessor(deps: M38WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    const data = parseSystemJobData(job.data);
    const system = requireLoadable(data.system);
    const out = await runRefreshEmbeddings(
      { store: deps.embeddings.store, embedder: deps.embeddings.embedder, log: deps.log },
      system,
    );
    if (out.outcome === "embedder_unavailable") {
      // §7.10: ops are paged when an embedding refresh fails — a thrown error reaches the DLQ alert.
      throw new Error("terminology.refresh_embeddings: no embeddings backend is bound");
    }
    if (out.hasMore) {
      // The per-run cap stopped the walk with concepts left: queue a continuation (a fresh job id — the original
      // job's deterministic id is still occupied while this one runs).
      await deps.embeddings.continueRun(system, data.versionId);
    }
    return out;
  };
}

/** Construct the nine live workers. */
export function registerM38Workers(deps: M38WorkerDeps): Worker[] {
  const lane = { connection: deps.connection, concurrency: 1 } as const;

  const load = new Worker(
    TERMINOLOGY_QUEUES.loadVersion,
    async (job) => runLoadVersion(deps.load, parseLoadVersionJobData(job.data)),
    lane,
  );
  // A load whose retries are exhausted must not leave its version `loading` forever.
  load.on("failed", (job, err) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const versionId = (job.data as { versionId?: unknown } | undefined)?.versionId;
    if (typeof versionId !== "string") return;
    deps
      .failVersion(versionId, `retries exhausted: ${err.message}`.slice(0, 500))
      .catch((e) =>
        deps.log.error(
          { versionId, reason: e instanceof Error ? e.message : String(e) },
          "could not mark an exhausted load failed",
        ),
      );
  });

  const scheduledSimple = (queue: string, system: LoadableSystemId): Worker =>
    new Worker(
      queue,
      async () => runScheduledSource(deps.scheduled, system, { mode: "current", activate: true }),
      lane,
    );

  return [
    load,
    new Worker(
      TERMINOLOGY_QUEUES.refreshExpansions,
      async (job) =>
        refreshExpansionsForSystem(
          requireLoadable(parseSystemJobData(job.data).system),
          deps.expansions.writer,
          deps.log,
        ),
      lane,
    ),
    new Worker(TERMINOLOGY_QUEUES.refreshEmbeddings, embeddingsProcessor(deps), lane),
    new Worker(
      TERMINOLOGY_QUEUES.tenantDeprecationScan,
      async (job) =>
        runTenantDeprecationScanJob(
          deps.scan,
          parseTenantScanJobData(job.data),
          scanProgressOf(job),
        ),
      lane,
    ),
    new Worker(
      TERMINOLOGY_QUEUES.scheduledIcd10cm,
      async (job) =>
        job.name === ICD10CM_ACTIVATE_JOB
          ? runScheduledActivation(deps.scheduled, "icd10cm")
          : runScheduledSource(deps.scheduled, "icd10cm", { mode: "dry_run", activate: false }),
      lane,
    ),
    scheduledSimple(TERMINOLOGY_QUEUES.scheduledSnomed, "snomed"),
    scheduledSimple(TERMINOLOGY_QUEUES.scheduledRxnorm, "rxnorm"),
    scheduledSimple(TERMINOLOGY_QUEUES.scheduledLoinc, "loinc"),
    new Worker(TERMINOLOGY_QUEUES.scheduledOther, async () => runScheduledOther(deps), lane),
  ];
}

/** Register the repeatable schedules (3 attempts, exponential backoff). Returns the queues to close. */
export async function scheduleM38Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const entries = [
    {
      queue: TERMINOLOGY_QUEUES.scheduledIcd10cm,
      name: ICD10CM_DRY_RUN_JOB,
      pattern: TERMINOLOGY_JOB_SCHEDULES.scheduledIcd10cm,
    },
    {
      queue: TERMINOLOGY_QUEUES.scheduledIcd10cm,
      name: ICD10CM_ACTIVATE_JOB,
      pattern: TERMINOLOGY_JOB_SCHEDULES.scheduledIcd10cmActivate,
    },
    {
      queue: TERMINOLOGY_QUEUES.scheduledSnomed,
      name: "scheduled",
      pattern: TERMINOLOGY_JOB_SCHEDULES.scheduledSnomed,
    },
    {
      queue: TERMINOLOGY_QUEUES.scheduledRxnorm,
      name: "scheduled",
      pattern: TERMINOLOGY_JOB_SCHEDULES.scheduledRxnorm,
    },
    {
      queue: TERMINOLOGY_QUEUES.scheduledLoinc,
      name: "scheduled",
      pattern: TERMINOLOGY_JOB_SCHEDULES.scheduledLoinc,
    },
    {
      queue: TERMINOLOGY_QUEUES.scheduledOther,
      name: "scheduled",
      pattern: TERMINOLOGY_JOB_SCHEDULES.scheduledOther,
    },
  ] as const;
  const queues = new Map<string, Queue>();
  for (const e of entries) {
    const queue = queues.get(e.queue) ?? new Queue(e.queue, { connection });
    queues.set(e.queue, queue);
    await queue.add(
      e.name,
      {},
      {
        repeat: { pattern: e.pattern },
        attempts: TERMINOLOGY_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: TERMINOLOGY_JOB_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }
  return [...queues.values()];
}
