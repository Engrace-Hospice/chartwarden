// apps/backend/src/modules/30-quality/wiring.ts — M30 Phase-2C/Integrate composition glue.
//
// The one place the composition root (apps/backend/src/index.ts) assembles M30's §4.8 background-work
// producer, mirroring the M33 `buildM33ReadEnqueue` precedent: the `m30.measure_recompute` /
// `m30.risk_register_refresh` BullMQ producer the R-04 / R-96 command routes enqueue onto. The Drizzle-backed
// READ + WRITE route services themselves are built directly from `buildDrizzleM30ReadService` /
// `buildDrizzleM30WriteService` (routes/*-drizzle.ts) — each method already owns its own `withOrgContext`, so
// (unlike M33) the read path needs no replica/queue/seam wiring here.
//
// BOUNDARY (M30 dependsOn [1,2,3,4,10,23,27,36,38] — no new edge): everything cross-module is reached through
// the foundation helpers M1 owns (`@wardenx/tenancy`, `@wardenx/db`) or a PORT bound to a typed-TODO until the
// owning infra exposes a boot accessor. Nothing here adds a direct feature-module import.
//
// WHAT IS LIVE vs TYPED-TODO: the §4.8 queue PRODUCER is LIVE when a Valkey connection is configured (BullMQ
// `Queue.add`, jobId-deduped); without one it FAILS CLOSED (a recompute command cannot silently drop its
// enqueue — never a no-op). The §4.10 transactional-outbox emitter stays UNBOUND in this phase (the `m30.*`
// events do not emit; the mutation still lands), the dispatcher binding being a later phase (the M33 precedent).
import type { ConnectionOptions } from "bullmq";
import { Queue } from "bullmq";

import { registerPlatformJob } from "@wardenx/tenancy";

import type { M30WriteQueueName, RecomputeEnqueuePort } from "./routes/write-service";

/**
 * The platform job id M30's §4.8 platform-scoped CRON fan-outs (nightly recompute, monthly CAHPS sample,
 * daily risk-register refresh, SRA reminders) enter `withPlatformContext` under to enumerate active orgs.
 * Registered on the `@wardenx/tenancy` PLATFORM_CONTEXT_ALLOWLIST by {@link wireM30Tenancy} at boot (the
 * allowlist starts empty → fail-closed). The M33 `M33_PLATFORM_JOB_ID` / M34 `M34_PLATFORM_JOB_ID` precedent.
 *
 * NOTE (issue #107, item 5): this registration is the necessary PREREQUISITE for the cron fan-outs, but it
 * is inert until the integrator binds the M2 active-org enumerator (`M30WorkerDeps.activeOrgs`) that actually
 * calls `withPlatformContext(M30_PLATFORM_JOB_ID, …)`. Until then the crons construct + boot green but their
 * `listActiveOrgs` port fails closed (never a silent no-op).
 */
export const M30_PLATFORM_JOB_ID = "m30.platform_crons";

/**
 * Register M30's platform job id on the `@wardenx/tenancy` PLATFORM_CONTEXT_ALLOWLIST so the §4.8 cron
 * fan-outs may enter `withPlatformContext` (idempotent `Set.add`). Mirrors `wireM33Tenancy` / `wireM34Tenancy`;
 * called once at boot by the composition root.
 */
export function wireM30Tenancy(): void {
  registerPlatformJob(M30_PLATFORM_JOB_ID);
}

/** Raised by a still-unbound Phase-2C infra port (the fail-closed signal — never a silent no-op). */
export class M30InfraPortUnbound extends Error {
  constructor(port: string, reason: string) {
    super(`M30 Phase-2C infra port '${port}' is not bound to a real adapter: ${reason}`);
    this.name = "M30InfraPortUnbound";
  }
}

/**
 * Build the `RecomputeEnqueuePort` the §4.1 R-04 (measure recompute) + R-96 (risk-register MV refresh)
 * command routes call. When a Valkey connection is configured it produces onto the named BullMQ `Queue`
 * (jobId-deduped); without one it fails closed (a recompute command cannot silently drop its enqueue).
 * Returns the `Queue`s so the composition root can `close()` them on teardown. Mirrors the M33
 * `buildM33ReadEnqueue` producer.
 */
export function buildM30RecomputeEnqueue(connection: ConnectionOptions | undefined): {
  enqueue: RecomputeEnqueuePort;
  queues: Queue[];
} {
  if (!connection) {
    return {
      enqueue: {
        async enqueue(queue) {
          throw new M30InfraPortUnbound(
            "recomputeEnqueue",
            `no Valkey connection configured — cannot enqueue '${queue}' (set the queue connection at boot)`,
          );
        },
      },
      queues: [],
    };
  }
  const cache = new Map<M30WriteQueueName, Queue>();
  const queueFor = (name: M30WriteQueueName): Queue => {
    let q = cache.get(name);
    if (!q) {
      q = new Queue(name, { connection });
      cache.set(name, q);
    }
    return q;
  };
  const enqueue: RecomputeEnqueuePort = {
    async enqueue(queue, jobKey, payload) {
      // BullMQ rejects a custom jobId containing ':' ("Custom Id cannot contain :"), but M30's own
      // dedupe keys ARE colon-delimited (`${orgId}:${scopeKey}`, `${orgId}:risk_register`, …) — the naive
      // `${queue}:${jobKey}` id collided with that reserved character (WX-PR-013 found the identical bug
      // in M27's producer; M30's was never live-tested either, so it shipped unnoticed). Sanitize the
      // FINAL id only — jobKey itself (and the dedupe semantics it encodes) is untouched.
      const jobId = `${queue}:${jobKey}`.replace(/:/g, "__");
      const job = await queueFor(queue).add(queue, payload, {
        jobId,
        removeOnComplete: { count: 500 },
        removeOnFail: false,
      });
      return { jobId: job.id ?? jobId };
    },
  };
  return { enqueue, queues: [...cache.values()] };
}
