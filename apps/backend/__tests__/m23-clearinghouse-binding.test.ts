import {
  CH,
  InMemoryAttemptStore,
  CLEARINGHOUSE_VENDOR_ENV as REGISTRY_ENV,
  PRODUCTION_CLEARINGHOUSE_VENDORS as REGISTRY_PRODUCTION_VENDORS,
  parseClearinghouseVendor,
} from "@chartwarden/x12-837-client";
import { describe, expect, it } from "vitest";
import { CLEARINGHOUSE_VENDOR_ENV, PRODUCTION_CLEARINGHOUSE_VENDORS } from "../src/bootstrap/env";
import {
  bindPlatformClearinghouse,
  buildClearinghouseFactories,
  describeClearinghouseBinding,
} from "../src/modules/23-billing-medicare/clearinghouse-binding";

const gateway = {
  generate: async () => ({ x12: "" }),
  upload: async () => ({ accepted: true, fileId: "f" }),
  pullAcknowledgments: async () => [],
};

describe("platform clearinghouse binding", () => {
  const deps = () => ({ attempts: new InMemoryAttemptStore() });

  it("registers exactly the adapters compiled into this build", () => {
    expect(Object.keys(buildClearinghouseFactories(deps())).sort()).toEqual([
      "direct_mac",
      "episode_alert",
      "stedi",
    ]);
  });

  it("binds episode_alert without an attempt store and logs the vendor, never the key", () => {
    const binding = bindPlatformClearinghouse(
      {
        CLEARINGHOUSE_VENDOR: "episode_alert",
        EPISODE_ALERT_API_KEY: "ea_do_not_log",
        EPISODE_ALERT_BASE_URL: "https://api.example.test",
      },
      { attempts: null },
    );
    expect(binding.vendor).toBe("episode_alert");
    expect(describeClearinghouseBinding(binding)).toBe("Clearinghouse binding: episode_alert");
    expect(describeClearinghouseBinding(binding)).not.toContain("ea_do_not_log");
  });

  it("refuses to boot with episode_alert named but no key or no base URL, naming only the variable", () => {
    const base = { CLEARINGHOUSE_VENDOR: "episode_alert" };
    expect(() => bindPlatformClearinghouse(base, deps())).toThrow(/EPISODE_ALERT_API_KEY/);
    expect(() =>
      bindPlatformClearinghouse({ ...base, EPISODE_ALERT_API_KEY: "k" }, deps()),
    ).toThrow(/EPISODE_ALERT_BASE_URL/);
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
    expect(() => bindPlatformClearinghouse({ CLEARINGHOUSE_VENDOR: "in_memory" }, deps())).toThrow(
      /no adapter/i,
    );
  });

  it("direct_mac fails closed without the launch gateway or the attempt store, and binds with both", () => {
    const env = { CLEARINGHOUSE_VENDOR: "direct_mac" };
    expect(() => bindPlatformClearinghouse(env, deps())).toThrow(/launch gateway/i);
    expect(() =>
      bindPlatformClearinghouse(env, { attempts: null, directMacGateway: gateway }),
    ).toThrow(/attempt store|database/i);
    const binding = bindPlatformClearinghouse(env, { ...deps(), directMacGateway: gateway });
    expect(binding.vendor).toBe("direct_mac");
    expect(describeClearinghouseBinding(binding)).toBe("Clearinghouse binding: direct_mac");
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
