// The one decision panel-props makes for the panels: whether a step's own forms are offered at all.
import { describe, expect, it } from "vitest";
import { STEPS_SETTLED_BY_PANEL, isStepOpenForWork } from "./panel-props";

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

describe("STEPS_SETTLED_BY_PANEL", () => {
  it("names the clearinghouse step only", () => {
    expect([...STEPS_SETTLED_BY_PANEL]).toEqual(["clearinghouse_selected"]);
  });
});
