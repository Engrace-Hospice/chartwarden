// Slice 4 — when does a SIGNED order queue for e-prescribing instead of activating locally (F-058)? Only when the org's
// DoseSpot is LIVE (an active registration the platform allows to be live: sandbox needs DOSESPOT_SANDBOX_ENABLED, production its flag
// and host) AND the signing prescriber is linked to DoseSpot. An active-but-unusable row, or an unlinked prescriber, would stall the
// order in `queued` or fail it permanently, so it activates locally as it does for an unconfigured tenant.
import { describe, expect, it } from "vitest";
import { decideTransmission, registrationFactOf } from "./transmission-gate";

describe("decideTransmission", () => {
  const linked = "700";
  const live = { live: true } as const;
  const notLive = { live: false } as const;

  it("queues when the registration is live and the prescriber is linked", () => {
    expect(
      decideTransmission({ registration: live, envFallback: false, prescriberVendorId: linked }),
    ).toBe(true);
  });

  it("activates locally when the prescriber is not linked to DoseSpot, whatever the registration says", () => {
    for (const registration of [live, null] as const) {
      expect(
        decideTransmission({ registration, envFallback: true, prescriberVendorId: null }),
      ).toBe(false);
    }
  });

  it("a registration that is not live never transmits, and the env fallback does not override a row", () => {
    expect(
      decideTransmission({ registration: notLive, envFallback: true, prescriberVendorId: linked }),
    ).toBe(false);
  });

  it("an org with no row transmits only through the env fallback", () => {
    expect(
      decideTransmission({ registration: null, envFallback: true, prescriberVendorId: linked }),
    ).toBe(true);
    expect(
      decideTransmission({ registration: null, envFallback: false, prescriberVendorId: linked }),
    ).toBe(false);
  });
});

describe("registrationFactOf: the gate asks the SAME question the resolver asks", () => {
  const on = { DOSESPOT_SANDBOX_ENABLED: "true" };
  const prod = {
    DOSESPOT_PRODUCTION_ENABLED: "true",
    DOSESPOT_BASE_URL_PRODUCTION: "https://my.dosespot.com/webapi/v2",
  };

  it("no row is null", () => {
    expect(registrationFactOf(null, on)).toBeNull();
  });

  it("only an ACTIVE row can be live", () => {
    for (const status of ["draft", "registered", "verified"]) {
      expect(registrationFactOf({ status, environment: "sandbox" }, on)).toEqual({ live: false });
    }
    expect(registrationFactOf({ status: "active", environment: "sandbox" }, on)).toEqual({
      live: true,
    });
  });

  it("an active sandbox row is not live while the sandbox flag is off (it activates orders locally instead of stalling them)", () => {
    expect(registrationFactOf({ status: "active", environment: "sandbox" }, {})).toEqual({
      live: false,
    });
    expect(
      registrationFactOf(
        { status: "active", environment: "sandbox" },
        { DOSESPOT_SANDBOX_ENABLED: "TRUE" },
      ),
    ).toEqual({
      live: false,
    });
  });

  it("an active production row needs the production flag and host, and the sandbox flag does not stand in", () => {
    expect(registrationFactOf({ status: "active", environment: "production" }, on)).toEqual({
      live: false,
    });
    expect(registrationFactOf({ status: "active", environment: "production" }, prod)).toEqual({
      live: true,
    });
    expect(
      registrationFactOf(
        { status: "active", environment: "production" },
        { DOSESPOT_PRODUCTION_ENABLED: "true" },
      ),
    ).toEqual({ live: false });
  });
});
