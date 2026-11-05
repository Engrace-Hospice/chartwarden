import { describe, expect, it } from "vitest";
import { type AddonFacts, decideClaimsBillingEntitlement } from "./entitlement";

const NOW = new Date("2026-11-05T12:00:00Z");
const LATER = new Date("2026-12-01T00:00:00Z");
const EARLIER = new Date("2026-11-01T00:00:00Z");
const row = (over: Partial<AddonFacts> = {}): AddonFacts => ({
  status: "active",
  trialEndsAt: null,
  endsAt: null,
  subscriptionStatus: "active",
  ...over,
});

describe("decideClaimsBillingEntitlement (ADR-0108 D3)", () => {
  it("denies never_purchased when the org never held the add-on", () => {
    expect(decideClaimsBillingEntitlement(null, NOW)).toEqual({
      entitled: false,
      reason: "never_purchased",
    });
  });

  it.each(["trialing", "active", "past_due", "at_risk"] as const)(
    "entitles an active add-on on a %s subscription",
    (subscriptionStatus) => {
      expect(decideClaimsBillingEntitlement(row({ subscriptionStatus }), NOW)).toEqual({
        entitled: true,
      });
    },
  );

  it.each([
    ["suspended", "subscription_suspended"],
    ["canceled", "subscription_canceled"],
    ["paused", "subscription_paused"],
  ] as const)("denies a live add-on on a %s subscription with %s", (subscriptionStatus, reason) => {
    expect(decideClaimsBillingEntitlement(row({ subscriptionStatus }), NOW)).toEqual({
      entitled: false,
      reason,
    });
  });

  it("entitles a trial until it ends, then lapses", () => {
    expect(
      decideClaimsBillingEntitlement(row({ status: "trialing", trialEndsAt: LATER }), NOW),
    ).toEqual({ entitled: true });
    expect(
      decideClaimsBillingEntitlement(row({ status: "trialing", trialEndsAt: EARLIER }), NOW),
    ).toEqual({ entitled: false, reason: "lapsed" });
  });

  it("lapses a canceled row and a row past its scheduled end", () => {
    expect(decideClaimsBillingEntitlement(row({ status: "canceled" }), NOW)).toEqual({
      entitled: false,
      reason: "lapsed",
    });
    expect(decideClaimsBillingEntitlement(row({ endsAt: EARLIER }), NOW)).toEqual({
      entitled: false,
      reason: "lapsed",
    });
  });
});
