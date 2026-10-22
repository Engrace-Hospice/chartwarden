// WP 5.6 (ADR-0086, PROPOSED) - the weekly tick wiring of the destruction executor, with no database: it runs after the scan, only when bound, and
// a failure in either is reported after both were attempted. The pure rules are in m36-retention-destruction-rules.test.ts; the behaviour against
// Postgres is proved in m36-retention-destruction.live.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const scan = vi.fn();
const destroy = vi.fn();
vi.mock("../src/modules/36-messaging/jobs/integrity-jobs", () => ({
  runHashVerifyForOrg: vi.fn(),
  runRetentionScanForOrg: (...args: unknown[]) => scan(...args),
}));
vi.mock("../src/modules/36-messaging/jobs/retention-destruction", () => ({
  runRetentionDestructionForOrg: (...args: unknown[]) => destroy(...args),
}));
vi.mock("bullmq", () => ({ Queue: class {}, Worker: class {} }));

import { retentionScanTick } from "../src/modules/36-messaging/jobs/integrity-workers";

describe("retentionScanTick wiring", () => {
  const orgs = { listActiveOrgs: async () => [{ organizationId: "a" }, { organizationId: "b" }] };
  const base = {
    activeOrgs: orgs,
    db: {} as never,
    messageHolds: {} as never,
    connection: {} as never,
  } as never;
  const withDestruction = { ...(base as object), destruction: { destructionDb: {} } } as never;

  beforeEach(() => {
    scan.mockReset().mockResolvedValue(undefined);
    destroy.mockReset().mockResolvedValue(undefined);
  });

  it("never runs the executor when none is bound (no destruction credential)", async () => {
    await retentionScanTick(base);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("runs the executor for every org after the scan, org-explicit", async () => {
    await retentionScanTick(withDestruction);
    expect(destroy.mock.calls.map((c) => c[1])).toEqual(["a", "b"]);
    expect(scan.mock.invocationCallOrder[1]).toBeLessThan(
      destroy.mock.invocationCallOrder[0] as number,
    );
  });

  it("still runs the executor when the scan failed for an org, then fails the tick", async () => {
    scan.mockImplementation(async (_d: unknown, org: string) => {
      if (org === "a") throw new Error("scan boom");
    });
    await expect(retentionScanTick(withDestruction)).rejects.toThrow(/retention tick failed/);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("fails the tick when the executor fails for an org, after attempting the others", async () => {
    destroy.mockImplementation(async (_d: unknown, org: string) => {
      if (org === "a") throw new Error("destroy boom");
    });
    await expect(retentionScanTick(withDestruction)).rejects.toThrow(/retention tick failed/);
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
