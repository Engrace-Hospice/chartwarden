// GAP-117 — the M3 `reap_breakglass` cron expires lapsed grants (status -> expired, m3.breakglass.ended
// outcome "expired") per org and isolates a failing org (the job still rejects so BullMQ retries).
import { describe, expect, it, vi } from "vitest";

let currentOrg = "";
const rowsByOrg: Record<string, Array<Record<string, unknown>>> = {
  "org-a": [{ id: "ev-1", organizationId: "org-a" }],
  "org-b": [{ id: "ev-2", organizationId: "org-b" }],
};

vi.mock("@wardenx/tenancy", () => ({
  systemOrgContext: (organizationId: string) => ({ organizationId, userId: "" }),
  withOrgContext: async (
    _db: unknown,
    ctx: { organizationId: string },
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    currentOrg = ctx.organizationId;
    if (currentOrg === "org-bad") throw new Error("boom");
    const tx = {
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => rowsByOrg[currentOrg] ?? [] }),
        }),
      }),
    };
    return fn(tx);
  },
}));

import {
  type BreakGlassReaperDeps,
  runBreakGlassReaperCron,
} from "../src/modules/03-authorization/break-glass-reaper";

const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
const deps = (orgs: string[]): BreakGlassReaperDeps => ({
  db: {} as never,
  outbox: {
    async publish(_tx, input) {
      published.push({ eventName: input.eventName, payload: input.payload });
    },
  },
  activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
  now: () => new Date("2026-10-06T12:00:00.000Z"),
});

describe("M3 reap_breakglass cron", () => {
  it("expires lapsed grants and publishes m3.breakglass.ended(expired) once per event", async () => {
    published.length = 0;
    const reaped = await runBreakGlassReaperCron(deps(["org-a", "org-b"]));
    expect(reaped).toBe(2);
    expect(published.map((p) => p.payload.breakGlassId)).toEqual(["ev-1", "ev-2"]);
    expect(published.every((p) => p.eventName === "m3.breakglass.ended")).toBe(true);
    expect(published.every((p) => p.payload.outcome === "expired")).toBe(true);
  });

  it("continues past a failing org, then rejects so BullMQ retries", async () => {
    published.length = 0;
    await expect(runBreakGlassReaperCron(deps(["org-bad", "org-b"]))).rejects.toThrow(
      /org-bad: boom/,
    );
    expect(published.map((p) => p.payload.breakGlassId)).toEqual(["ev-2"]);
  });
});
