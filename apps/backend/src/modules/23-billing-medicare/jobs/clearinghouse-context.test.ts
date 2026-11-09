import { describe, expect, it } from "vitest";
import { tenantClaimMdAccountReference } from "../claimmd-evidence/store";
import {
  buildClaimPayerRouteStatus,
  buildClearinghouseContextPort,
  CLAIMMD_M23_PAYER_ROUTES_ENV,
  CLEARINGHOUSE_PAYER_ID_ENV,
  resolveClaimMdM23PayerRoute,
  type ClaimMdM23PayerRoute,
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
const input = (routes: readonly ClaimMdM23PayerRoute[], over: Partial<Parameters<typeof resolveClaimMdM23PayerRoute>[0]> = {}) =>
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
    expect(input([base, second], { providerEntityId: "provider-b", macJurisdiction: "mac-b" }).payerId)
      .toBe("synthetic-vendor-payer-b");
  });

  it("does not match another tenant even when provider, MAC and account are the same", () => {
    expect(() => input([base], { organizationId: "org-b" })).toThrow("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
  });

  it("separates test and production usage and account references", () => {
    expect(() => input([base], { usage: "production" })).toThrow("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
    expect(() => input([base], { accountReference: "other-account" })).toThrow("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
  });

  it("rejects missing or expired routes", () => {
    expect(() => input([])).toThrow("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
    expect(() => input([{ ...base, effectiveTo: "2026-11-06" }])).toThrow("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
  });

  it("rejects malformed or inverted effective dates explicitly", () => {
    expect(() => input([{ ...base, effectiveFrom: "not-a-date" }])).toThrow("CLAIMMD_PAYER_ROUTE_INVALID_DATES");
    expect(() => input([{ ...base, effectiveFrom: "2026-12-01", effectiveTo: "2026-11-01" }]))
      .toThrow("CLAIMMD_PAYER_ROUTE_INVALID_DATES");
  });

  it("rejects overlapping active configuration as ambiguous", () => {
    expect(() => input([base, { ...base, payerId: "other-synthetic-id" }])).toThrow("CLAIMMD_PAYER_ROUTE_AMBIGUOUS");
  });

  it("rejects blank payer identifiers instead of falling back to the MAC", () => {
    expect(() => input([{ ...base, payerId: " " }])).toThrow("CLAIMMD_PAYER_ROUTE_INVALID");
  });

  it("does not let the legacy global override authorize a Claim.MD route", () => {
    expect(() => buildClearinghouseContextPort({
      db: {} as never,
      env: {
        CLEARINGHOUSE_VENDOR: "claimmd",
        [CLEARINGHOUSE_PAYER_ID_ENV]: "global-id",
        CLAIMMD_ACCOUNT_REFERENCE: "shared-test-account",
        CLAIMMD_ACCOUNT_USAGE: "test",
        [CLAIMMD_M23_PAYER_ROUTES_ENV]: JSON.stringify([base]),
      },
      providerNpi: async () => "synthetic-npi",
    })).toThrow(/cannot authorize Claim\.MD payer routing/);
  });

  it("rejects malformed central route configuration", () => {
    expect(() => buildClearinghouseContextPort({
      db: {} as never,
      env: { [CLAIMMD_M23_PAYER_ROUTES_ENV]: "not-json", CLEARINGHOUSE_VENDOR: "claimmd", CLAIMMD_ACCOUNT_USAGE: "test" },
      providerNpi: async () => null,
    })).toThrow(/must be a valid array/);
  });
});

// ── Claim.MD payer routing follows the ORG's resolved binding (vendor + account), never the platform env vendor ──────────
// A tenant-owned Claim.MD account resolves its route under `tenant:<org>`; a Stedi org never needs a route; the platform's own
// Claim.MD account (and the orgs it serves) keeps the platform reference. Each of the platform vendor settings is exercised.
const ORG = "org-a";
const tenantRoute: ClaimMdM23PayerRoute = {
  ...base,
  accountReference: tenantClaimMdAccountReference(ORG),
  payerId: "synthetic-tenant-account-payer",
};
const platformRoute: ClaimMdM23PayerRoute = {
  ...base,
  accountReference: "platform-account",
  payerId: "synthetic-platform-account-payer",
};
const PLATFORM_CLAIMMD = {
  CLEARINGHOUSE_VENDOR: "claimmd",
  CLAIMMD_ACCOUNT_REFERENCE: "platform-account",
  CLAIMMD_ACCOUNT_USAGE: "test",
};
const routesEnv = (...routes: readonly ClaimMdM23PayerRoute[]) => ({
  [CLAIMMD_M23_PAYER_ROUTES_ENV]: JSON.stringify(routes),
});
type Resolved = { readonly vendor: string | null; readonly account?: "tenant" };
const perOrg = (resolved: Resolved) => ({
  vendor: null,
  forOrg: async () => resolved,
});
const tenantClaimMd: Resolved = { vendor: "claimmd", account: "tenant" };
const tenantStedi: Resolved = { vendor: "stedi", account: "tenant" };
const platformAccount: Resolved = { vendor: "claimmd" }; // the platform binding: no `account`

// A fake tenant transaction: the MAC credential read answers one row; nothing else is touched.
const fakeTx = {
  execute: async () => [],
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => [{ macJurisdiction: "mac-a" }] }) }),
  }),
};
const fakeDb = { transaction: async (fn: (tx: unknown) => unknown) => fn(fakeTx) } as never;

const portFor = (
  env: Record<string, string>,
  binding: ReturnType<typeof perOrg>,
  usage: "test" | "production" | null = "test",
) =>
  buildClearinghouseContextPort({
    db: fakeDb,
    env,
    binding,
    usageFor: async () => usage,
    providerNpi: async () => "synthetic-npi",
  });

describe("the clearinghouse context follows the organization's own binding", () => {
  it("tenant-owned Claim.MD with the platform vendor unset resolves a route under its own account reference", async () => {
    const port = portFor(routesEnv(tenantRoute), perOrg(tenantClaimMd));
    const context = await port.contextFor(ORG, "provider-a");
    expect(context.payerId).toBe("synthetic-tenant-account-payer");
    expect(context.claimMdRouteFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("tenant-owned Claim.MD with the platform vendor on Stedi never takes the global payer override", async () => {
    const port = portFor(
      {
        CLEARINGHOUSE_VENDOR: "stedi",
        [CLEARINGHOUSE_PAYER_ID_ENV]: "global-id",
        ...routesEnv(tenantRoute),
      },
      perOrg(tenantClaimMd),
    );
    const context = await port.contextFor(ORG, "provider-a");
    expect(context.payerId).toBe("synthetic-tenant-account-payer");
  });

  it("tenant-owned Claim.MD with no route for its account is refused with the route code, even if the platform account has one", async () => {
    await expect(
      portFor(routesEnv(), perOrg(tenantClaimMd)).contextFor(ORG, "provider-a"),
    ).rejects.toThrow("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
    await expect(
      portFor(
        { ...PLATFORM_CLAIMMD, ...routesEnv(platformRoute) },
        perOrg(tenantClaimMd),
      ).contextFor(ORG, "provider-a"),
    ).rejects.toThrow("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
  });

  it("a tenant-owned account is matched on ITS mode, not the platform's", async () => {
    const port = portFor(
      { ...PLATFORM_CLAIMMD, ...routesEnv(tenantRoute) },
      perOrg(tenantClaimMd),
      "production",
    );
    await expect(port.contextFor(ORG, "provider-a")).rejects.toThrow(
      "CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE",
    );
  });

  it("platform Claim.MD with a tenant on Stedi: that org needs no Claim.MD route and gets no fingerprint", async () => {
    // The platform's routes are scoped to the platform account; the Stedi org has none, and must not be refused for it.
    const port = portFor({ ...PLATFORM_CLAIMMD, ...routesEnv(platformRoute) }, perOrg(tenantStedi));
    const context = await port.contextFor(ORG, "provider-a");
    expect(context.payerId).toBe("mac-a");
    expect(context.claimMdRouteFingerprint).toBeUndefined();
  });

  it("platform Claim.MD with a tenant on its own Claim.MD: the fingerprint is the tenant account's, not the platform's", async () => {
    const env = { ...PLATFORM_CLAIMMD, ...routesEnv(platformRoute, tenantRoute) };
    const tenant = await portFor(env, perOrg(tenantClaimMd)).contextFor(ORG, "provider-a");
    const platform = await portFor(env, perOrg(platformAccount)).contextFor(ORG, "provider-a");
    expect(tenant.payerId).toBe("synthetic-tenant-account-payer");
    expect(platform.payerId).toBe("synthetic-platform-account-payer");
    expect(tenant.claimMdRouteFingerprint).not.toBe(platform.claimMdRouteFingerprint);
  });

  it("platform Claim.MD serving a fallback org keeps today's behaviour (the platform account reference)", async () => {
    const port = portFor(
      { ...PLATFORM_CLAIMMD, ...routesEnv(platformRoute) },
      perOrg(platformAccount),
    );
    const context = await port.contextFor(ORG, "provider-a");
    expect(context.payerId).toBe("synthetic-platform-account-payer");
    expect(context.claimMdRouteFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("a pull (acks, remittances) never needs the payer route: a tenant account with no route still gets its context", async () => {
    // Only a claim is addressed to a payer. A tenant that chose Claim.MD before an operator added its route must not fail the shared
    // ack / remittance crons; its claims are refused at the route and at the worker instead.
    const port = portFor(routesEnv(), perOrg(tenantClaimMd));
    const context = await port.contextFor(ORG, "provider-a", { payerRoute: "skip" });
    expect(context.payerId).toBe("mac-a");
    expect(context.claimMdRouteFingerprint).toBeUndefined();
    await expect(port.contextFor(ORG, "provider-a")).rejects.toThrow(
      "CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE",
    );
  });

  it("without a binding the platform env vendor decides, as before", async () => {
    const port = buildClearinghouseContextPort({
      db: fakeDb,
      env: { ...PLATFORM_CLAIMMD, ...routesEnv(platformRoute) },
      providerNpi: async () => "synthetic-npi",
    });
    expect((await port.contextFor(ORG, "provider-a")).payerId).toBe(
      "synthetic-platform-account-payer",
    );
  });
});

describe("the claim payer-route readiness follows the organization's own binding", () => {
  const status = (
    env: Record<string, string>,
    binding: ReturnType<typeof perOrg>,
    payerIsActive = async () => true,
  ) =>
    buildClaimPayerRouteStatus({
      db: fakeDb,
      env,
      binding,
      usageFor: async () => "test",
      providerNpi: async () => "synthetic-npi",
      payerIsActive,
    })(ORG, "provider-a");

  it("tenant-owned Claim.MD is verified from its own route, with the platform vendor unset", async () => {
    const result = await status(routesEnv(tenantRoute), perOrg(tenantClaimMd));
    expect(result.status).toBe("verified");
  });

  it("tenant-owned Claim.MD with no route is not configured (the route code, never 'changed')", async () => {
    expect(await status(routesEnv(), perOrg(tenantClaimMd))).toEqual({
      status: "not_configured",
      reasonCode: "CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE",
    });
  });

  it("a tenant on Stedi under a platform Claim.MD account is not applicable (no route needed)", async () => {
    expect(
      await status({ ...PLATFORM_CLAIMMD, ...routesEnv(platformRoute) }, perOrg(tenantStedi)),
    ).toEqual({ status: "not_applicable" });
  });

  it("a Stedi org is not applicable when the platform vendor is unset", async () => {
    expect(await status({}, perOrg(tenantStedi))).toEqual({ status: "not_applicable" });
  });

  it("the platform Claim.MD account keeps its readiness check, including the active-payer gate", async () => {
    const env = { ...PLATFORM_CLAIMMD, ...routesEnv(platformRoute) };
    expect((await status(env, perOrg(platformAccount))).status).toBe("verified");
    expect(await status(env, perOrg(platformAccount), async () => false)).toEqual({
      status: "not_configured",
      reasonCode: "CLAIMMD_PAYER_ROUTE_PAYER_NOT_ACTIVE",
    });
  });

  it("an org whose binding cannot be resolved is not configured, never silently applicable", async () => {
    const broken = {
      vendor: null,
      forOrg: async () => {
        throw new Error("connection refused");
      },
    };
    expect(await status(routesEnv(tenantRoute), broken)).toEqual({
      status: "not_configured",
      reasonCode: "PAYER_ROUTE_NOT_VERIFIED",
    });
  });
});
