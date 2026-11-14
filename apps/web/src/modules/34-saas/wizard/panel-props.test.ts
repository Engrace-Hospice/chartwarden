// The one decision panel-props makes for the panels: whether a step's own forms are offered at all.
import { describe, expect, it } from "vitest";
import { canAttestStep, isStepOpenForWork } from "./panel-props";

const onboarding = { tenantStatus: "onboarding" };

describe("isStepOpenForWork", () => {
  it("opens an unlocked step of an onboarding tenant", () => {
    expect(isStepOpenForWork(onboarding, { id: "t1", locked: false, status: "pending" })).toBe(
      true,
    );
  });
  it("closes a locked step that is not settled", () => {
    expect(isStepOpenForWork(onboarding, { id: "t1", locked: true, status: "pending" })).toBe(
      false,
    );
  });
  it("keeps a settled step open, so its data can change and the step be re-opened", () => {
    expect(isStepOpenForWork(onboarding, { id: "t1", locked: true, status: "done" })).toBe(true);
    expect(isStepOpenForWork(onboarding, { id: "t1", locked: false, status: "skipped" })).toBe(
      true,
    );
  });
  it("closes every step once the tenant is not onboarding, and a step with no task yet", () => {
    expect(
      isStepOpenForWork({ tenantStatus: "active" }, { id: "t1", locked: false, status: "pending" }),
    ).toBe(false);
    expect(isStepOpenForWork(onboarding, { id: null, locked: false, status: "pending" })).toBe(
      false,
    );
  });
});

describe("canAttestStep", () => {
  it("offers no Mark done on the clearinghouse step even though its completion mode is 'either'", () => {
    expect(canAttestStep({ key: "clearinghouse_selected", completionMode: "either" })).toBe(false);
    expect(canAttestStep({ key: "clearinghouse_selected", completionMode: "attestation" })).toBe(
      false,
    );
  });

  it("offers it on a step settled by evidence, 'either' included (the MAC credential, DoseSpot kickoff)", () => {
    expect(canAttestStep({ key: "mac_configured", completionMode: "either" })).toBe(true);
    expect(
      canAttestStep({ key: "dosespot_kickoff_initiated", completionMode: "attestation" }),
    ).toBe(true);
  });

  it("offers it on no step the server settles from its own facts", () => {
    expect(canAttestStep({ key: "locations_seeded", completionMode: "auto" })).toBe(false);
  });
});
