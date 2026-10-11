import {
  CH,
  CLEARINGHOUSE_VENDOR_ENV as REGISTRY_ENV,
  PRODUCTION_CLEARINGHOUSE_VENDORS as REGISTRY_PRODUCTION_VENDORS,
  parseClearinghouseVendor,
} from "@wardenx/x12-837-client";
import { describe, expect, it } from "vitest";
import { CLEARINGHOUSE_VENDOR_ENV, PRODUCTION_CLEARINGHOUSE_VENDORS } from "../src/bootstrap/env";
import {
  CLEARINGHOUSE_FACTORIES,
  bindPlatformClearinghouse,
  describeClearinghouseBinding,
} from "../src/modules/23-billing-medicare/clearinghouse-binding";

describe("platform clearinghouse binding", () => {
  it("no adapter is compiled in yet, so naming a vendor fails the boot", () => {
    expect(Object.keys(CLEARINGHOUSE_FACTORIES)).toEqual([]);
    expect(() => bindPlatformClearinghouse({ CLEARINGHOUSE_VENDOR: "stedi" })).toThrow(
      /no adapter/i,
    );
  });
  it("unset is the logged, unbound state and every call answers CH_NOT_WIRED", async () => {
    const binding = bindPlatformClearinghouse({});
    expect(binding.transport.vendor).toBe("not_wired");
    expect(describeClearinghouseBinding(binding)).toBe(
      "Clearinghouse binding: unbound (CH_NOT_WIRED)",
    );
    const r = await binding.transport.fetchRemittances(
      {
        organizationId: "o",
        providerEntityId: "p",
        payerId: "x",
        correlationId: "c",
        usage: "production",
      },
      null,
    );
    expect(r).toMatchObject({ ok: false, degraded: { code: CH.NOT_WIRED } });
  });

  it("env.ts's production vendor list agrees with the registry", () => {
    expect(CLEARINGHOUSE_VENDOR_ENV).toBe(REGISTRY_ENV);
    expect([...PRODUCTION_CLEARINGHOUSE_VENDORS].sort()).toEqual(
      [...REGISTRY_PRODUCTION_VENDORS].sort(),
    );
    for (const v of PRODUCTION_CLEARINGHOUSE_VENDORS) {
      expect(parseClearinghouseVendor(v, true)).toBe(v);
    }
    expect(() => parseClearinghouseVendor("in_memory", true)).toThrow();
  });
});
