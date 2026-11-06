// What choosing a clearinghouse does, said before the operator confirms it. For "outside" the sentence must be TRUE of this tenant: the
// MAC and payer enrollment skips happen only while it is onboarding, and the billing mode is only touched where a contract exists (set
// to none at once while onboarding, from the 1st of next month once live).
import { describe, expect, it } from "vitest";
import { type ChoiceForm, consequenceOf, validateChoice } from "./clearinghouse-choice-form";
import type { ClearinghouseView } from "./clearinghouse-model";

const NOTHING: ClearinghouseView = {
  vendor: null,
  mode: null,
  status: null,
  source: "none",
  hasSecret: false,
  verifiableBy: null,
  verification: null,
  lastTest: null,
  baaRequired: false,
  baa: null,
  activatedAt: null,
  version: null,
  updatedAt: null,
};
const OUTSIDE: ChoiceForm = { vendor: "outside", mode: "production", billingServiceMode: "" };

describe("consequenceOf: billing outside ChartWarden", () => {
  it("while onboarding with a contract: the skips and the mode set to none NOW", () => {
    const text = consequenceOf(NOTHING, OUTSIDE, { tenantStatus: "onboarding", hasContract: true });
    expect(text).toMatch(/transmit nothing/);
    expect(text).toMatch(/MAC credential and payer enrollment steps are skipped/);
    expect(text).toMatch(/billing service mode is set to none now/i);
    expect(text).not.toMatch(/1st of next month/);
  });

  it("for a live tenant: the mode changes from the 1st of next month, and nothing is skipped (the steps are only skipped in onboarding)", () => {
    const text = consequenceOf(NOTHING, OUTSIDE, { tenantStatus: "active", hasContract: true });
    expect(text).toMatch(/from the 1st of next month/);
    expect(text).not.toMatch(/skipped/);
    expect(text).not.toMatch(/none now/i);
  });

  it("with no contract: says nothing about the billing mode (none is ever invented for a tenant without one)", () => {
    for (const tenantStatus of ["onboarding", "active"]) {
      const text = consequenceOf(NOTHING, OUTSIDE, { tenantStatus, hasContract: false });
      expect(text).not.toMatch(/billing service mode|billing mode/i);
      expect(text).toMatch(/transmit nothing/);
    }
  });
});

describe("consequenceOf: a vendor", () => {
  it("says the credential is sealed for a first choice, and that a change restarts verification", () => {
    const first = consequenceOf(
      NOTHING,
      { vendor: "claimmd", mode: "production", billingServiceMode: "" },
      { tenantStatus: "onboarding", hasContract: true },
    );
    expect(first).toMatch(/sealed under the tenant's own key/);
    const chosen: ClearinghouseView = {
      ...NOTHING,
      vendor: "claimmd",
      mode: "production",
      source: "tenant",
      status: "draft",
      hasSecret: true,
      version: 2,
    };
    const change = consequenceOf(
      chosen,
      { vendor: "stedi", mode: "production", billingServiceMode: "" },
      { tenantStatus: "onboarding", hasContract: true },
    );
    expect(change).toMatch(/starts the new configuration at draft/);
  });
});

// Leaving outside for a vendor while a contract is signed: the operator names the billing mode the vendor billing calls for (the server
// requires it: 422 BILLING_SERVICE_MODE_REQUIRED), so the form asks, says what it does, and never defaults it.
describe("leaving outside for a vendor with a contract", () => {
  const OUTSIDE_NOW: ClearinghouseView = {
    ...NOTHING,
    vendor: "outside",
    status: "active",
    source: "tenant",
    version: 4,
  };
  const toVendor = (billingServiceMode: ChoiceForm["billingServiceMode"]): ChoiceForm => ({
    vendor: "claimmd",
    mode: "production",
    billingServiceMode,
  });
  const CONTRACTED = { tenantStatus: "onboarding", hasContract: true };

  it("requires the billing mode, and has no default for it", () => {
    expect(
      validateChoice(OUTSIDE_NOW, toVendor(""), "fake-key-not-a-secret#1", CONTRACTED),
    ).toEqual({
      billingServiceMode: "Choose the billing service mode.",
    });
    expect(
      validateChoice(OUTSIDE_NOW, toVendor("none"), "fake-key-not-a-secret#1", CONTRACTED),
    ).toEqual({});
  });

  it("asks nothing for a first choice, a vendor-to-vendor change, a tenant with no contract, or a stay-outside write", () => {
    const secret = "fake-key-not-a-secret#1";
    expect(validateChoice(NOTHING, toVendor(""), secret, CONTRACTED)).toEqual({});
    const vendor: ClearinghouseView = {
      ...NOTHING,
      vendor: "stedi",
      mode: "production",
      source: "tenant",
      version: 2,
    };
    expect(validateChoice(vendor, toVendor(""), secret, CONTRACTED)).toEqual({});
    expect(
      validateChoice(OUTSIDE_NOW, toVendor(""), secret, {
        tenantStatus: "onboarding",
        hasContract: false,
      }),
    ).toEqual({});
    expect(
      validateChoice(OUTSIDE_NOW, { ...OUTSIDE, billingServiceMode: "" }, "", CONTRACTED),
    ).toEqual({});
  });

  it("says what leaving outside does to the billing mode, and that it is put back if the vendor change fails", () => {
    const text = consequenceOf(OUTSIDE_NOW, toVendor("managed_billing"), CONTRACTED);
    expect(text).toMatch(/Managed billing/);
    expect(text).toMatch(/set before the clearinghouse/);
    expect(text).toMatch(/put back to none/);
    const live = consequenceOf(OUTSIDE_NOW, toVendor("managed_billing"), {
      tenantStatus: "active",
      hasContract: true,
    });
    expect(live).toMatch(/1st of next month/);
  });
});
