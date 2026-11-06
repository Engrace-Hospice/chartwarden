// What choosing a clearinghouse does, said before the operator confirms it. For "outside" the sentence must be TRUE of this tenant: the
// MAC and payer enrollment skips happen only while it is onboarding, and the billing mode is only touched where a contract exists (set
// to none at once while onboarding, from the 1st of next month once live).
import { describe, expect, it } from "vitest";
import { consequenceOf } from "./clearinghouse-choice-form";
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
const OUTSIDE = { vendor: "outside", mode: "production" } as const;

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
      { vendor: "claimmd", mode: "production" },
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
      { vendor: "stedi", mode: "production" },
      { tenantStatus: "onboarding", hasContract: true },
    );
    expect(change).toMatch(/starts the new configuration at draft/);
  });
});
