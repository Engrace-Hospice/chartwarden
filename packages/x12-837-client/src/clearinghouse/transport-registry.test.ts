import { describe, expect, it } from "vitest";
import { createInMemoryHarness } from "./in-memory-transport";
import {
  CLEARINGHOUSE_VENDOR_ENV,
  bindClearinghouseTransport,
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
