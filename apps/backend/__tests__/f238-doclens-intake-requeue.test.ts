// F-238 E2E regression — a DocLens batch whose job FAILED (every attempt spent while the docling-worker was
// down) must be re-runnable. BullMQ silently ignores `add` for a job id it still holds, and failed jobs are
// kept (`removeOnFail: false`), so before the fix a re-run answered 202 "queued" and nothing ran.
import { beforeEach, describe, expect, it, vi } from "vitest";

const jobs = new Map<string, { state: "failed" | "active" | "waiting" }>();
const added: string[] = [];

vi.mock("bullmq", () => ({
  Queue: class {
    async getJob(id: string) {
      const j = jobs.get(id);
      return j
        ? {
            isFailed: async () => j.state === "failed",
            remove: async () => {
              jobs.delete(id);
            },
          }
        : undefined;
    }
    async add(_name: string, _data: unknown, opts: { jobId: string }) {
      if (jobs.has(opts.jobId)) return; // BullMQ: an id it still holds is a no-op
      jobs.set(opts.jobId, { state: "waiting" });
      added.push(opts.jobId);
    }
    async close() {}
  },
  Worker: class {},
}));

const { createDocLensIntakeEnqueue } = await import(
  "../src/modules/22-documents/extraction/intake-queue"
);

const job = { organizationId: "o", batchId: "b1", actorUserId: "u", correlationId: "c" } as never;

describe("DocLens intake enqueue", () => {
  beforeEach(() => {
    jobs.clear();
    added.length = 0;
  });

  it("re-enqueues a batch whose previous job failed", async () => {
    jobs.set("doclens-intake-b1", { state: "failed" });
    await createDocLensIntakeEnqueue({}).enqueue(job);
    expect(added).toEqual(["doclens-intake-b1"]);
  });

  it("still collapses a double-click while the first job is queued or running", async () => {
    jobs.set("doclens-intake-b1", { state: "active" });
    await createDocLensIntakeEnqueue({}).enqueue(job);
    expect(added).toEqual([]);
  });
});
