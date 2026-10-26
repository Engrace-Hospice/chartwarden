import { describe, expect, it } from "vitest";
import {
  ELIGIBILITY_VENDOR_ENV,
  bindEligibilityTransport,
  parseEligibilityVendor,
} from "./eligibility-vendor-registry";
import { createInMemoryHarness } from "./in-memory-transport";
import { CH, type ClearinghouseTransport } from "./types";

const fakeEpisodeAlert = (): ClearinghouseTransport => ({
  ...createInMemoryHarness().transport,
  vendor: "episode_alert",
});

describe("parseEligibilityVendor", () => {
  it("treats unset and blank as unbound", () => {
    expect(parseEligibilityVendor(undefined, true)).toBeNull();
    expect(parseEligibilityVendor("  ", true)).toBeNull();
  });
  it("accepts episode_alert in production", () => {
    expect(parseEligibilityVendor("episode_alert", true)).toBe("episode_alert");
  });
  it("refuses in_memory in production but allows it elsewhere", () => {
    expect(() => parseEligibilityVendor("in_memory", true)).toThrow(/production/);
    expect(parseEligibilityVendor("in_memory", false)).toBe("in_memory");
  });
  it("refuses submission vendors and unknown values", () => {
    expect(() => parseEligibilityVendor("stedi", false)).toThrow(/one of/);
    expect(() => parseEligibilityVendor("direct_mac", false)).toThrow(/one of/);
    expect(() => parseEligibilityVendor("nope", false)).toThrow(/one of/);
  });
});

describe("bindEligibilityTransport", () => {
  it("fails closed with CH_NOT_WIRED when unset", async () => {
    const b = bindEligibilityTransport({}, {});
    expect(b.vendor).toBeNull();
    const r = await b.transport.checkEligibility(
      {
        organizationId: "o",
        providerEntityId: "p",
        payerId: "x",
        correlationId: "c",
        usage: "test",
      },
      { mbi: "1EG4TE5MK73", serviceDate: "2026-01-01" } as never,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.degraded.code).toBe(CH.NOT_WIRED);
  });
  it("throws at boot when the vendor has no registered adapter", () => {
    expect(() =>
      bindEligibilityTransport({ [ELIGIBILITY_VENDOR_ENV]: "episode_alert" }, {}),
    ).toThrow(/no adapter/);
  });
  it("throws on a vendor mismatch", () => {
    expect(() =>
      bindEligibilityTransport(
        { [ELIGIBILITY_VENDOR_ENV]: "episode_alert" },
        { episode_alert: () => createInMemoryHarness().transport },
      ),
    ).toThrow(/mismatch/);
  });
  it("binds the registered adapter, independent of CLEARINGHOUSE_VENDOR", () => {
    const b = bindEligibilityTransport(
      { [ELIGIBILITY_VENDOR_ENV]: "episode_alert", CLEARINGHOUSE_VENDOR: "stedi" },
      { episode_alert: fakeEpisodeAlert },
    );
    expect(b.vendor).toBe("episode_alert");
  });
});
