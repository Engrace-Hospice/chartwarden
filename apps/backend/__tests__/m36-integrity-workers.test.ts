// WP 1.9 — the scheduler registers the two promised cadences on the catalogued queue names, and the fan-out
// attempts every org before failing the tick. (The real-BullMQ behaviour is proved in m36-integrity-jobs.live.test.ts.)
import {
  MESSAGING_JOB_SCHEDULES,
  MESSAGING_QUEUES,
  MESSAGING_QUEUE_PARAMETERS,
} from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";

interface UpsertCall {
  queue: string;
  schedulerId: string;
  repeat: { pattern?: string };
  template: {
    name?: string;
    opts?: { attempts?: number; backoff?: { type?: string; delay?: number } };
  };
}
const upserts: UpsertCall[] = [];
const removed: Array<{ queue: string; key: string }> = [];
const closed: string[] = [];
const failure = { upsert: false };
vi.mock("bullmq", () => ({
  Queue: class {
    constructor(public readonly name: string) {}
    async getRepeatableJobs() {
      return [
        { key: "legacy-hash-key", name: "scheduled", pattern: "0 4 * * *" },
        { key: `${this.name}.schedule`, name: "scheduled", pattern: "x" },
        { key: "someone-elses", name: "other", pattern: "x" },
      ];
    }
    async removeRepeatableByKey(key: string) {
      removed.push({ queue: this.name, key });
      return true;
    }
    async close() {
      closed.push(this.name);
    }
    async upsertJobScheduler(
      schedulerId: string,
      repeat: UpsertCall["repeat"],
      template: UpsertCall["template"],
    ) {
      if (failure.upsert) throw new Error("redis blip");
      upserts.push({ queue: this.name, schedulerId, repeat, template });
    }
  },
  Worker: class {},
}));

import {
  fanOutOrgs,
  scheduleM36IntegrityJobs,
} from "../src/modules/36-messaging/jobs/integrity-workers";

describe("M36 integrity job scheduling (audit F8)", () => {
  it("upserts hash_verify nightly and retention_scan weekly on the catalogued queue names", async () => {
    upserts.length = 0;
    await scheduleM36IntegrityJobs({});
    expect(upserts.map((u) => [u.queue, u.repeat.pattern])).toEqual([
      [MESSAGING_QUEUES.hashVerify, MESSAGING_JOB_SCHEDULES.hashVerify],
      [MESSAGING_QUEUES.retentionScan, MESSAGING_JOB_SCHEDULES.retentionScan],
    ]);
    expect(MESSAGING_JOB_SCHEDULES.hashVerify).toBe("0 4 * * *");
  });

  it("retention_scan honours its parameter-table attempts/backoff; hash_verify runs once (a mismatch fails identically on retry)", async () => {
    upserts.length = 0;
    await scheduleM36IntegrityJobs({});
    const byQueue = new Map(upserts.map((u) => [u.queue, u.template.opts]));
    const retention = MESSAGING_QUEUE_PARAMETERS[MESSAGING_QUEUES.retentionScan];
    expect(byQueue.get(MESSAGING_QUEUES.retentionScan)).toMatchObject({
      attempts: retention.attempts,
      backoff: { type: retention.backoff.type, delay: retention.backoff.baseMs },
    });
    expect(MESSAGING_QUEUE_PARAMETERS[MESSAGING_QUEUES.hashVerify].attempts).toBe(1);
    expect(byQueue.get(MESSAGING_QUEUES.hashVerify)?.attempts).toBe(1);
  });

  it("removes a legacy repeatable (any key but its own scheduler id) before upserting, so only one schedule remains", async () => {
    upserts.length = 0;
    removed.length = 0;
    await scheduleM36IntegrityJobs({});
    expect(removed).toEqual([
      { queue: MESSAGING_QUEUES.hashVerify, key: "legacy-hash-key" },
      { queue: MESSAGING_QUEUES.retentionScan, key: "legacy-hash-key" },
    ]);
  });

  it("keeps the legacy trigger when the upsert fails (never zero schedules) and closes the queues it opened", async () => {
    removed.length = 0;
    closed.length = 0;
    failure.upsert = true;
    try {
      await expect(scheduleM36IntegrityJobs({})).rejects.toThrow("redis blip");
    } finally {
      failure.upsert = false;
    }
    expect(removed).toEqual([]);
    expect(closed).toEqual([MESSAGING_QUEUES.hashVerify]);
  });

  it("attempts every org, then fails the tick with the per-org errors", async () => {
    const seen: string[] = [];
    const activeOrgs = {
      listActiveOrgs: async () => [{ organizationId: "a" }, { organizationId: "b" }],
    };
    await expect(
      fanOutOrgs({ activeOrgs }, "hash_verify", async (org) => {
        seen.push(org);
        if (org === "a") throw new Error("boom");
      }),
    ).rejects.toThrow(/failed for 1 of 2/);
    expect(seen).toEqual(["a", "b"]);
  });
});
