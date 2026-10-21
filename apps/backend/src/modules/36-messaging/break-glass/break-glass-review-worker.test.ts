// ADR-0087 S4 - the overdue-review tick fans out over the active orgs, totals the result, and isolates an org failure (every other org is
// still attempted; the tick then fails so BullMQ retries and the DLQ alert fires). The overdue query itself is proven live.
import { describe, expect, it, vi } from "vitest";
import { breakGlassReviewTick } from "./break-glass-review-worker";

const orgs = (...ids: string[]) => ({
  listActiveOrgs: async () => ids.map((organizationId) => ({ organizationId })),
});

describe("breakGlassReviewTick", () => {
  it("sums the overdue reviews across the active orgs", async () => {
    const overdueForOrg = vi.fn(async (org: string) => ({ overdue: org === "a" ? 2 : 1 }));
    const totals = await breakGlassReviewTick({ activeOrgs: orgs("a", "b"), overdueForOrg });
    expect(totals).toEqual({ overdue: 3 });
    expect(overdueForOrg.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("an org that fails does not stop the others; the tick then fails and the failure is reported with ids only", async () => {
    const onError = vi.fn();
    const overdueForOrg = vi.fn(async (org: string) => {
      if (org === "bad") throw new Error("alert seam down");
      return { overdue: 1 };
    });
    await expect(
      breakGlassReviewTick({ activeOrgs: orgs("a", "bad", "c"), overdueForOrg, onError }),
    ).rejects.toThrow(/break_glass_review_sweep failed for 1 of 3 org/);
    expect(overdueForOrg.mock.calls.map((c) => c[0])).toEqual(["a", "bad", "c"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toEqual({
      organizationId: "bad",
      job: "break_glass_review_sweep",
    });
  });

  it("with no active org it does nothing", async () => {
    const overdueForOrg = vi.fn(async () => ({ overdue: 0 }));
    expect(await breakGlassReviewTick({ activeOrgs: orgs(), overdueForOrg })).toEqual({
      overdue: 0,
    });
    expect(overdueForOrg).not.toHaveBeenCalled();
  });
});
