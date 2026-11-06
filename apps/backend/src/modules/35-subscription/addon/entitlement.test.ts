import { describe, expect, it } from "vitest";
import {
  type AddonFacts,
  currentSubscriptionStatus,
  decideClaimsBillingEntitlement,
  decideSubscriptionWorkBlock,
} from "./entitlement";

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

// Owner decision D1 (2026-11-06): the subscription rule outlives the add-on.
describe("decideSubscriptionWorkBlock", () => {
  it("blocks a suspended, canceled or paused subscription with its own reason, and no other status", () => {
    expect(decideSubscriptionWorkBlock("suspended")).toEqual({
      blocked: true,
      reason: "subscription_suspended",
    });
    expect(decideSubscriptionWorkBlock("canceled")).toEqual({
      blocked: true,
      reason: "subscription_canceled",
    });
    expect(decideSubscriptionWorkBlock("paused")).toEqual({
      blocked: true,
      reason: "subscription_paused",
    });
    for (const status of ["trialing", "active", "past_due", "at_risk"] as const) {
      expect(decideSubscriptionWorkBlock(status)).toEqual({ blocked: false });
    }
  });
});

describe("currentSubscriptionStatus", () => {
  it("prefers the one live row over older canceled / paused ones, and is null with no rows", () => {
    expect(currentSubscriptionStatus([])).toBeNull();
    expect(
      currentSubscriptionStatus([
        { status: "canceled" },
        { status: "active" },
        { status: "paused" },
      ]),
    ).toBe("active");
    expect(currentSubscriptionStatus([{ status: "suspended" }, { status: "canceled" }])).toBe(
      "suspended",
    );
  });

  it("falls back to the NEWEST canceled / paused row when none is live", () => {
    expect(currentSubscriptionStatus([{ status: "paused" }, { status: "canceled" }])).toBe(
      "paused",
    );
  });
});
