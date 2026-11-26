// F-238 E2E regression — a DocLens batch whose job FAILED (every attempt spent while the docling-worker was
// down) must be re-runnable. BullMQ silently ignores `add` for a job id it still holds, and failed jobs are
// kept (`removeOnFail: false`), so before the fix a re-run answered 202 "queued" and nothing ran.
import { beforeEach, describe, expect, it, vi } from "vitest";

const jobs = new Map<string, { state: "failed" | "active" | "waiting" }>();
const added: string[] = [];
const workerListeners = new Map<string, (...args: unknown[]) => unknown>();
let dropNextAdd = false;

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
      if (dropNextAdd) {
        dropNextAdd = false;
        return;
      }
      jobs.set(opts.jobId, { state: "waiting" });
      added.push(opts.jobId);
    }
    async close() {}
  },
  Worker: class {
    on(event: string, listener: (...args: unknown[]) => unknown) {
      workerListeners.set(event, listener);
      return this;
    }
  },
}));

const { createDocLensIntakeEnqueue, docLensOperationalSummary, registerDocLensIntakeWorker } = await import(
  "../src/modules/22-documents/extraction/intake-queue"
);

const job = { organizationId: "o", batchId: "b1", actorUserId: "u", correlationId: "c" } as never;

describe("DocLens intake enqueue", () => {
  beforeEach(() => {
    jobs.clear();
    added.length = 0;
    workerListeners.clear();
    dropNextAdd = false;
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

  it("does not acknowledge a retry lost during failed-event cleanup", async () => {
    jobs.set("doclens-intake-b1", { state: "failed" });
    dropNextAdd = true;
    await createDocLensIntakeEnqueue({}).enqueue(job);
    expect(added).toEqual(["doclens-intake-b1"]);
    expect(jobs.get("doclens-intake-b1")?.state).toBe("waiting");
  });

  it("projects only the final failed attempt through the sanitized terminal-failure port", async () => {
    const exhausted = vi.fn(async () => undefined);
    registerDocLensIntakeWorker(
      {},
      {} as never,
      () => undefined,
      exhausted,
    );
    const failed = workerListeners.get("failed");
    expect(failed).toBeTypeOf("function");

    await failed?.(
      { data: job, attemptsMade: 2, opts: { attempts: 3 }, getState: async () => "delayed" },
      new Error("first retry; must not be persisted"),
    );
    expect(exhausted).not.toHaveBeenCalled();

    await failed?.(
      {
        data: job,
        attemptsMade: 2,
        opts: { attempts: 3 },
        getState: async () => "failed",
      },
      new Error("raw dependency detail must not be forwarded"),
    );
    expect(exhausted).toHaveBeenCalledWith(job, "processing_error", 3);
  });

  it("removes provider refusal details and SUD page numbers from operational logs", () => {
    const projected = docLensOperationalSummary({
      outcome: "awaiting_capability",
      pages: 2,
      jobs: 0,
      candidates: 0,
      dropped: {},
      refusals: ["provider secret and patient detail"],
      vision: { verified: 0, disagreed: 0, unverified: 0 },
      sud: { indicators: 1, pages: [2] },
      identity: "not_configured",
      recordsRequest: { status: "not_configured" },
      documents: 0,
      coding: {
        status: "not_configured",
        codes: 0,
        repaired: 0,
        flags: 0,
        unreadable: 0,
      },
    } as never);
    expect(projected).toMatchObject({
      refusalCount: 1,
      sud: { indicators: 1, pageCount: 1 },
    });
    expect(JSON.stringify(projected)).not.toContain("provider secret");
    expect(JSON.stringify(projected)).not.toContain('"pages":[2]');
  });
});
