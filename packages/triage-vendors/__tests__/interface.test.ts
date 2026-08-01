import { describe, expect, it } from "vitest";

import {
  type ExternalTriageVendorAdapter,
  type TriageVendorBinding,
  type TriageVendorBindingError,
  assertVendorBindingActive,
} from "../src/interface";

const adapter: ExternalTriageVendorAdapter = {
  adapterKey: "tenants/triage-vendor-touchpoint",
  supportedProfiles: ["hybrid_phi_min"],
  handoffCall: () => Promise.resolve({ result: "transport_failure", nextRetryAt: "" }),
  pollCall: () => Promise.resolve({ kind: "in_progress", observedAt: "" }),
  healthy: () => Promise.resolve(true),
};

const binding: TriageVendorBinding = {
  externalTriageVendorId: "vendor-1",
  adapterKey: "tenants/triage-vendor-touchpoint",
  minimizationProfile: "hybrid_phi_min",
  baaInEffect: true,
  baaExpiresOn: "2027-01-01",
  rnCoverageAttested: true,
};

/** Captures the thrown error so the assertion is on `reason`/`code`, not on a message regex — a regex
 *  that matches nothing passes silently for the wrong reason. */
function reasonOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as TriageVendorBindingError).reason;
  }
}

describe("D13 vendor-binding activation gate", () => {
  it("admits a binding with a live BAA, an RN attestation and a supported profile", () => {
    expect(() => assertVendorBindingActive(binding, adapter, "2026-07-31")).not.toThrow();
  });

  it("refuses when no BAA is on file", () => {
    expect(
      reasonOf(() =>
        assertVendorBindingActive({ ...binding, baaInEffect: false }, adapter, "2026-07-31"),
      ),
    ).toBe("baa_missing");
  });

  it("refuses on the day AFTER the BAA lapses, not only at binding-creation time", () => {
    // The whole point of re-checking at every handoff: this binding was valid when it was created.
    expect(reasonOf(() => assertVendorBindingActive(binding, adapter, "2027-01-02"))).toBe(
      "baa_expired",
    );
    expect(() => assertVendorBindingActive(binding, adapter, "2027-01-01")).not.toThrow();
  });

  it("treats a null expiry as open-ended rather than as expired", () => {
    expect(() =>
      assertVendorBindingActive({ ...binding, baaExpiresOn: null }, adapter, "2099-01-01"),
    ).not.toThrow();
  });

  it("refuses without the CoP 418.64(b) RN-coverage attestation", () => {
    expect(
      reasonOf(() =>
        assertVendorBindingActive({ ...binding, rnCoverageAttested: false }, adapter, "2026-07-31"),
      ),
    ).toBe("rn_coverage_not_attested");
  });

  it("refuses a centralized profile on an adapter built only for hybrid", () => {
    expect(
      reasonOf(() =>
        assertVendorBindingActive(
          { ...binding, minimizationProfile: "centralized_phi_min" },
          adapter,
          "2026-07-31",
        ),
      ),
    ).toBe("profile_unsupported");
  });

  it("refuses when the resolved adapter is not the one the binding names", () => {
    expect(
      reasonOf(() =>
        assertVendorBindingActive(
          { ...binding, adapterKey: "tenants/triage-vendor-other" },
          adapter,
          "2026-07-31",
        ),
      ),
    ).toBe("adapter_key_mismatch");
  });

  it("carries the M1 error envelope's contract", () => {
    try {
      assertVendorBindingActive({ ...binding, baaInEffect: false }, adapter, "2026-07-31");
      expect.unreachable("expected the gate to refuse");
    } catch (e) {
      const err = e as TriageVendorBindingError;
      expect(err.code).toBe("TRIAGE_VENDOR_BINDING_INACTIVE");
      expect(err.statusCode).toBe(409);
    }
  });
});
