// GAP-113 — the idempotency.cleanup sweeper purges expired keys per org, in bounded batches, isolating a
// failing org (the pass still rejects so BullMQ retries).
import { describe, expect, it, vi } from "vitest";

const backlog: Record<string, number> = { "org-a": 2500, "org-b": 3 };
const deleteCalls: Array<{ org: string; ids: number }> = [];
let currentOrg = "";

vi.mock("@chartwarden/tenancy", () => ({
  registerPlatformJob: () => {},
  systemOrgContext: (organizationId: string) => ({ organizationId, userId: "" }),
  withOrgContext: async (
    _db: unknown,
    ctx: { organizationId: string },
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    currentOrg = ctx.organizationId;
    if (currentOrg === "org-bad") throw new Error("boom");
    let pending: string[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async (n: number) => {
              const take = Math.min(n, backlog[currentOrg] ?? 0);
              pending = Array.from({ length: take }, (_, i) => `id-${i}`);
              return pending.map((id) => ({ id }));
            },
          }),
        }),
      }),
      delete: () => ({
        where: async () => {
          backlog[currentOrg] = (backlog[currentOrg] ?? 0) - pending.length;
          deleteCalls.push({ org: currentOrg, ids: pending.length });
        },
      }),
    };
    return fn(tx);
  },
}));

import {
  IDEMPOTENCY_PURGE_BATCH,
  type IdempotencyCleanupDeps,
  runIdempotencyCleanup,
} from "../idempotency-cleanup";

const deps = (orgs: string[]): IdempotencyCleanupDeps => ({
  db: {} as never,
  activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
  now: () => new Date("2026-10-06T12:00:00.000Z"),
});

describe("idempotency.cleanup purge", () => {
  it("drains each org's expired rows in bounded batches", async () => {
    const purged = await runIdempotencyCleanup(deps(["org-a", "org-b"]));
    expect(purged).toBe(2503);
    expect(deleteCalls.filter((c) => c.org === "org-a").map((c) => c.ids)).toEqual([
      IDEMPOTENCY_PURGE_BATCH,
      IDEMPOTENCY_PURGE_BATCH,
      500,
    ]);
    expect(backlog["org-a"]).toBe(0);
    expect(backlog["org-b"]).toBe(0);
  });

  it("continues past a failing org, then rejects", async () => {
    backlog["org-b"] = 1;
    await expect(runIdempotencyCleanup(deps(["org-bad", "org-b"]))).rejects.toThrow(
      /org-bad: boom/,
    );
    expect(backlog["org-b"]).toBe(0);
  });
});
