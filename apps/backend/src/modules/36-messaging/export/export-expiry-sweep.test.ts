// WP 5.7 - the expiry sweep over an in-memory store: only due jobs, an already-gone object is fine, paging past one batch, a failed delete is
// retried (job stays ready) and fails the run after the others; and the tick fans out and isolates an org failure.
import { describe, expect, it, vi } from "vitest";
import {
  EXPIRY_SWEEP_BATCH,
  type ExportExpiryStore,
  createExportExpirySweep,
} from "./export-expiry-sweep";
import { exportExpiryTick } from "./export-worker";

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

describe("exportExpiryTick", () => {
  const orgs = (...ids: string[]) => ({
    listActiveOrgs: async () => ids.map((organizationId) => ({ organizationId })),
  });
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
    });
  });
});
