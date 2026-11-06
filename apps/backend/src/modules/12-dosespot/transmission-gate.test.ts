// Slice 4 — when does a SIGNED order queue for e-prescribing instead of activating locally (F-058)? Only when the org's
// DoseSpot is live AND the signing prescriber is linked to DoseSpot: an unlinked prescriber's queued order would fail
// permanently as `prescriber_not_enrolled`, so it must activate locally as it does for an unconfigured tenant.
import { describe, expect, it } from "vitest";
import { decideTransmission } from "./transmission-gate";

describe("decideTransmission", () => {
  const linked = "700";

  it("queues when the registration is active and the prescriber is linked", () => {
    expect(
      decideTransmission({
        registrationStatus: "active",
        envFallback: false,
        prescriberVendorId: linked,
      }),
    ).toBe(true);
  });

  it("activates locally when the prescriber is not linked to DoseSpot, whatever the registration says", () => {
    for (const registrationStatus of ["active", null] as const) {
      expect(
        decideTransmission({ registrationStatus, envFallback: true, prescriberVendorId: null }),
      ).toBe(false);
    }
  });

  it("a registration that is not active never transmits, and the env fallback does not override a row", () => {
    for (const registrationStatus of ["draft", "registered", "verified"]) {
      expect(
        decideTransmission({ registrationStatus, envFallback: true, prescriberVendorId: linked }),
      ).toBe(false);
    }
  });

  it("an org with no row transmits only through the env fallback", () => {
    expect(
      decideTransmission({
        registrationStatus: null,
        envFallback: true,
        prescriberVendorId: linked,
      }),
    ).toBe(true);
    expect(
      decideTransmission({
        registrationStatus: null,
        envFallback: false,
        prescriberVendorId: linked,
      }),
    ).toBe(false);
  });
});
