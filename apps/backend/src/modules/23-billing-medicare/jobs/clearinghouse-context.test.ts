import { describe, expect, it } from "vitest";
import {
  CLAIMMD_M23_PAYER_ROUTES_ENV,
  CLEARINGHOUSE_PAYER_ID_ENV,
  type ClaimMdM23PayerRoute,
  buildClearinghouseContextPort,
  resolveClaimMdM23PayerRoute,
} from "./clearinghouse-context";

const base: ClaimMdM23PayerRoute = {
  organizationId: "org-a",
  providerEntityId: "provider-a",
  macJurisdiction: "mac-a",
  accountReference: "shared-test-account",
  usage: "test",
  payerId: "synthetic-vendor-payer-a",
  effectiveFrom: "2026-01-01",
};
const input = (
  routes: readonly ClaimMdM23PayerRoute[],
  over: Partial<Parameters<typeof resolveClaimMdM23PayerRoute>[0]> = {},
) =>
  resolveClaimMdM23PayerRoute({
    routes,
    organizationId: "org-a",
    providerEntityId: "provider-a",
    macJurisdiction: "mac-a",
    accountReference: "shared-test-account",
    usage: "test",
    at: new Date("2026-11-07T00:00:00Z"),
    ...over,
  });

describe("M23 Claim.MD payer route resolution", () => {
  it("selects only an active exact tenant/provider/MAC/account/environment route", () => {
    const route = input([base]);
    expect(route.payerId).toBe("synthetic-vendor-payer-a");
    expect(route.routeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports distinct provider routes and MAC jurisdictions", () => {
    const second = {
      ...base,
      providerEntityId: "provider-b",
      macJurisdiction: "mac-b",
      payerId: "synthetic-vendor-payer-b",
    };
    expect(
      input([base, second], { providerEntityId: "provider-b", macJurisdiction: "mac-b" }).payerId,
    ).toBe("synthetic-vendor-payer-b");
  });

  it("does not match another tenant even when provider, MAC and account are the same", () => {
    expect(() => input([base], { organizationId: "org-b" })).toThrow(
      "CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE",
    );
  });

  it("separates test and production usage and account references", () => {
    expect(() => input([base], { usage: "production" })).toThrow(
      "CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE",
    );
    expect(() => input([base], { accountReference: "other-account" })).toThrow(
      "CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE",
    );
  });

  it("rejects missing or expired routes", () => {
    expect(() => input([])).toThrow("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
    expect(() => input([{ ...base, effectiveTo: "2026-11-06" }])).toThrow(
      "CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE",
    );
  });

  it("rejects malformed or inverted effective dates explicitly", () => {
    expect(() => input([{ ...base, effectiveFrom: "not-a-date" }])).toThrow(
      "CLAIMMD_PAYER_ROUTE_INVALID_DATES",
    );
    expect(() =>
      input([{ ...base, effectiveFrom: "2026-12-01", effectiveTo: "2026-11-01" }]),
    ).toThrow("CLAIMMD_PAYER_ROUTE_INVALID_DATES");
  });

  it("rejects overlapping active configuration as ambiguous", () => {
    expect(() => input([base, { ...base, payerId: "other-synthetic-id" }])).toThrow(
      "CLAIMMD_PAYER_ROUTE_AMBIGUOUS",
    );
  });

  it("rejects blank payer identifiers instead of falling back to the MAC", () => {
    expect(() => input([{ ...base, payerId: " " }])).toThrow("CLAIMMD_PAYER_ROUTE_INVALID");
  });

  it("does not let the legacy global override authorize a Claim.MD route", () => {
    expect(() =>
      buildClearinghouseContextPort({
        db: {} as never,
        env: {
          CLEARINGHOUSE_VENDOR: "claimmd",
          [CLEARINGHOUSE_PAYER_ID_ENV]: "global-id",
          CLAIMMD_ACCOUNT_REFERENCE: "shared-test-account",
          CLAIMMD_ACCOUNT_USAGE: "test",
          [CLAIMMD_M23_PAYER_ROUTES_ENV]: JSON.stringify([base]),
        },
        providerNpi: async () => "synthetic-npi",
      }),
    ).toThrow(/cannot authorize Claim\.MD payer routing/);
  });

  it("rejects malformed central route configuration", () => {
    expect(() =>
      buildClearinghouseContextPort({
        db: {} as never,
        env: {
          [CLAIMMD_M23_PAYER_ROUTES_ENV]: "not-json",
          CLEARINGHOUSE_VENDOR: "claimmd",
          CLAIMMD_ACCOUNT_USAGE: "test",
        },
        providerNpi: async () => null,
      }),
    ).toThrow(/must be a valid array/);
  });
});
