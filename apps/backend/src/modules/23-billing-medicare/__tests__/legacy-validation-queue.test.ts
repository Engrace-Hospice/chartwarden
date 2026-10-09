import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { migrateLegacyValidationRunJobs } from "../jobs/legacy-validation-queue";
import { M23_QUEUES } from "../jobs/queues";

function fakeJob(id: string, data: unknown, delay = 0): Job & { removed: boolean } {
  const job = {
    id,
    data,
    timestamp: 1_000,
    opts: { delay },
    removed: false,
    async remove() {
      job.removed = true;
    },
  };
  return job as unknown as Job & { removed: boolean };
}

describe("migrateLegacyValidationRunJobs", () => {
  it("moves only m23: jobs, preserving id and payload, and removes them from the legacy queue", async () => {
    const mine = fakeJob("m23:validation-run:a", { claimId: "c1" });
    const theirs = fakeJob("validation-run__org__cr__v", { costReportId: "cr" });
    const getJobs = vi.fn(async (types: string[]) =>
      types.includes("active") ? [] : [mine, theirs],
    );
    const add = vi.fn(async () => undefined);

    const result = await migrateLegacyValidationRunJobs({ getJobs }, { add }, () => 1_000);

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      M23_QUEUES.validationRun,
      { claimId: "c1" },
      expect.objectContaining({ jobId: "m23:validation-run:a", removeOnFail: false }),
    );
    expect(mine.removed).toBe(true);
    expect(theirs.removed).toBe(false);
    expect(result).toEqual({ moved: 1, skippedActive: 0, leftForOtherModules: 1 });
  });

  it("carries the remaining delay of a delayed job and never moves a delay into the past", async () => {
    const delayed = fakeJob("m23:validation-run:d", {}, 5_000);
    const add = vi.fn(async (..._args: unknown[]) => undefined);
    await migrateLegacyValidationRunJobs(
      { getJobs: async (t) => (t.includes("active") ? [] : [delayed]) },
      { add },
      () => 3_000,
    );
    expect(add.mock.calls[0]?.[2]).toMatchObject({ delay: 3_000 });
  });

  it("adds before it removes, so a failed add loses nothing", async () => {
    const job = fakeJob("m23:validation-run:x", {});
    const add = vi.fn(async () => {
      throw new Error("redis down");
    });
    await expect(
      migrateLegacyValidationRunJobs(
        { getJobs: async (t) => (t.includes("active") ? [] : [job]) },
        { add },
      ),
    ).rejects.toThrow("redis down");
    expect(job.removed).toBe(false);
  });

  it("reports an active M23 job it cannot move, and pages through every job", async () => {
    const active = fakeJob("m23:validation-run:live", {});
    const all = Array.from({ length: 250 }, (_, i) => fakeJob(`m23:validation-run:${i}`, {}));
    const getJobs = vi.fn(async (t: string[], start = 0, end = 199) =>
      t.includes("active") ? [active] : all.slice(start, end + 1),
    );
    const add = vi.fn(async () => undefined);
    const result = await migrateLegacyValidationRunJobs({ getJobs }, { add });
    expect(result).toEqual({ moved: 250, skippedActive: 1, leftForOtherModules: 0 });
    expect(all.every((j) => j.removed)).toBe(true);
  });
});
