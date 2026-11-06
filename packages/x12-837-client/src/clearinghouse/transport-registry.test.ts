import { describe, expect, it } from "vitest";
import { createInMemoryHarness } from "./in-memory-transport";
import {
  CLEARINGHOUSE_VENDOR_ENV,
  type ClearinghouseBinding,
  UNBOUND_BINDING,
  bindClearinghouseTransport,
  bindingForOrg,
  isPerOrgBinding,
  parseClearinghouseVendor,
} from "./transport-registry";
import { CH } from "./types";

const CTX = {
  organizationId: "org-1",
  providerEntityId: "pe-1",
  payerId: "payer",
  correlationId: "c-1",
  usage: "test",
} as const;

const inMemoryFactory = () => createInMemoryHarness().transport;

describe("parseClearinghouseVendor", () => {
  it("treats unset, blank and whitespace as unbound", () => {
    expect(parseClearinghouseVendor(undefined, false)).toBeNull();
    expect(parseClearinghouseVendor("", false)).toBeNull();
    expect(parseClearinghouseVendor("   ", true)).toBeNull();
  });

  it("accepts the real vendors in any environment", () => {
    expect(parseClearinghouseVendor("stedi", true)).toBe("stedi");
    expect(parseClearinghouseVendor(" direct_mac ", true)).toBe("direct_mac");
  });

  it("refuses in_memory in production but allows it elsewhere", () => {
    expect(() => parseClearinghouseVendor("in_memory", true)).toThrow(/in_memory/);
    expect(parseClearinghouseVendor("in_memory", false)).toBe("in_memory");
  });

  it("refuses an unknown vendor", () => {
    expect(() => parseClearinghouseVendor("acme", false)).toThrow(/CLEARINGHOUSE_VENDOR/);
  });
});

describe("bindClearinghouseTransport", () => {
  it("unset: returns a not-wired transport whose every call answers CH_NOT_WIRED", async () => {
    const binding = bindClearinghouseTransport({ NODE_ENV: "production" }, {});
    expect(binding.vendor).toBeNull();
    const r = await binding.transport.submitClaim(CTX, {
      kind: "claim",
      controlNumber: "n",
      idempotencyKey: "k",
      payload: { format: "x12", x12: "ISA" },
    });
    expect(r).toEqual({
      ok: false,
      degraded: { code: CH.NOT_WIRED, reason: expect.any(String) },
    });
    expect((await binding.transport.fetchAcknowledgments(CTX, null)).ok).toBe(false);
  });

  it("vendor set with no registered adapter: throws at bind time (fail closed)", () => {
    expect(() =>
      bindClearinghouseTransport(
        { NODE_ENV: "production", [CLEARINGHOUSE_VENDOR_ENV]: "stedi" },
        {},
      ),
    ).toThrow(/stedi.*no adapter/i);
  });

  it("vendor set with a registered adapter: returns that adapter", () => {
    const binding = bindClearinghouseTransport(
      { NODE_ENV: "development", [CLEARINGHOUSE_VENDOR_ENV]: "in_memory" },
      { in_memory: inMemoryFactory },
    );
    expect(binding.vendor).toBe("in_memory");
    expect(binding.transport.vendor).toBe("in_memory");
  });

  it("refuses an adapter whose reported vendor differs from the configured one", () => {
    expect(() =>
      bindClearinghouseTransport(
        { NODE_ENV: "development", [CLEARINGHOUSE_VENDOR_ENV]: "stedi" },
        { stedi: inMemoryFactory },
      ),
    ).toThrow(/vendor mismatch/i);
  });

  it("in_memory in production is refused even when a factory is registered", () => {
    expect(() =>
      bindClearinghouseTransport(
        { NODE_ENV: "production", [CLEARINGHOUSE_VENDOR_ENV]: "in_memory" },
        { in_memory: inMemoryFactory },
      ),
    ).toThrow(/in_memory/);
  });
});

describe("bindingForOrg", () => {
  const stedi: ClearinghouseBinding = { vendor: "stedi", transport: inMemoryFactory() };

  it("returns the one binding when the platform binding is not per-organization", async () => {
    expect(await bindingForOrg(stedi, "org-1")).toBe(stedi);
    expect(isPerOrgBinding(stedi)).toBe(false);
  });

  it("returns each organization's own binding when the platform binding is per-organization", async () => {
    const claimmd: ClearinghouseBinding = { vendor: "claimmd", transport: inMemoryFactory() };
    const perOrg: ClearinghouseBinding = {
      ...UNBOUND_BINDING,
      forOrg: async (orgId) =>
        orgId === "org-1" ? stedi : orgId === "org-2" ? claimmd : UNBOUND_BINDING,
    };
    expect(isPerOrgBinding(perOrg)).toBe(true);
    expect((await bindingForOrg(perOrg, "org-1")).vendor).toBe("stedi");
    expect((await bindingForOrg(perOrg, "org-2")).vendor).toBe("claimmd");
    const none = await bindingForOrg(perOrg, "org-3");
    expect(none.vendor).toBeNull();
    const refused = await none.transport.submitClaim(CTX, {
      kind: "claim",
      controlNumber: "c",
      idempotencyKey: "k",
      payload: { format: "x12", x12: "" },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.degraded.code).toBe(CH.NOT_WIRED);
  });
});
