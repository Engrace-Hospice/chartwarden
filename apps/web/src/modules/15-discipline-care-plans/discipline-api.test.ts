// apps/web/src/modules/15-discipline-care-plans — which plan row the discipline screens open after a
// readmission (one plan of a kind per admission).
import { describe, expect, it } from "vitest";
import { type PlanListItem, pickPlanRow } from "./discipline-api";

const row = (over: Partial<PlanListItem> & Pick<PlanListItem, "planId">): PlanListItem => ({
  patientId: "patient-1",
  admissionId: "adm-1",
  providerEntityId: "pe-1",
  locationId: "loc-1",
  kind: "msw_plan",
  status: "active",
  nextSupervisoryDueAt: null,
  initialAssessmentClockStartedAt: "2026-01-01T00:00:00.000Z",
  initialAssessmentSignedAt: null,
  spiritualCareDeclinedAt: null,
  updatedAt: "2026-01-02T00:00:00.000Z",
  version: 1,
  ...over,
});

describe("pickPlanRow", () => {
  // The old admission's plan was touched MORE recently (list order is updatedAt desc), which used to win.
  const oldAdmission = row({ planId: "old", updatedAt: "2026-06-01T00:00:00.000Z" });
  const newAdmission = row({
    planId: "new",
    admissionId: "adm-2",
    initialAssessmentClockStartedAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
  });

  it("opens the newest admission's live plan, not the most recently touched one", () => {
    expect(pickPlanRow([oldAdmission, newAdmission])?.planId).toBe("new");
    expect(pickPlanRow([newAdmission, oldAdmission])?.planId).toBe("new");
  });

  it("scopes to the named admission", () => {
    expect(pickPlanRow([oldAdmission, newAdmission], "adm-1")?.planId).toBe("old");
    expect(pickPlanRow([oldAdmission, newAdmission], "adm-3")).toBeNull();
  });

  it("prefers a live plan over a discharged one, falling back to the newest discharged", () => {
    const dischargedNew = row({ ...newAdmission, planId: "new-d", status: "discharged" });
    expect(pickPlanRow([dischargedNew, oldAdmission])?.planId).toBe("old");
    expect(
      pickPlanRow([dischargedNew, row({ planId: "old-d", status: "discharged" })])?.planId,
    ).toBe("new-d");
  });

  it("is null with no rows", () => {
    expect(pickPlanRow([])).toBeNull();
  });
});
