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

import type { M30WriteQueueName, RecomputeEnqueuePort } from "./routes/write-service";

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
      const job = await queueFor(queue).add(queue, payload, {
        jobId: `${queue}:${jobKey}`,
        removeOnComplete: { count: 500 },
        removeOnFail: false,
      });
      return { jobId: job.id ?? `${queue}:${jobKey}` };
    },
  };
  return { enqueue, queues: [...cache.values()] };
}
