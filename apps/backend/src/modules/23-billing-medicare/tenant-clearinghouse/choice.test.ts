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
    expect(parseFallbackOrgIds(undefined).size).toBe(0);
    expect(() => platformFallbackLookup(new Set([ORG]), null, "test")).toThrow(/not bound/);
    expect(() => platformFallbackLookup(new Set(), null, "test")).not.toThrow();
  });

  it("the entitlement reader asks the choice reader and passes a failure through (the gate then fails closed)", async () => {
    const ok = createClaimsBillingEntitlementReader({
      choiceForOrg: async () => choiceOf(row({}), null),
    });
    expect(await ok.entitlementForOrg(ORG)).toEqual({ entitled: true });
    const broken = createClaimsBillingEntitlementReader({
      choiceForOrg: async () => {
        throw new Error("db down");
      },
    });
    await expect(broken.entitlementForOrg(ORG)).rejects.toThrow("db down");
  });
});
