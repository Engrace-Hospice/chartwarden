import { registerPlatformJob } from "@wardenx/tenancy";
import { DegradedError } from "@wardenx/types";
// apps/backend/src/modules/27-cost-report/wiring.ts — M27 composition glue (WX-PR-013: the launch-defined
// cost-report workflow slice). Mirrors the M25/M30/M33/M34 wiring.ts precedent: the platform-tenancy
// registration for the §4.8 cron fan-out, PLUS the real `RecomputeEnqueuePort` BullMQ producer the
// already-built `write-service-drizzle.ts` calls (`routes/write-service.ts`'s `RecomputeEnqueuePort`).
//
// Before this file, `buildDrizzleM27WriteService` was never given a `recompute` port, so it fell back to its
// own safe no-op default (`{ enqueue: async () => ({ jobId: randomUUID() }) }`) — every `recompute.enqueue`
// call in the write service (refresh-inputs, allocate/compute-worksheet, validate, submit's ecr-generation)
// returned a well-formed but FAKE accepted-view and enqueued nothing onto BullMQ. Even the two §4.8
// processors that are otherwise fully live-bound (`cost-allocation-recompute`, `validation-run` — both read
// through `buildM27ValidationContext`/`buildM27AllocationInputs`, already wired in `index.ts`) were
// consequently untriggerable from the API. `buildM27RecomputeEnqueue` closes that gap for real.
//
// WIRE-NAME CONTRACT (jobs/queues.ts): the write-service producer enqueues onto the BARE §4.8 queue names
// (`"trial-balance-pull"`, `"allocation-recompute"`, …) — the SAME names `M27_QUEUES` declares and
// `registerM27Workers` (`jobs/m27-jobs.ts`) constructs its `Worker`s against. This producer is the only
// place those two ends meet; it must never invent its own wire names.
//
// ORGANIZATION-ID ENRICHMENT (the m27-jobs.ts TODO this closes): every §4.8 work queue is ORG-scoped — the
// worker opens `withOrgContext(job.data.organizationId)` — but the write-service producer's job payloads
// carry NO `organizationId` field (its dedupe key `${actor.organizationId}:${costReportId}[:…]` carries it
// instead, since the producer is a shared, frozen file this wiring may not edit). This adapter parses the
// org id off the dedupe key's first segment and stamps it onto the BullMQ job `data` before `Queue.add`, so
// the worker's per-job `withOrgContext` resolves correctly without touching the producer call sites.
import type { ConnectionOptions } from "bullmq";
import { Queue } from "bullmq";
import { type DedupeQueueLike, addJobCoalescingInFlight } from "../../bootstrap/queue-dedupe";
import { M27_QUEUES, M27_QUEUE_PARAMS } from "./jobs/queues";
import type { RecomputeEnqueuePort } from "./routes/write-service";

/**
 * The platform job id M27's §4.8 `filing-deadline-scan` cron enters `withPlatformContext` under to enumerate
 * active orgs (the cron fan-out source). Registered on the `@wardenx/tenancy` PLATFORM_CONTEXT_ALLOWLIST
 * (starts empty → fail-closed) by {@link wireM27Tenancy} at boot. The M25/M30/M33/M34 precedent.
 */
export const M27_PLATFORM_JOB_ID = "m27.platform_crons";

/**
 * Register M27's platform job id on the allowlist so `filing-deadline-scan` may enter `withPlatformContext`
 * (idempotent `Set.add`). Called once at boot by the composition root, alongside the sibling `wireMxTenancy`
 * calls. This is the necessary PREREQUISITE for the cron fan-out; it is inert until the integrator also
 * binds `M27WorkerDeps.activeOrgs` (done in `index.ts` over `buildActiveOrgEnumerator`).
 */
export function wireM27Tenancy(): void {
  registerPlatformJob(M27_PLATFORM_JOB_ID);
}

/**
 * Raised by a still-unbound Phase-2D infra port (the fail-closed signal — never a silent no-op).
 *
 * A `DegradedError`, so the caller gets `503 DEGRADED` naming the missing dependency rather than the
 * `500 INTERNAL_ERROR / "An unexpected error occurred"` a bare `Error` collapsed into (F-022 / #55).
 * A deliberately unbound port IS the dependency-unavailable condition `DegradedError` exists for,
 * and the M34 `M34InfraPortUnbound` precedent already took that posture. `reason` is the whole of
 * the caller-facing message — the internal port name stays on `port`, where the log can read it and
 * the response cannot.
 *
 * `component` defaults to the background queue because every current throw site is a queue producer;
 * a future non-queue port passes its own rather than mislabelling itself.
 */
export class M27InfraPortUnbound extends DegradedError {
  constructor(
    public readonly port: string,
    reason: string,
    component = "background-queue",
  ) {
    super(component, reason);
    this.name = "M27InfraPortUnbound";
  }
}

/** Reverse-lookup the §4.8 queue-param catalog entry from the BARE wire name the producer is called with. */
const QUEUE_PARAM_BY_WIRE_NAME = new Map<
  string,
  (typeof M27_QUEUE_PARAMS)[keyof typeof M27_QUEUE_PARAMS]
>(
  (Object.entries(M27_QUEUES) as [keyof typeof M27_QUEUES, string][]).map(([key, wireName]) => [
    wireName,
    M27_QUEUE_PARAMS[key],
  ]),
);

/**
 * Build the `RecomputeEnqueuePort` every §4.1 M27 write-route mutation calls (refresh-inputs, allocate /
 * compute-worksheet, validate, submit's ecr-generation trigger). When a Valkey connection is configured it
 * produces onto the named BullMQ `Queue` — jobId-deduped on the SAME dedupe key the write service already
 * builds (`${queueName}:${dedupeKey}`), so calling the same mutation twice (e.g. a retried "trigger trial
 * balance pull" click) enqueues exactly ONE job, not two (BullMQ's own duplicate-jobId contract — a
 * `Queue.add` with an id that already exists is a no-op until that job completes/is removed). Without a
 * connection it fails CLOSED (a recompute command must never silently drop its enqueue). Mirrors the M30
 * `buildM30RecomputeEnqueue` producer (`modules/30-quality/wiring.ts`).
 */
export function buildM27RecomputeEnqueue(connection: ConnectionOptions | undefined): {
  enqueue: RecomputeEnqueuePort;
  queues: Queue[];
} {
  if (!connection) {
    return {
      enqueue: {
        async enqueue(queueName) {
          throw new M27InfraPortUnbound(
            "recomputeEnqueue",
            `no Valkey connection configured — cannot enqueue '${queueName}' (set the queue connection at boot)`,
          );
        },
      },
      queues: [],
    };
  }
  const cache = new Map<string, Queue>();
  const queueFor = (name: string): Queue => {
    let q = cache.get(name);
    if (!q) {
      q = new Queue(name, { connection });
      cache.set(name, q);
    }
    return q;
  };
  const enqueue: RecomputeEnqueuePort = {
    async enqueue(queueName, dedupeKey, payload) {
      const organizationId = dedupeKey.split(":")[0];
      if (!organizationId) {
        throw new Error(
          `M27 recompute enqueue: dedupe key '${dedupeKey}' carries no organizationId segment`,
        );
      }
      const param = QUEUE_PARAM_BY_WIRE_NAME.get(queueName);
      // BullMQ rejects a custom jobId containing ':' (reserved for its own Redis key namespacing) — the
      // write-service's dedupe keys are colon-delimited (`${orgId}:${costReportId}[:…]`), so the composite
      // id is sanitized here rather than by touching the (shared, frozen) producer call sites.
      const jobId = `${queueName}__${dedupeKey}`.replace(/:/g, "__");
      // GAP-042: a finished job with the same id is cleared first, otherwise the retained hash made
      // every re-trigger a silent no-op. In-flight jobs still coalesce.
      const job = await addJobCoalescingInFlight(
        queueFor(queueName) as unknown as DedupeQueueLike,
        queueName,
        { ...payload, organizationId },
        {
          jobId,
          attempts: param?.attempts,
          backoff: param?.backoff,
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        },
      );
      return { jobId: job.id ?? jobId };
    },
  };
  return { enqueue, queues: [...cache.values()] };
}
