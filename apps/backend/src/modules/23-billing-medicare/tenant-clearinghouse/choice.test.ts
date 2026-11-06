import { describe, expect, it } from "vitest";
import {
  choiceOf,
  createClaimsBillingEntitlementReader,
  decideClaimsBilling,
  parseFallbackOrgIds,
  platformFallbackLookup,
} from "./choice";
import type { ConfigRow } from "./config-store";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOT_BLOCKED = { blockForOrg: async () => ({ blocked: false as const }) };
const row = (over: Partial<ConfigRow>): ConfigRow =>
  ({ vendor: "claimmd", mode: "test", status: "active", ...over }) as ConfigRow;

describe("claims-billing decision from the clearinghouse choice", () => {
  it("allows an active transmitting vendor, from the tenant's own row", () => {
    expect(decideClaimsBilling(choiceOf(row({ vendor: "stedi" }), null))).toEqual({
      entitled: true,
    });
    expect(decideClaimsBilling(choiceOf(row({ vendor: "claimmd" }), null))).toEqual({
      entitled: true,
    });
  });

  it("refuses `outside`", () => {
    const choice = choiceOf(row({ vendor: "outside", mode: null }), null);
    expect(decideClaimsBilling(choice)).toEqual({
      entitled: false,
      reason: "clearinghouse_outside",
    });
  });

  it("refuses a vendor that is not yet active", () => {
    for (const status of ["draft", "verified"] as const) {
      expect(decideClaimsBilling(choiceOf(row({ status }), null))).toEqual({
        entitled: false,
        reason: "clearinghouse_not_active",
      });
    }
  });

  it("refuses an org that chose nothing", () => {
    expect(decideClaimsBilling(choiceOf(null, null))).toEqual({
      entitled: false,
      reason: "clearinghouse_not_chosen",
    });
  });

  it("allows an org the operator named in the env fallback list, and refuses everyone else", () => {
    const lookup = platformFallbackLookup(parseFallbackOrgIds(ORG.toUpperCase()), "stedi", "test");
    expect(decideClaimsBilling(choiceOf(null, lookup(ORG)))).toEqual({ entitled: true });
    expect(choiceOf(null, lookup(ORG))).toMatchObject({ vendor: "stedi", source: "platform_env" });
    expect(
      decideClaimsBilling(choiceOf(null, lookup("22222222-2222-4222-8222-222222222222"))),
    ).toMatchObject({
      entitled: false,
    });
  });

  it("a row wins over the fallback (an org that chose `outside` stays outside)", () => {
    const lookup = platformFallbackLookup(parseFallbackOrgIds(ORG), "stedi", "test");
    const choice = choiceOf(row({ vendor: "outside", mode: null }), lookup(ORG));
    expect(choice.source).toBe("tenant");
    expect(decideClaimsBilling(choice)).toMatchObject({
      entitled: false,
      reason: "clearinghouse_outside",
    });
  });

  it("refuses boot on a malformed id, or on named orgs with no env vendor", () => {
    expect(() => parseFallbackOrgIds("demo")).toThrow(/organization uuids/);
    // the boot parser and the env validator are ONE definition: a blank entry is refused by both
    expect(() => parseFallbackOrgIds(",,")).toThrow(/organization uuids/);
    expect(() => parseFallbackOrgIds(`${ORG},,${ORG}`)).toThrow(/organization uuids/);
    expect(parseFallbackOrgIds(undefined).size).toBe(0);
    expect(() => platformFallbackLookup(new Set([ORG]), null, "test")).toThrow(/not bound/);
    expect(() => platformFallbackLookup(new Set(), null, "test")).not.toThrow();
  });

  it("the entitlement reader asks the choice reader and passes a failure through (the gate then fails closed)", async () => {
    const ok = createClaimsBillingEntitlementReader(
      { choiceForOrg: async () => choiceOf(row({}), null) },
      NOT_BLOCKED,
    );
    expect(await ok.entitlementForOrg(ORG)).toEqual({ entitled: true });
    const broken = createClaimsBillingEntitlementReader(
      {
        choiceForOrg: async () => {
          throw new Error("db down");
        },
      },
      NOT_BLOCKED,
    );
    await expect(broken.entitlementForOrg(ORG)).rejects.toThrow("db down");
  });
});

// Owner decision D1 (2026-11-06): a suspended, paused or canceled ChartWarden subscription still blocks NEW claims and
// eligibility work, whatever the tenant's clearinghouse says. (The add-on went away; the subscription did not.)
describe("a blocked subscription still blocks new claims work, regardless of the clearinghouse", () => {
  const blocked = (
    reason: "subscription_suspended" | "subscription_paused" | "subscription_canceled",
  ) => ({
    blockForOrg: async () => ({ blocked: true as const, reason }),
  });
  const ACTIVE = choiceOf(row({ vendor: "stedi" }), null);
  const CHOICES = [
    ["an active vendor", ACTIVE],
    ["outside", choiceOf(row({ vendor: "outside", mode: null }), null)],
    ["nothing chosen", choiceOf(null, null)],
  ] as const;

  for (const reason of [
    "subscription_suspended",
    "subscription_paused",
    "subscription_canceled",
  ] as const) {
    for (const [label, choice] of CHOICES) {
      it(`refuses with ${reason} for ${label}`, async () => {
        const reader = createClaimsBillingEntitlementReader(
          { choiceForOrg: async () => choice },
          blocked(reason),
        );
        expect(await reader.entitlementForOrg(ORG)).toEqual({ entitled: false, reason });
      });
    }
  }

  it("falls through to the clearinghouse decision when the subscription is not blocked", async () => {
    const reader = createClaimsBillingEntitlementReader(
      { choiceForOrg: async () => choiceOf(null, null) },
      NOT_BLOCKED,
    );
    expect(await reader.entitlementForOrg(ORG)).toEqual({
      entitled: false,
      reason: "clearinghouse_not_chosen",
    });
  });

  it("fails closed (the read throws) when the subscription status cannot be read", async () => {
    const reader = createClaimsBillingEntitlementReader(
      { choiceForOrg: async () => ACTIVE },
      {
        blockForOrg: async () => {
          throw new Error("subscription read failed");
        },
      },
    );
    await expect(reader.entitlementForOrg(ORG)).rejects.toThrow("subscription read failed");
  });
});
