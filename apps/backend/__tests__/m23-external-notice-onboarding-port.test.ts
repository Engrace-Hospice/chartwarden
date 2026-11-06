// The platform notice seam's audit detail for a withdrawal (round 3, M1): the operator's audit row says what became of the breach
// stamp: `cleared` (the withdrawn LATE record wrote it itself, with its date), `kept` (the watchdog set it) or `none`. The rule
// itself is `planExternalFilingWithdrawal` (pure) through `withdrawExternalNoticeFiling`; the SQL is proven in
// `test:m23:tenant-clearinghouse:live`. No database: the transaction only answers the scope check.
import { beforeEach, describe, expect, it, vi } from "vitest";

const withdrawn = vi.hoisted(() => ({
  next: {} as Record<string, unknown>,
}));

vi.mock("../src/modules/23-billing-medicare/services/external-notice-filing", () => ({
  withdrawExternalNoticeFiling: async () => withdrawn.next,
}));

import { buildExternalNoticeOnboardingPort } from "../src/modules/23-billing-medicare/services/external-notice-onboarding-port";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const RECORDED_AT = "2026-11-09T10:30:00.123Z";
const tx = { execute: async () => ({ rows: [{ org_id: ORG }] }) } as never;

const result = (over: Record<string, unknown>) => ({
  notice: {
    id: "n-1",
    state: "ready",
    windowTargetAt: "2026-11-06",
    windowBreachedAt: null,
    ...((over.notice as object | undefined) ?? {}),
  },
  withdrawnFiledOn: "2026-11-08",
  withdrawnRecordedAt: RECORDED_AT,
  clearedBreachStamp: null,
  ...over,
});

const withdraw = () =>
  buildExternalNoticeOnboardingPort().withdrawExternalFiling(tx, { organizationId: ORG } as never, {
    kind: "noe",
    noticeId: "n-1",
    expectedRecordedAt: RECORDED_AT,
  });

beforeEach(() => {
  withdrawn.next = {};
});

describe("the notice seam's withdrawal audit detail", () => {
  it("names the breach stamp the withdrawn late record wrote, now cleared, and shows the notice with no stamp", async () => {
    withdrawn.next = result({ clearedBreachStamp: "2026-11-08" });
    const done = await withdraw();
    expect(done.detail).toEqual({
      noticeKind: "noe",
      withdrawnFiledOn: "2026-11-08",
      withdrawnRecordedAt: RECORDED_AT,
      breachStamp: "cleared",
      clearedBreachStamp: "2026-11-08",
    });
    expect(done.view.windowBreachedAt).toBeNull();
  });

  it("says `kept` when a stamp the watchdog set remains, and `none` when there never was one", async () => {
    withdrawn.next = result({ notice: { windowBreachedAt: "2026-11-07" } });
    const kept = await withdraw();
    expect(kept.detail).toMatchObject({ breachStamp: "kept" });
    expect(kept.detail).not.toHaveProperty("clearedBreachStamp");
    expect(kept.view.windowBreachedAt).toBe("2026-11-07");

    withdrawn.next = result({});
    expect((await withdraw()).detail).toMatchObject({ breachStamp: "none" });
  });
});
