// The hourly sweep's "outside means none" backstop: it asks the contract service only for an org whose clearinghouse is outside, as the
// system, and resolves the contract service when it is used (the sweep is wired before the service exists).
import { describe, expect, it } from "vitest";
import { SYSTEM_TRIGGER } from "../pricing/mode-trigger";
import { createOutsideModeReconciler } from "../pricing/outside-reconcile";

function setup(outsideOrgs: readonly string[]) {
  const calls: unknown[][] = [];
  const reconcile = createOutsideModeReconciler({
    billsOutside: async (org) => outsideOrgs.includes(org),
    contracts: () => ({
      setModeNoneForOutsideBilling: async (...args: unknown[]) => {
        calls.push(args);
        return { changed: true };
      },
    }),
  });
  return { reconcile, calls };
}

describe("createOutsideModeReconciler", () => {
  it("applies outside-means-none, as the system, for an org that bills outside", async () => {
    const { reconcile, calls } = setup(["org-out"]);
    await reconcile("org-out");
    expect(calls).toEqual([["org-out", SYSTEM_TRIGGER]]);
  });

  it("does nothing for an org that has a vendor or chose nothing", async () => {
    const { reconcile, calls } = setup(["org-out"]);
    await reconcile("org-vendor");
    await reconcile("org-none");
    expect(calls).toEqual([]);
  });

  it("resolves the contract service when USED, not when built", async () => {
    const holder: {
      current?: { setModeNoneForOutsideBilling: () => Promise<{ changed: boolean }> };
    } = {};
    const reconcile = createOutsideModeReconciler({
      billsOutside: async () => true,
      contracts: () => {
        if (!holder.current) throw new Error("the pricing contract service is not bound");
        return holder.current;
      },
    });
    await expect(reconcile("org-out")).rejects.toThrow(/not bound/); // loud, never a silent skip
    holder.current = { setModeNoneForOutsideBilling: async () => ({ changed: false }) };
    await expect(reconcile("org-out")).resolves.toBeUndefined();
  });

  it("lets a failing choice read or contract write propagate (the sweep logs it and still computes the statement)", async () => {
    const reconcile = createOutsideModeReconciler({
      billsOutside: async () => {
        throw new Error("choice read failed");
      },
      contracts: () => ({ setModeNoneForOutsideBilling: async () => ({ changed: true }) }),
    });
    await expect(reconcile("org-1")).rejects.toThrow(/choice read failed/);
  });
});
