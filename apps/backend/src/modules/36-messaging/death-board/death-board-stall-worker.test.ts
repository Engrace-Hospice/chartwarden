// ADR-0098 D13 - the stall tick fans out over the active orgs, totals the result, and isolates an org failure (every other org is still
// attempted; the tick then fails so BullMQ retries and the DLQ alert fires). The sweep itself is proven in the service test and live.
import { describe, expect, it, vi } from "vitest";
import { deathBoardStallTick } from "./death-board-stall-worker";

const orgs = (...ids: string[]) => ({
  listActiveOrgs: async () => ids.map((organizationId) => ({ organizationId })),
});

describe("deathBoardStallTick", () => {
  it("sums the sweep across the active orgs", async () => {
    const flagStalledForOrg = vi.fn(async (org: string) => ({
      examined: 6,
      flagged: org === "a" ? 2 : 1,
    }));
    expect(await deathBoardStallTick({ activeOrgs: orgs("a", "b"), flagStalledForOrg })).toEqual({
      examined: 12,
      flagged: 3,
    });
  });

  it("an org that fails does not stop the others; the tick then fails, reporting ids only", async () => {
    const onError = vi.fn();
    const flagStalledForOrg = vi.fn(async (org: string) => {
      if (org === "bad") throw new Error("seam down");
      return { examined: 1, flagged: 0 };
    });
    await expect(
      deathBoardStallTick({ activeOrgs: orgs("a", "bad", "c"), flagStalledForOrg, onError }),
    ).rejects.toThrow(/death_board_stall_sweep failed for 1 of 3 org/);
    expect(flagStalledForOrg.mock.calls.map((c) => c[0])).toEqual(["a", "bad", "c"]);
    expect(onError.mock.calls[0]?.[0]).toEqual({
      organizationId: "bad",
      job: "death_board_stall_sweep",
    });
  });
});
