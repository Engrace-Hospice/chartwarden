import { describe, expect, it } from "vitest";
import { runForEachActiveOrg } from "../jobs/cron-workers";
import { inTickWindow, shiftWindow, tickWindow } from "../jobs/windows";

describe("tickWindow (M13 deadline-sweep de-duplication)", () => {
  it("floors now to the period grid and spans exactly one period", () => {
    const w = tickWindow(new Date("2026-09-10T15:07:42.000Z"), 15);
    expect(w.to.toISOString()).toBe("2026-09-10T15:00:00.000Z");
    expect(w.from.toISOString()).toBe("2026-09-10T14:45:00.000Z");
  });

  it("tiles the timeline: a deadline belongs to exactly one tick regardless of scheduler jitter", () => {
    const deadline = new Date("2026-09-10T15:00:00.000Z"); // exactly on a boundary
    // One scheduler fire per 15-minute cell, each landing a few seconds off the boundary.
    const ticks = [
      new Date("2026-09-10T14:45:03.000Z"),
      new Date("2026-09-10T15:00:02.000Z"),
      new Date("2026-09-10T15:15:03.000Z"),
      new Date("2026-09-10T15:29:59.000Z"),
    ].map((now) => tickWindow(now, 15));
    expect(ticks.filter((w) => inTickWindow(deadline, w))).toHaveLength(1);
  });

  it("treats the lower bound as exclusive and the upper bound as inclusive", () => {
    const w = tickWindow(new Date("2026-09-10T15:00:00.000Z"), 60);
    expect(inTickWindow(w.from, w)).toBe(false);
    expect(inTickWindow(w.to, w)).toBe(true);
  });

  it("shifts a window forward by an offset (the 24h-before-deadline lookahead)", () => {
    const w = shiftWindow(tickWindow(new Date("2026-09-10T15:00:00.000Z"), 60), 24 * 3_600_000);
    expect(w.from.toISOString()).toBe("2026-09-11T14:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-09-11T15:00:00.000Z");
  });

  it("rejects a non-positive period", () => {
    expect(() => tickWindow(new Date(), 0)).toThrow(/positive integer/);
  });
});

describe("runForEachActiveOrg", () => {
  it("runs every org even when one fails, then fails the job with every failed org named", async () => {
    const seen: string[] = [];
    const run = runForEachActiveOrg(
      "M13_TEST",
      {
        listActiveOrgs: async () => [
          { organizationId: "a" },
          { organizationId: "b" },
          { organizationId: "c" },
        ],
      },
      async (organizationId) => {
        seen.push(organizationId);
        if (organizationId === "b") throw new Error("boom");
      },
    );
    await expect(run).rejects.toThrow(/1 of 3 org\(s\) failed — b/);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("propagates an enumerator failure instead of silently doing nothing", async () => {
    await expect(
      runForEachActiveOrg(
        "M13_TEST",
        { listActiveOrgs: async () => Promise.reject(new Error("no platform pool")) },
        async () => {},
      ),
    ).rejects.toThrow(/no platform pool/);
  });
});
