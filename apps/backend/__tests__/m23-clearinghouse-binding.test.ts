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
      "claimmd",
      "direct_mac",
      "stedi",
    ]);
  });

  it("binds claimmd from its key and account usage, never logging the key, and refuses without either", () => {
    const binding = bindPlatformClearinghouse(
      { CLEARINGHOUSE_VENDOR: "claimmd", CLAIMMD_ACCOUNT_KEY: "cmd_do_not_log", CLAIMMD_ACCOUNT_USAGE: "test" },
      deps(),
    );
    expect(binding.vendor).toBe("claimmd");
    expect(describeClearinghouseBinding(binding)).toBe("Clearinghouse binding: claimmd");
    expect(describeClearinghouseBinding(binding)).not.toContain("cmd_do_not_log");
    expect(() => bindPlatformClearinghouse({ CLEARINGHOUSE_VENDOR: "claimmd" }, deps())).toThrow(
      /CLAIMMD_ACCOUNT_KEY/,
    );
    expect(() =>
      bindPlatformClearinghouse({ CLEARINGHOUSE_VENDOR: "claimmd", CLAIMMD_ACCOUNT_KEY: "k" }, deps()),
    ).toThrow(/CLAIMMD_ACCOUNT_USAGE/);
    expect(() =>
      bindPlatformClearinghouse(
        { CLEARINGHOUSE_VENDOR: "claimmd", CLAIMMD_ACCOUNT_KEY: "k", CLAIMMD_ACCOUNT_USAGE: "test" },
        { attempts: null },
      ),
    ).toThrow(/attempt store|database/i);
  });

  it("spends claimmd's request budget from the injected shared counter, keyed by usage, failing closed when it is down", async () => {
    const keys: string[] = [];
    const binding = bindPlatformClearinghouse(
      { CLEARINGHOUSE_VENDOR: "claimmd", CLAIMMD_ACCOUNT_KEY: "cmd_do_not_log", CLAIMMD_ACCOUNT_USAGE: "test" },
      {
        ...deps(),
        // The shape of createRedisRateLimitStore while Valkey is unreachable: nothing may be sent.
        claimMdRequestCounter: {
          increment: async (key: string) => {
            keys.push(key);
            throw new Error("connect ECONNREFUSED");
          },
        },
      },
    );
    const scope = { organizationId: "org-1", providerEntityId: "pe-1", usage: "test" as const, billingNpi: "1234567893" };
    const r = await binding.transport.fetchAcknowledgments({ ...scope, payerId: "15004", correlationId: "c" }, null);
    expect(!r.ok && r.degraded.code).toBe(CH.UNAVAILABLE);
    expect(keys).toEqual(["claimmd:test"]);
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
