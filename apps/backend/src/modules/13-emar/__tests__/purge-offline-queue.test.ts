import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { buildM13CronRunners } from "../jobs/cron-workers";
import { OFFLINE_QUEUE_RETENTION_DAYS } from "../jobs/purge-offline-queue";
import { M13_CRON_QUEUES, M13_CRON_QUEUE_PARAMS, M13_CRON_SCHEDULES } from "../jobs/queues";

describe("M13 purge-offline-queue catalog entry", () => {
  it("registers the spec queue name with no ':' (BullMQ forbids it in names and ids)", () => {
    expect(M13_CRON_QUEUES.purgeOfflineQueue).toBe("m13.purge-offline-queue");
    expect(M13_CRON_QUEUES.purgeOfflineQueue).not.toContain(":");
  });

  it("is nightly with the spec retry policy (3 attempts, 5 minute first backoff, concurrency 1)", () => {
    expect(M13_CRON_SCHEDULES.purgeOfflineQueue).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(M13_CRON_QUEUE_PARAMS.purgeOfflineQueue).toMatchObject({
      attempts: 3,
      backoffMs: 300_000,
      concurrency: 1,
    });
  });

  it("keeps the spec's 30-day post-sync retention", () => {
    expect(OFFLINE_QUEUE_RETENTION_DAYS).toBe(30);
  });
});

describe("M13 purge-offline-queue fan-out", () => {
  it("attempts every org even when one fails, then rethrows the failures together", async () => {
    const touched: string[] = [];
    const db = {
      transaction: async () => {
        throw new Error("db down");
      },
    } as unknown as DbClient;
    const runners = buildM13CronRunners({
      connection: { host: "unused", port: 0 },
      db,
      outbox: { publish: async () => undefined } as never,
      activeOrgs: {
        listActiveOrgs: async () => {
          touched.push("enumerated");
          return [{ organizationId: "org-a" }, { organizationId: "org-b" }];
        },
      },
      orderContext: async () => null,
      locationTimezone: async () => "UTC",
      reassessmentCaptured: async () => false,
    });

    await expect(runners.purgeOfflineQueue()).rejects.toThrow(/2 of 2 org\(s\) failed/);
    expect(touched).toEqual(["enumerated"]);
  });
});
