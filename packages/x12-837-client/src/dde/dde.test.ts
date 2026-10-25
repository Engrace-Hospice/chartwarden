import { describe, expect, it } from "vitest";
import { DDE_CONFORMANCE_CASES, runDdeConformance } from "./conformance";
import { createInMemoryDdeHarness } from "./in-memory-provider";
import {
  DDE_PROVIDER_ENV,
  NOT_WIRED_DDE_PROVIDER,
  bindDdeProvider,
  parseDdeProvider,
} from "./provider-registry";
import { DDE } from "./types";

const CTX = {
  organizationId: "org-1",
  providerEntityId: "pe-1",
  operatorMembershipId: "op-1",
  correlationId: "c-1",
  usage: "test",
} as const;

describe("in-memory DdeAccessProvider conformance", () => {
  it("passes every shared case", async () => {
    const outcomes = await runDdeConformance(() => createInMemoryDdeHarness());
    expect(outcomes.filter((o) => !o.passed)).toEqual([]);
    expect(outcomes).toHaveLength(DDE_CONFORMANCE_CASES.length);
  });
});

describe("parseDdeProvider", () => {
  it("treats unset, blank and manual as manual keying", () => {
    expect(parseDdeProvider(undefined, true)).toBeNull();
    expect(parseDdeProvider("  ", true)).toBeNull();
    expect(parseDdeProvider("manual", true)).toBeNull();
  });

  it("accepts episode_alert and refuses in_memory in production only", () => {
    expect(parseDdeProvider(" episode_alert ", true)).toBe("episode_alert");
    expect(parseDdeProvider("in_memory", false)).toBe("in_memory");
    expect(() => parseDdeProvider("in_memory", true)).toThrow(/in_memory/);
  });

  it("refuses an unknown provider", () => {
    expect(() => parseDdeProvider("acme", false)).toThrow(DDE_PROVIDER_ENV);
  });
});

describe("bindDdeProvider", () => {
  it("binds the fail-closed provider when unset", async () => {
    const b = bindDdeProvider({}, {});
    expect(b.vendor).toBeNull();
    expect(b.provider).toBe(NOT_WIRED_DDE_PROVIDER);
    const r = await b.provider.fetchOutcomes(CTX, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.degraded.code).toBe(DDE.NOT_WIRED);
  });

  it("throws at boot when the vendor has no registered adapter", () => {
    expect(() => bindDdeProvider({ [DDE_PROVIDER_ENV]: "episode_alert" }, {})).toThrow(
      /no adapter is registered/,
    );
  });

  it("throws when the adapter reports a different vendor", () => {
    const factories = { episode_alert: () => createInMemoryDdeHarness().provider };
    expect(() => bindDdeProvider({ [DDE_PROVIDER_ENV]: "episode_alert" }, factories)).toThrow(
      /vendor mismatch/,
    );
  });

  it("binds a registered adapter", () => {
    const b = bindDdeProvider(
      { [DDE_PROVIDER_ENV]: "in_memory" },
      { in_memory: () => createInMemoryDdeHarness().provider },
    );
    expect(b.vendor).toBe("in_memory");
  });
});
