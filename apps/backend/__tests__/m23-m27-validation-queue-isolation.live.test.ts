/**
 * M23 / M27 `validation-run` queue isolation — LIVE Valkey proof.
 *
 * M23 and M27 once enqueued onto one BullMQ queue literally named `validation-run`, so an M27 worker picked up an M23
 * job and failed it ("cost_report_validation undefined not found") into the DLQ. Each module now owns its own queue
 * (`m23.validation-run` / `validation-run`). This drives the REAL producers (`buildM23WorkQueueEnqueuePort`,
 * `buildM27RecomputeEnqueue`) against a real queue with one consumer per module on that module's REAL queue constant
 * (the same constants `registerM23DomainWorkers` / the M27 workers listen on) and proves, in both directions, that a
 * job reaches only its own module's consumer. It also proves the boot-time recovery: an M23 job stranded on the old
 * shared queue (waiting, delayed or failed) moves to the M23 queue with its id and payload, M27's job is left alone,
 * and a repeat sweep is a no-op.
 *
 *   CHARTWARDEN_TEST_REDIS_URL=redis://localhost:PORT bun run test:m23:validation-queue-isolation:live
 */
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M23_QUEUES, sweepLegacyValidationRunQueue } from "../src/modules/23-billing-medicare";
import { buildM23WorkQueueEnqueuePort } from "../src/modules/23-billing-medicare/jobs/m23-worker-ports";
import { M23_LEGACY_VALIDATION_RUN_QUEUE } from "../src/modules/23-billing-medicare/jobs/queues";
import { M27_QUEUES } from "../src/modules/27-cost-report/jobs/queues";
import { buildM27RecomputeEnqueue } from "../src/modules/27-cost-report/wiring";

const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
const ORG = "11111111-1111-4111-8111-111111111111";
const WAIT_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function redisOptionsOf(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null };
}
const connectionOf = (url: string): ConnectionOptions => redisOptionsOf(url);

describe.skipIf(!REDIS_URL)("M23 / M27 validation-run queue isolation — LIVE Valkey", () => {
  // describe.skipIf still runs this callback, so never parse an unset URL here.
  const connection: ConnectionOptions = REDIS_URL ? connectionOf(REDIS_URL) : {};
  let redis: IORedis;
  const received: { m23: string[]; m27: string[] } = { m23: [], m27: [] };
  const workers: Worker[] = [];
  const closers: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    redis = new IORedis(redisOptionsOf(REDIS_URL as string));
    await redis.flushdb();
    expect(M23_QUEUES.validationRun).not.toBe(M27_QUEUES.validationRun);
    workers.push(
      new Worker(
        M23_QUEUES.validationRun,
        async (job) => {
          received.m23.push(String(job.id));
        },
        { connection },
      ),
      new Worker(
        M27_QUEUES.validationRun,
        async (job) => {
          received.m27.push(String(job.id));
        },
        { connection },
      ),
    );
    await Promise.all(workers.map((w) => w.waitUntilReady()));
  }, 60_000);

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(closers.map((c) => c()));
    await redis?.quit();
  });

  it("an M23 job enqueued through the real M23 producer is consumed only by the M23 consumer", async () => {
    const m23 = buildM23WorkQueueEnqueuePort(connection);
    closers.push(() => Promise.all(m23.queues.map((q) => q.close())));
    const { jobId } = await m23.port.enqueue(M23_QUEUES.validationRun, `${ORG}:claim-1:run-1`, {
      organizationId: ORG,
      claimId: "claim-1",
      validationRunId: "run-1",
      trigger: "manual_re_run",
    });
    await sleep(WAIT_MS);
    expect(received.m23).toEqual([jobId]);
    expect(received.m27).toEqual([]);
  });

  it("an M27 job enqueued through the real M27 producer is consumed only by the M27 consumer", async () => {
    const m27 = buildM27RecomputeEnqueue(connection);
    closers.push(() => Promise.all(m27.queues.map((q) => q.close())));
    received.m23.length = 0;
    const { jobId } = await m27.enqueue.enqueue(
      M27_QUEUES.validationRun,
      `${ORG}:cost-report-1:validation-1`,
      { costReportId: "cost-report-1", validationId: "validation-1", ruleSetVersion: 1 },
    );
    await sleep(WAIT_MS);
    expect(received.m27).toEqual([jobId]);
    expect(received.m23).toEqual([]);
  });

  describe("recovery of jobs stranded on the old shared queue", () => {
    it("moves M23's waiting/delayed/failed jobs to m23.validation-run, leaves M27's, and is idempotent", async () => {
      // No consumer on the legacy name here: delayed jobs stay put, and a job we mark failed stays failed.
      const legacy = new Queue(M23_LEGACY_VALIDATION_RUN_QUEUE, { connection });
      closers.push(() => legacy.close());
      const payload = {
        organizationId: ORG,
        claimId: "claim-9",
        validationRunId: "run-9",
        trigger: "manual_re_run",
      };
      await legacy.add("validation-run", payload, {
        jobId: "m23:validation-run:delayed-1",
        delay: 60_000,
      });
      await legacy.add(
        "validation-run",
        { ...payload, validationRunId: "run-10" },
        {
          jobId: "m23:validation-run:delayed-2",
          delay: 120_000,
        },
      );
      await legacy.add(
        "validation-run",
        { costReportId: "cr-9", validationId: "v-9", ruleSetVersion: 1 },
        {
          jobId: "validation-run__org__cr-9__v-9",
          delay: 60_000,
        },
      );
      // A genuinely FAILED M23 job, as the wrong module's worker leaves it: a real worker on the legacy name that
      // always throws (attempts 1). Fail loudly if it does not end up in the failed state.
      // The M27 recorder also listens on the legacy name: pause it so only the failing worker can take the job.
      await workers[1]?.pause();
      const failer = new Worker(
        M23_LEGACY_VALIDATION_RUN_QUEUE,
        async () => {
          throw new Error("cost_report_validation undefined not found");
        },
        { connection },
      );
      await failer.waitUntilReady();
      await legacy.add(
        "validation-run",
        { ...payload, validationRunId: "run-11" },
        {
          jobId: "m23:validation-run:failed-1",
          attempts: 1,
        },
      );
      const deadline = Date.now() + 10_000;
      while (
        (await (await legacy.getJob("m23:validation-run:failed-1"))?.getState()) !== "failed"
      ) {
        if (Date.now() > deadline) throw new Error("the legacy job never reached the failed state");
        await sleep(100);
      }
      await failer.close();
      workers[1]?.resume();
      received.m23.length = 0;

      const result = await sweepLegacyValidationRunQueue(connection);
      expect(result.moved).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.leftForOtherModules).toBe(1);

      const target = new Queue(M23_QUEUES.validationRun, { connection });
      closers.push(() => target.close());
      expect(await target.getJob("m23:validation-run:failed-1")).toBeDefined();
      expect(await legacy.getJob("m23:validation-run:failed-1")).toBeUndefined();
      for (const id of ["m23:validation-run:delayed-1", "m23:validation-run:delayed-2"]) {
        const moved = await target.getJob(id);
        expect(moved?.data).toMatchObject({ claimId: "claim-9" });
        expect(await legacy.getJob(id)).toBeUndefined();
      }
      expect((await target.getJob("m23:validation-run:delayed-1"))?.opts.delay).toBeGreaterThan(0);
      // M27's job is untouched.
      expect(await legacy.getJob("validation-run__org__cr-9__v-9")).toBeDefined();

      const again = await sweepLegacyValidationRunQueue(connection);
      expect(again.moved).toBe(0);
      expect(again.leftForOtherModules).toBe(1);
    });
  });
});
