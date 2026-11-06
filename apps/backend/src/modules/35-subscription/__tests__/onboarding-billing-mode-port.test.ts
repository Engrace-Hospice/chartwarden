// M35's adapter for the operator's switch out of `outside`: it maps the operator onto the pricing service's write actor, passes the one flag
// that lets the mode through the outside invariant, and puts the mode back to none when the vendor change failed.
import { describe, expect, it } from "vitest";
import { buildOnboardingBillingModePort } from "../pricing/onboarding-billing-mode-port";

const OPERATOR = {
  userId: "op-user",
  membershipId: "op-member",
  organizationId: "platform-org",
  roles: ["platform_ops"],
  stepUpRecent: true,
};

function fakeContracts() {
  const calls: unknown[][] = [];
  return {
    calls,
    contracts: {
      hasLiveContract: async (org: string) => {
        calls.push(["hasLiveContract", org]);
        return org === "contracted";
      },
      setBillingServiceMode: async (...args: unknown[]) => {
        calls.push(["setBillingServiceMode", ...args]);
        return {} as never;
      },
      setModeNoneForOutsideBilling: async (...args: unknown[]) => {
        calls.push(["setModeNone", ...args]);
        return { changed: true };
      },
    },
  };
}

describe("buildOnboardingBillingModePort", () => {
  it("asks the contract service whether the tenant has a live contract", async () => {
    const { contracts } = fakeContracts();
    const port = buildOnboardingBillingModePort(() => contracts);
    expect(await port.hasContract("contracted")).toBe(true);
    expect(await port.hasContract("bare")).toBe(false);
  });

  it("sets the mode as the operator (their own org, their ids), for the tenant's slug, with the reason, passing the outside invariant", async () => {
    const { contracts, calls } = fakeContracts();
    await buildOnboardingBillingModePort(() => contracts).setModeLeavingOutside(
      OPERATOR,
      "cedar-ridge",
      "managed_billing",
      "the customer moves to the vendor, ticket CHG-9001",
    );
    expect(calls).toEqual([
      [
        "setBillingServiceMode",
        {
          organizationId: "platform-org",
          userId: "op-user",
          roles: ["platform_ops"],
          membershipId: "op-member",
          stepUpRecent: true,
        },
        "cedar-ridge",
        "managed_billing",
        "the customer moves to the vendor, ticket CHG-9001",
        { leavingOutside: true },
      ],
    ]);
  });

  it("puts the tenant back to none through the system's own outside-means-none path", async () => {
    const { contracts, calls } = fakeContracts();
    await buildOnboardingBillingModePort(() => contracts).restoreNone("org-1");
    expect(calls[0]?.slice(0, 2)).toEqual(["setModeNone", "org-1"]);
    expect(calls[0]?.[2]).toMatchObject({ kind: "system" }); // no ambient request in a unit test
  });

  it("resolves the contract service when it is USED, not when the port is built (it is built after the port)", async () => {
    const holder: { current?: ReturnType<typeof fakeContracts>["contracts"] } = {};
    const port = buildOnboardingBillingModePort(() => {
      if (!holder.current) throw new Error("not bound yet");
      return holder.current;
    });
    holder.current = fakeContracts().contracts;
    expect(await port.hasContract("contracted")).toBe(true);
  });
});
