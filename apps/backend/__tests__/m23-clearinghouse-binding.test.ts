import {
  CH,
  InMemoryAttemptStore,
  CLEARINGHOUSE_VENDOR_ENV as REGISTRY_ENV,
  PRODUCTION_CLEARINGHOUSE_VENDORS as REGISTRY_PRODUCTION_VENDORS,
  parseClearinghouseVendor,
} from "@wardenx/x12-837-client";
import { describe, expect, it } from "vitest";
import { CLEARINGHOUSE_VENDOR_ENV, PRODUCTION_CLEARINGHOUSE_VENDORS } from "../src/bootstrap/env";
import {
  bindPlatformClearinghouse,
  buildClearinghouseFactories,
  describeClearinghouseBinding,
} from "../src/modules/23-billing-medicare/clearinghouse-binding";

describe("platform clearinghouse binding", () => {
  const deps = () => ({ attempts: new InMemoryAttemptStore() });

  it("registers exactly the adapters compiled into this build", () => {
    expect(Object.keys(buildClearinghouseFactories(deps())).sort()).toEqual(["stedi"]);
  });

  it("binds stedi from STEDI_API_KEY and logs the vendor, never the key", () => {
    const binding = bindPlatformClearinghouse(
      { CLEARINGHOUSE_VENDOR: "stedi", STEDI_API_KEY: "sk_do_not_log" },
      deps(),
    );
    expect(binding.vendor).toBe("stedi");
    expect(binding.transport.vendor).toBe("stedi");
    expect(describeClearinghouseBinding(binding)).toBe("Clearinghouse binding: stedi");
    expect(describeClearinghouseBinding(binding)).not.toContain("sk_do_not_log");
  });

  it("refuses to boot with stedi named but no key, naming only the variable", () => {
    expect(() => bindPlatformClearinghouse({ CLEARINGHOUSE_VENDOR: "stedi" }, deps())).toThrow(
      /STEDI_API_KEY/,
    );
  });

  it("refuses to bind a vendor with no durable attempt store (no database)", () => {
    expect(() =>
      bindPlatformClearinghouse(
        { CLEARINGHOUSE_VENDOR: "stedi", STEDI_API_KEY: "k" },
        { attempts: null },
      ),
    ).toThrow(/attempt store|database/i);
  });

  it("a vendor without an adapter in this build still fails the boot", () => {
    expect(() => bindPlatformClearinghouse({ CLEARINGHOUSE_VENDOR: "direct_mac" }, deps())).toThrow(
      /no adapter/i,
    );
  });

  it("unset is the logged, unbound state and every call answers CH_NOT_WIRED", async () => {
    const binding = bindPlatformClearinghouse({}, { attempts: null });
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
