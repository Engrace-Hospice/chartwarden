// GAP-032 - one alert that throws must not stop the SOS watchdog tick from executing pending terminus rows,
// for its own org or for any later one (the executor runs after the per-alert pass, not behind it).
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let withOrgCalls = 0;

vi.mock("@wardenx/tenancy", () => ({
  runWithRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  // Call 1 per org is the alert-id scan; the rest are per-alert transactions, and the first of those fails.
  withOrgContext: async (_db: unknown, ctx: { organizationId: string }) => {
    withOrgCalls += 1;
    const isScan = calls.filter((c) => c.startsWith(`scan:${ctx.organizationId}`)).length === 0;
    if (isScan) {
      calls.push(`scan:${ctx.organizationId}`);
      return ["alert-bad", "alert-good"];
    }
    calls.push(`alert:${ctx.organizationId}`);
    if (calls.filter((c) => c === `alert:${ctx.organizationId}`).length === 1) {
      throw new Error("db down");
    }
    return undefined;
  },
}));
vi.mock("../src/modules/20-field-safety/terminus/executor", () => ({
  runTerminusExecutorForOrg: async (_deps: unknown, org: string) => {
    calls.push(`executor:${org}`);
  },
}));

import { runSosSlaWatchdogCron } from "../src/modules/20-field-safety/jobs/cron-workers";

describe("runSosSlaWatchdogCron isolation", () => {
  beforeEach(() => {
    calls.length = 0;
    withOrgCalls = 0;
  });

  it("still runs the terminus executor for every org when one alert throws", async () => {
    const deps = {
      db: {},
      activeOrgs: {
        listActiveOrgs: async () => [{ organizationId: "o1" }, { organizationId: "o2" }],
      },
      terminus: {},
      now: () => new Date("2026-10-08T12:00:00.000Z"),
    } as never;

    await expect(runSosSlaWatchdogCron(deps)).resolves.toBeUndefined();

    expect(calls).toContain("executor:o1");
    expect(calls).toContain("executor:o2");
    // the alert after the failing one was still processed
    expect(calls.filter((c) => c === "alert:o1")).toHaveLength(2);
    expect(withOrgCalls).toBe(6);
  });
});
