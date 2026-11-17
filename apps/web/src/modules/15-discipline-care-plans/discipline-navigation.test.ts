import { describe, expect, it } from "vitest";
import type { PlanListItem } from "./discipline-api";
import {
  disciplineAssessmentPath,
  disciplinePlanPath,
  overviewPresentation,
} from "./discipline-navigation";

const plan = (overrides: Partial<PlanListItem> = {}): PlanListItem => ({
  planId: "plan-1",
  patientId: "patient-1",
  admissionId: "admission-1",
  providerEntityId: "provider-1",
  locationId: "location-1",
  kind: "msw_plan",
  status: "active",
  nextSupervisoryDueAt: null,
  initialAssessmentClockStartedAt: "2026-11-01T00:00:00.000Z",
  initialAssessmentSignedAt: "2026-11-02T00:00:00.000Z",
  spiritualCareDeclinedAt: null,
  updatedAt: "2026-11-03T00:00:00.000Z",
  version: 1,
  actionSummary: {
    openVersion: null,
    latestSignedVersion: { versionId: "version-1", sequence: 1, signedAt: "2026-11-02" },
    missingSignerRoles: [],
    ownerMembershipIds: [],
    idgDecisionId: null,
  },
  ...overrides,
});

describe("discipline navigation", () => {
  it.each([
    ["aide_poc", "aide-poc"],
    ["msw_plan", "msw-plan"],
    ["spiritual_plan", "spiritual-plan"],
    ["volunteer_plan", "volunteer-plan"],
  ])("maps %s to its patient workspace", (kind, segment) => {
    expect(disciplinePlanPath("patient-1", kind)).toBe(
      `/patients/patient-1/discipline-plans/${segment}`,
    );
    expect(disciplineAssessmentPath("patient-1", kind, "plan-1", "assessment-1")).toBe(
      `/patients/patient-1/discipline-plans/${segment}/plan-1/assessments/assessment-1`,
    );
  });

  it("fails closed to the discipline overview for an unknown plan kind", () => {
    expect(disciplinePlanPath("patient-1", "future_kind")).toBe(
      "/patients/patient-1/discipline-plans",
    );
  });
});

describe("overviewPresentation", () => {
  it("keeps an absent volunteer plan neutral and not actionable", () => {
    expect(overviewPresentation("volunteer_plan", undefined, Date.parse("2026-11-17"))).toEqual({
      statusLabel: "Not assigned",
      statusTone: "neutral",
      nextAction: "No action until a volunteer is assigned",
      description: "No volunteer plan yet. A plan is created after the first volunteer assignment.",
    });
  });

  it("derives an overdue aide-supervision action only from the server due date", () => {
    expect(
      overviewPresentation(
        "aide_poc",
        plan({
          kind: "aide_poc",
          nextSupervisoryDueAt: "2026-11-16T00:00:00.000Z",
        }),
        Date.parse("2026-11-17T00:00:00.000Z"),
      ).nextAction,
    ).toBe("Aide supervision is overdue");
  });

  it.each([
    ["draft", "Review draft plan"],
    ["draft_revising", "Review draft revision"],
    ["active", "Start next revision"],
    ["discharged", "Review historical plan"],
    ["future_status", "Review plan status"],
  ])("maps %s to a conservative next action", (status, nextAction) => {
    expect(overviewPresentation("msw_plan", plan({ status }), Date.now()).nextAction).toBe(
      nextAction,
    );
  });

  it("offers an initial version only for a draft root with no version history", () => {
    const draft = plan({
      status: "draft",
      actionSummary: {
        openVersion: null,
        latestSignedVersion: null,
        missingSignerRoles: [],
        ownerMembershipIds: [],
        idgDecisionId: null,
      },
    });
    expect(overviewPresentation("msw_plan", draft).nextAction).toBe("Start initial plan");
  });
});
