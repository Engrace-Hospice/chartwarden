// M25 milestone 6a - the adapter port: the manual adapter is always bound and never transmits; the esMD and fax shells are
// UNBOUND for every org, expose no transmit / poll (so no network call is possible), and an attempt for an unbound
// electronic channel falls back to needs_manual, never queued.
import { describe, expect, it } from "vitest";
import { ESMD_ADAPTER_SHELL } from "../esmd-adapter";
import { FAX_ADAPTER_SHELL } from "../fax-adapter";
import { MANUAL_ADAPTER } from "../manual-adapter";
import { DEFAULT_ADAPTER_REGISTRY, adapterStatuses, planAttempt } from "../registry";

const ORG = "00000000-0000-0000-0000-000000000001";

describe("manual adapter", () => {
  it("is always bound, guided, and has no transmit", () => {
    expect(MANUAL_ADAPTER.availability(ORG).bound).toBe(true);
    expect(MANUAL_ADAPTER.mode).toBe("guided_manual");
    expect(MANUAL_ADAPTER.transmit).toBeUndefined();
    expect(
      MANUAL_ADAPTER.guide({ purpose: "adr_response", macName: null, deadline: null }).length,
    ).toBeGreaterThan(0);
  });
});

describe.each([
  ["esMD", ESMD_ADAPTER_SHELL, "esmd"],
  ["fax", FAX_ADAPTER_SHELL, "fax"],
] as const)("%s shell", (_name, adapter, channel) => {
  it("is unbound with an operator-facing reason and no PHI", () => {
    const a = adapter.availability(ORG);
    expect(a.bound).toBe(false);
    expect(a.reason).toMatch(/not configured/i);
    expect(a.reason).toMatch(/guided manual/i);
  });
  it("has no transmit or poll, so it can never reach a network", () => {
    expect(adapter.mode).toBe("electronic");
    expect(adapter.transmit).toBeUndefined();
    expect(adapter.poll).toBeUndefined();
  });
  it("falls an attempt back to needs_manual, never queued", () => {
    const plan = planAttempt(DEFAULT_ADAPTER_REGISTRY, ORG, channel);
    expect(plan.status).toBe("needs_manual");
    expect(plan.adapter).toBe("manual");
    expect(plan.reason).toMatch(/not configured/i);
  });
});

describe("planAttempt", () => {
  it("uses the manual path for a non-electronic or unknown channel", () => {
    for (const channel of ["mail", "mac_portal", "qic_portal", "other", null] as const) {
      const plan = planAttempt(DEFAULT_ADAPTER_REGISTRY, ORG, channel);
      expect(plan).toMatchObject({ adapter: "manual", status: "needs_manual" });
    }
  });
  it("lists every adapter's honest status", () => {
    const statuses = adapterStatuses(DEFAULT_ADAPTER_REGISTRY, ORG);
    expect(statuses.map((s) => [s.kind, s.bound])).toEqual([
      ["manual", true],
      ["esmd", false],
      ["fax", false],
    ]);
  });
});
