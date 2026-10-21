import * as bullmq from "bullmq";
// WP 5.7 - the expiry sweep over an in-memory store: only due jobs, an already-gone object is fine, paging past one batch, a failed delete is
// retried (job stays ready) and fails the run after the others; and the tick fans out and isolates an org failure.
import { describe, expect, it, vi } from "vitest";
import {
  EXPIRY_SWEEP_BATCH,
  type ExportExpiryStore,
  createExportExpirySweep,
} from "./export-expiry-sweep";
import { createExportBuildEnqueuer, exportBuildJob, exportExpiryTick } from "./export-worker";

const ORG = "o1";

function store(ids: string[]) {
  const ready = new Set(ids);
  const s: ExportExpiryStore = {
    dueAfter: async (_o, after, limit) =>
      [...ready]
        .sort()
        .filter((id) => !after || id > after)
        .slice(0, limit)
        .map((id) => ({ id, artefactKey: `messaging-export/${id}.enc` })),
    expire: async (_o, id) => ready.delete(id),
    failStuckBuilds: async () => 2,
    staleApproved: async () => [],
  };
  return { s, ready };
}

describe("export expiry sweep", () => {
  it("deletes the object then expires each due job", async () => {
    const { s, ready } = store(["a", "b"]);
    const deleteObject = vi.fn(async () => undefined);
    const res = await createExportExpirySweep({ store: s, deleteObject }).expireForOrg(ORG);
    expect(res).toEqual({ expired: 2, timedOut: 2 });
    expect(ready.size).toBe(0);
    expect(
      deleteObject.mock.calls.map((c: unknown[]) => (c[0] as { objectKey: string }).objectKey),
    ).toEqual(["messaging-export/a.enc", "messaging-export/b.enc"]);
  });

  it("tolerates an object that is already gone (the delete resolves)", async () => {
    const { s } = store(["a"]);
    const res = await createExportExpirySweep({
      store: s,
      deleteObject: async () => undefined,
    }).expireForOrg(ORG);
    expect(res.expired).toBe(1);
  });

  it("pages past one batch", async () => {
    const ids = Array.from(
      { length: EXPIRY_SWEEP_BATCH * 2 + 5 },
      (_, i) => `j${String(i).padStart(4, "0")}`,
    );
    const { s, ready } = store(ids);
    const res = await createExportExpirySweep({
      store: s,
      deleteObject: async () => undefined,
    }).expireForOrg(ORG);
    expect(res.expired).toBe(ids.length);
    expect(ready.size).toBe(0);
  });

  it("a failed delete leaves the job ready, the others expire, and the run fails", async () => {
    const { s, ready } = store(["a", "b", "c"]);
    const onError = vi.fn();
    const sweep = createExportExpirySweep({
      store: s,
      deleteObject: async ({ objectKey }) => {
        if (objectKey.includes("/b.")) throw new Error("s3 down");
      },
      onError,
    });
    await expect(sweep.expireForOrg(ORG)).rejects.toThrow(/failed for 1 job/);
    expect([...ready]).toEqual(["b"]);
    expect(onError).toHaveBeenCalledWith({ organizationId: ORG, jobId: "b" }, expect.any(Error));
  });
});

const orgs = (...ids: string[]) => ({
  listActiveOrgs: async () => ids.map((organizationId) => ({ organizationId })),
});

describe("exportExpiryTick", () => {
  it("totals across orgs and isolates an org failure", async () => {
    const expireForOrg = vi.fn(async (o: string) => {
      if (o === "bad") throw new Error("x");
      return { expired: 1, timedOut: 0 };
    });
    await expect(
      exportExpiryTick({ activeOrgs: orgs("a", "bad", "c"), expireForOrg }),
    ).rejects.toThrow(/export_expiry_sweep failed for 1 of 3/);
    expect(expireForOrg).toHaveBeenCalledTimes(3);
    expect(await exportExpiryTick({ activeOrgs: orgs("a", "c"), expireForOrg })).toEqual({
      expired: 2,
      timedOut: 0,
      reenqueued: 0,
    });
  });

  it("re-enqueues every stale approved job of every org, once each, through the idempotent enqueuer", async () => {
    const enqueue = vi.fn(async () => undefined);
    const staleApprovedForOrg = vi.fn(async (o: string) => (o === "a" ? ["j1", "j2"] : ["j3"]));
    const out = await exportExpiryTick({
      activeOrgs: orgs("a", "c"),
      expireForOrg: async () => ({ expired: 0, timedOut: 0 }),
      staleApprovedForOrg,
      enqueue,
    });
    expect(out.reenqueued).toBe(3);
    expect(enqueue.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      { organizationId: "a", jobId: "j1" },
      { organizationId: "a", jobId: "j2" },
      { organizationId: "c", jobId: "j3" },
    ]);
  });
});

describe("exportExpiryTick - stale re-enqueue resilience", () => {
  it("still re-enqueues the stale approved jobs when the expiry throws, and the tick still fails", async () => {
    const enqueue = vi.fn(async () => undefined);
    await expect(
      exportExpiryTick({
        activeOrgs: orgs("a"),
        expireForOrg: async () => {
          throw new AggregateError([new Error("delete failed")], "expiry");
        },
        staleApprovedForOrg: async () => ["j1", "j2"],
        enqueue,
      }),
    ).rejects.toThrow();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("one failing enqueue does not stop the rest, and the tick reports the failure", async () => {
    const enqueue = vi.fn(async (d: { jobId: string }) => {
      if (d.jobId === "j1") throw new Error("redis down");
    });
    await expect(
      exportExpiryTick({
        activeOrgs: orgs("a"),
        expireForOrg: async () => ({ expired: 0, timedOut: 0 }),
        staleApprovedForOrg: async () => ["j1", "j2", "j3"],
        enqueue,
      }),
    ).rejects.toThrow();
    expect(enqueue.mock.calls.map((c: unknown[]) => (c[0] as { jobId: string }).jobId)).toEqual([
      "j1",
      "j2",
      "j3",
    ]);
  });
});

describe("createExportBuildEnqueuer", () => {
  const withQueue = (leftover: unknown) => {
    const add = vi.fn(async () => undefined);
    const getJob = vi.fn(async () => leftover);
    vi.spyOn(bullmq.Queue.prototype, "add").mockImplementation(add as never);
    vi.spyOn(bullmq.Queue.prototype, "getJob").mockImplementation(getJob as never);
    return { add, getJob };
  };
  const make = () => createExportBuildEnqueuer({ host: "127.0.0.1", port: 1 } as never);

  it("adds the build with the export job id as the BullMQ job id", async () => {
    const q = withQueue(undefined);
    const e = make();
    await e.enqueue({ organizationId: "o", jobId: "j9" });
    expect(q.add).toHaveBeenCalledWith(
      "build",
      { organizationId: "o", jobId: "j9" },
      expect.objectContaining({ jobId: "j9" }),
    );
    await e.queue.close().catch(() => undefined);
  });

  it("removes a failed leftover with that id before adding; leaves a live duplicate alone", async () => {
    const remove = vi.fn(async () => undefined);
    withQueue({ isFailed: async () => true, remove });
    const failed = make();
    await failed.enqueue({ organizationId: "o", jobId: "j9" });
    expect(remove).toHaveBeenCalledTimes(1);
    await failed.queue.close().catch(() => undefined);

    const liveRemove = vi.fn(async () => undefined);
    withQueue({ isFailed: async () => false, remove: liveRemove });
    const live = make();
    await live.enqueue({ organizationId: "o", jobId: "j9" });
    expect(liveRemove).not.toHaveBeenCalled();
    await live.queue.close().catch(() => undefined);
  });
});

describe("exportBuildJob", () => {
  it("reports the closed code and error class of a failed build, never a message", async () => {
    const onFailed = vi.fn();
    const builder = {
      buildJob: async () => ({
        outcome: "failed" as const,
        failureCode: "EXPORT_BUILD_FAILED",
        errorName: "RangeError",
      }),
    };
    await exportBuildJob(builder, { organizationId: "o", jobId: "j" }, onFailed);
    expect(onFailed).toHaveBeenCalledWith({
      jobId: "j",
      failureCode: "EXPORT_BUILD_FAILED",
      errorName: "RangeError",
    });
  });
});
