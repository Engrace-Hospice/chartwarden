// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import type { CarePlan, Goal, Version } from "../care-plan-api";
import { CarePlanRail, GoalsList, PlanHeader } from "../care-plan-overview";

afterEach(cleanup);

const signed: Version = {
  id: "version-initial",
  planId: "plan-1",
  sequence: 1,
  kind: "initial",
  status: "signed",
  idgMeetingId: null,
  requiredSignerSet: [],
  signatures: [],
  draftedAt: "2026-08-01T10:00:00.000Z",
  signedAt: "2026-08-01T12:05:00.000Z",
  supersededAt: null,
  version: 1,
};

function planWith(overrides: Partial<CarePlan> = {}, goals: Goal[] = []): CarePlan {
  return {
    id: "plan-1",
    patientId: "patient-1",
    admissionId: "admission-1",
    status: "active",
    activeVersionId: signed.id,
    version: 1,
    versions: [signed],
    problems: [],
    goals,
    interventions: [],
    redacted: false,
    ...overrides,
  };
}

function goalDue(targetAt: string | null): Goal {
  return {
    id: "goal-1",
    planId: "plan-1",
    problemId: "problem-1",
    originalText: "Comfort maintained",
    revisedText: null,
    source: "clinical",
    actingConsentId: null,
    measurableOutcome: null,
    targetAt,
    status: "in_progress",
    statusNote: null,
    version: 1,
  };
}

function session(permissions: string[]): Session {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-1",
    membershipId: "membership-1",
    displayName: "Sarah Miller",
    permissions,
  };
}

function inRouter(ui: ReactElement, permissions: string[] = ["care_plan.read"]): void {
  render(
    <MemoryRouter>
      <SessionProvider session={session(permissions)}>{ui}</SessionProvider>
    </MemoryRouter>,
  );
}

describe("PlanHeader lifecycle state", () => {
  it("shows an active plan as Active", () => {
    inRouter(<PlanHeader plan={planWith()} activeVersion={signed} openVersion={null} />);

    expect(screen.getByText("Active Plan (v1)")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("shows a discharged plan as Discharged even though the signed version is still the active one", () => {
    inRouter(
      <PlanHeader
        plan={planWith({ status: "discharged" })}
        activeVersion={signed}
        openVersion={null}
      />,
    );

    expect(screen.getByText("Discharged")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.queryByText(/Active Plan/)).toBeNull();
  });

  it("shows a plan with only a draft version by its version status, not as Active", () => {
    const draft: Version = { ...signed, id: "v-draft", status: "draft", signedAt: null };
    inRouter(
      <PlanHeader
        plan={planWith({ status: "draft", activeVersionId: null })}
        activeVersion={null}
        openVersion={draft}
      />,
    );

    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
  });
});

describe("goal target dates", () => {
  const previousTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    if (previousTz === undefined) Reflect.deleteProperty(process.env, "TZ");
    else process.env.TZ = previousTz;
  });

  it("renders a UTC-midnight target as the same calendar day for a US clinician", () => {
    inRouter(
      <GoalsList
        plan={planWith({}, [goalDue("2026-12-01T00:00:00.000Z")])}
        editable={false}
        onEdit={() => undefined}
        onAdd={() => undefined}
      />,
    );

    expect(screen.getByText("12/01/2026")).toBeTruthy();
  });

  it("renders a date-only target as the same calendar day", () => {
    inRouter(
      <GoalsList
        plan={planWith({}, [goalDue("2026-12-01")])}
        editable={false}
        onEdit={() => undefined}
        onAdd={() => undefined}
      />,
    );

    expect(screen.getByText("12/01/2026")).toBeTruthy();
  });
});

describe("Print Care Plan quick link", () => {
  const rail = (
    <CarePlanRail
      plan={planWith()}
      patientId="patient-1"
      summary={null}
      canAddGoal={false}
      onAddGoal={() => undefined}
    />
  );

  it("is offered to a viewer who can read the summary", () => {
    inRouter(rail, ["care_plan.read", "care_plan.read_summary"]);

    expect(screen.getByRole("link", { name: /Print Care Plan/ })).toBeTruthy();
  });

  it("is hidden from a viewer without care_plan.read_summary (the page would only deny them)", () => {
    inRouter(rail, ["care_plan.read"]);

    expect(screen.queryByRole("link", { name: /Print Care Plan/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Version History/ })).toBeTruthy();
  });
});

describe("Quick links follow the destination's permission", () => {
  const rail = (
    <CarePlanRail
      plan={planWith()}
      patientId="patient-1"
      summary={null}
      canAddGoal={false}
      onAddGoal={() => undefined}
    />
  );
  const linkNames = (): string[] =>
    screen.getAllByRole("link").map((link) => link.textContent?.trim() ?? "");

  it("offers only the links whose screens the viewer may open", () => {
    inRouter(rail, ["care_plan.read", "idg.read", "assessment.read"]);

    expect(linkNames()).toEqual(["Version History", "View IDG Notes", "View Assessments"]);
  });

  it("offers every link to a viewer holding every destination permission", () => {
    inRouter(rail, [
      "care_plan.read",
      "care_plan.read_summary",
      "idg.read",
      "discipline_plan.read",
      "assessment.read",
      "prescribing.read",
    ]);

    expect(linkNames()).toEqual([
      "Version History",
      "View IDG Notes",
      "Discipline Plans",
      "Print Care Plan",
      "View Assessments",
      "View Medications",
    ]);
  });
});
