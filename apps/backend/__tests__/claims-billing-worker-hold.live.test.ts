/**
 * ADR-0108 D7 — LIVE Valkey proof that the claims-billing worker hold is a HOLD, not a failure: on a real BullMQ queue a
 * job for an org without the add-on goes back to `delayed`, spends no attempt, never fails (so never reaches a DLQ),
 * and runs normally once the org is entitled. The gate itself is unit-tested; this proves the BullMQ semantics.
 *
 *   CHARTWARDEN_TEST_REDIS_URL=redis://localhost:PORT bun run test:claims-billing:worker-hold:live
 */
import { randomUUID } from "node:crypto";
import type { ClaimsBillingEntitlement } from "@chartwarden/types";
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAIMS_BILLING_HOLD_MS,
  configureClaimsBillingGate,
  holdUnlessClaimsBillingEntitled,
} from "../src/bootstrap/claims-billing-gate";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";

const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
const ORG = "a1000000-0000-4000-8000-000000000001";

function connectionOf(url: string): ConnectionOptions {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null };
}

describe.skipIf(!REDIS_URL)("ADR-0108 worker hold — LIVE Valkey", () => {
  const queueName = `cb-hold-${randomUUID()}`;
  let connection: ConnectionOptions;
  let queue: Queue;
  let worker: Worker;
  let entitlement: ClaimsBillingEntitlement = { entitled: false, reason: "never_purchased" };
  let ran = 0;

  beforeAll(async () => {
    connection = connectionOf(REDIS_URL as string);
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    registerSeam("ClaimsBillingEntitlementReader", { entitlementForOrg: async () => entitlement });
    queue = new Queue(queueName, { connection });
    worker = new Worker(
      queueName,
      async (job: Job, token?: string) => {
        await holdUnlessClaimsBillingEntitled(job, token, ORG, queueName);
        ran += 1;
      },
      { connection },
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    configureClaimsBillingGate({ mode: "shadow" });
    __resetSeamsForTest();
  });

  async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("condition not met in time");
  }

  it("holds an unentitled org's job as delayed, with no attempt spent and no failure", async () => {
    const job = await queue.add("submit", { organizationId: ORG }, { attempts: 1 });
    await waitFor(async () => (await queue.getJobState(job.id as string)) === "delayed");
    const held = await queue.getJob(job.id as string);
    expect(held?.attemptsMade).toBe(0);
    expect(held?.failedReason ?? null).toBeNull();
    expect(await queue.getFailedCount()).toBe(0);
    expect(ran).toBe(0);
    // Delayed by roughly the hold window, not retried on a backoff.
    expect((held?.delay ?? 0) + (held?.timestamp ?? 0)).toBeGreaterThan(
      Date.now() + CLAIMS_BILLING_HOLD_MS - 60_000,
    );
  });

  it("runs the held job once the org is entitled", async () => {
    entitlement = { entitled: true };
    const [held] = await queue.getDelayed();
    expect(held).toBeDefined();
    await held?.promote();
    await waitFor(async () => (await queue.getJobState(held?.id as string)) === "completed");
    expect(ran).toBe(1);
    expect(await queue.getFailedCount()).toBe(0);
  });
});
