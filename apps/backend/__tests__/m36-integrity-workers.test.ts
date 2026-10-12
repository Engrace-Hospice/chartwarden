// WP 1.9 — the scheduler registers the two promised cadences on the catalogued queue names, and the fan-out
// attempts every org before failing the tick.
import { MESSAGING_JOB_SCHEDULES, MESSAGING_QUEUES } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";

const added: Array<{ queue: string; opts: { repeat?: { pattern?: string } } }> = [];
vi.mock("bullmq", () => ({
  Queue: class {
    constructor(public readonly name: string) {}
    async add(_job: string, _data: unknown, opts: { repeat?: { pattern?: string } }) {
      added.push({ queue: this.name, opts });
    }
  },
  Worker: class {},
}));

import {
  fanOutOrgs,
  scheduleM36IntegrityJobs,
} from "../src/modules/36-messaging/jobs/integrity-workers";

describe("M36 integrity job scheduling (audit F8)", () => {
  it("repeats hash_verify nightly and retention_scan weekly on the catalogued queue names", async () => {
    await scheduleM36IntegrityJobs({});
    expect(added).toEqual([
      {
        queue: MESSAGING_QUEUES.hashVerify,
        opts: expect.objectContaining({ repeat: { pattern: MESSAGING_JOB_SCHEDULES.hashVerify } }),
      },
      {
        queue: MESSAGING_QUEUES.retentionScan,
        opts: expect.objectContaining({
          repeat: { pattern: MESSAGING_JOB_SCHEDULES.retentionScan },
        }),
      },
    ]);
    expect(MESSAGING_JOB_SCHEDULES.hashVerify).toBe("0 4 * * *");
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
