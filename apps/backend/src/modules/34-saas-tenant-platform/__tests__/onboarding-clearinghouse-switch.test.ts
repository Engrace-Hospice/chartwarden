// An operator's clearinghouse write that LEAVES `outside` for a vendor: a tenant that bills outside is on billing mode none, so while it
// has a contract the operator must name the mode in the same write. Judged from the tenant's current choice and contract, never guessed.
import { ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import type { OnboardingBillingModePort } from "../../../bootstrap/onboarding-billing-mode-port";
import type { OnboardingClearinghousePort } from "../../../bootstrap/onboarding-clearinghouse-port";
import { planClearinghouseSwitch } from "../routes/platform/onboarding-clearinghouse-switch";

const SCOPE = { organizationId: "org-1" } as never;
const clearinghouse = (view: object): Pick<OnboardingClearinghousePort, "get"> => ({
  get: async () => view,
});
const billing = (hasContract: boolean): Pick<OnboardingBillingModePort, "hasContract"> => ({
  hasContract: async () => hasContract,
});
const OUTSIDE = { vendor: "outside", source: "tenant" };
const VENDOR = { vendor: "claimmd", source: "tenant" };
const NOTHING = { vendor: null, source: "none" };

/** `"unbound"`: a deployment without pricing (no billing mode port at all). */
const plan = (
  view: object,
  fields: Record<string, unknown>,
  contract: boolean | "unbound" = true,
) =>
  planClearinghouseSwitch(
    {
      clearinghouse: clearinghouse(view),
      ...(contract === "unbound" ? {} : { billingMode: billing(contract) }),
    },
    SCOPE,
    fields,
  );

const validationOf = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).details?.[0];
};

describe("planClearinghouseSwitch", () => {
  it("requires the billing mode when a contracted tenant leaves outside for a vendor, naming the field", async () => {
    const detail = await validationOf(plan(OUTSIDE, { vendor: "claimmd", mode: "production" }));
    expect(detail).toMatchObject({
      field: "billingServiceMode",
      code: "BILLING_SERVICE_MODE_REQUIRED",
    });
  });

  it("hands back the mode and the body WITHOUT it (the clearinghouse body never carries the billing mode)", async () => {
    const result = await plan(OUTSIDE, {
      vendor: "claimmd",
      mode: "production",
      secret: "fake-key-not-a-secret#1",
      billingServiceMode: "managed_billing",
    });
    expect(result.billingServiceMode).toBe("managed_billing");
    expect(result.body).toEqual({
      vendor: "claimmd",
      mode: "production",
      secret: "fake-key-not-a-secret#1",
    });
  });

  it("accepts an explicit none as the answer (the operator chooses to keep the tenant unbilled)", async () => {
    expect(
      (await plan(OUTSIDE, { vendor: "stedi", mode: "test", billingServiceMode: "none" }))
        .billingServiceMode,
    ).toBe("none");
  });

  it("asks nothing of a tenant with no contract: there is no mode to set", async () => {
    const result = await plan(OUTSIDE, { vendor: "claimmd", mode: "production" }, false);
    expect(result.billingServiceMode).toBeNull();
  });

  it("asks nothing for a first choice, a vendor-to-vendor change, a stay-outside write, or a deployment without pricing", async () => {
    for (const [view, fields, contract] of [
      [NOTHING, { vendor: "claimmd", mode: "production" }, true],
      [VENDOR, { vendor: "stedi", mode: "test" }, true],
      [OUTSIDE, { vendor: "outside" }, true],
      [OUTSIDE, { vendor: "claimmd", mode: "production" }, "unbound"],
    ] as const) {
      const result = await plan(view, { ...fields }, contract);
      expect(result.billingServiceMode).toBeNull();
    }
  });

  it("refuses a billing mode on any other write, so a field is never silently ignored", async () => {
    for (const [view, contract] of [
      [NOTHING, true],
      [VENDOR, true],
      [OUTSIDE, false],
    ] as const) {
      const detail = await validationOf(
        plan(
          view,
          { vendor: "claimmd", mode: "production", billingServiceMode: "billing_software" },
          contract,
        ),
      );
      expect(detail).toMatchObject({ code: "BILLING_SERVICE_MODE_NOT_APPLICABLE" });
    }
    const noPricing = await validationOf(
      plan(
        OUTSIDE,
        { vendor: "claimmd", mode: "production", billingServiceMode: "none" },
        "unbound",
      ),
    );
    expect(noPricing).toMatchObject({ code: "BILLING_SERVICE_MODE_NOT_APPLICABLE" });
  });

  it("does not look at the contract unless the tenant is leaving outside", async () => {
    let asked = 0;
    const result = await planClearinghouseSwitch(
      {
        clearinghouse: clearinghouse(VENDOR),
        billingMode: {
          hasContract: async () => {
            asked += 1;
            return true;
          },
        },
      },
      SCOPE,
      { vendor: "stedi", mode: "test" },
    );
    expect(result.billingServiceMode).toBeNull();
    expect(asked).toBe(0);
  });
});
