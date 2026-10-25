// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AdmissionHopeOverview } from "../admission-hope-overview";

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    admissionId,
    patientId: "patient-1",
    admissionStatus: "active",
    admissionAt: "2026-08-27T00:00:00.000Z",
    activatedAt: "2026-08-27T08:00:00.000Z",
    dischargedAt: null,
    admissionAssessment: {
      kind: "01_admission",
      status: "completed",
      scheduleId: "sched-adm",
      windowStart: "2026-08-27T00:00:00.000Z",
      windowEnd: "2026-08-31T23:59:59.999Z",
      lateDeadline: "2026-09-07T23:59:59.999Z",
      completedAt: "2026-08-28T10:00:00.000Z",
      assessmentId: "assess-adm",
      attention: { state: "none", severity: "none", action: "NONE", message: null, deadline: null },
    },
    huv1: {
      kind: "02_huv1",
      status: "open",
      scheduleId: "sched-huv1",
      windowStart: "2026-09-02T00:00:00.000Z",
      windowEnd: "2026-09-11T23:59:59.999Z",
      lateDeadline: "2026-09-18T23:59:59.999Z",
      completedAt: null,
      assessmentId: null,
      attention: {
        state: "due_soon",
        severity: "warn",
        action: "COMPLETE_HUV1",
        message: "The normal completion window is approaching.",
        deadline: "2026-09-11T23:59:59.999Z",
      },
    },
    huv2: {
      kind: "03_huv2",
      status: "upcoming",
      scheduleId: "sched-huv2",
      windowStart: "2026-09-12T00:00:00.000Z",
      windowEnd: "2026-09-26T23:59:59.999Z",
      lateDeadline: "2026-10-03T23:59:59.999Z",
      completedAt: null,
      assessmentId: null,
      attention: {
        state: "upcoming",
        severity: "info",
        action: "NONE",
        message: "This HOPE item is not open yet.",
        deadline: "2026-09-12T00:00:00.000Z",
      },
    },
    sfvs: [
      {
        id: "sfv-1",
        status: "open",
        triggeringAssessmentId: "assess-adm",
        triggeringRfaKind: "01_admission",
        dueAt: "2026-09-04T23:59:59.999Z",
        triggeredAt: "2026-09-02T12:00:00.000Z",
        completedAt: null,
        completingAssessmentId: null,
        attention: {
          state: "due",
          severity: "warn",
          action: "OPEN_SFV",
          message: "This Symptom Follow-Up Visit is due.",
          deadline: "2026-09-04T23:59:59.999Z",
        },
      },
    ],
    dischargeAssessment: {
      kind: "05_discharge",
      status: "not_applicable",
      scheduleId: null,
      windowStart: null,
      windowEnd: null,
      lateDeadline: null,
      completedAt: null,
      assessmentId: null,
      attention: { state: "none", severity: "none", action: "NONE", message: null, deadline: null },
    },
    summary: {
      actionableCount: 2,
      overdueCount: 0,
      completedCount: 1,
      nextDeadline: "2026-09-04T23:59:59.999Z",
      highestSeverity: "warn",
      dueSoonCount: 1,
      workflowIssueCount: 0,
    },
    ...overrides,
  };
}

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function clientFor(data = workflow()): ApiClient {
  return {
    GET: vi.fn(async () => ok(data)),
  } as unknown as ApiClient;
}

// The "HOPE" page heading is also in the loading skeleton, so it is NOT proof the data arrived; wait for the skeleton to go.
async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.queryByLabelText("Loading HOPE workflow")).toBeNull());
  expect(screen.getByRole("heading", { name: "HOPE" })).toBeTruthy();
}

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}</output>;
}

function renderOverview(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={[`/admissions/${admissionId}/hope`]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route
            path="/admissions/:admissionId/hope"
            element={
              <>
                <AdmissionHopeOverview />
                <LocationProbe />
              </>
            }
          />
          <Route
            path="/admissions/:admissionId/hope/timepoints/:kind"
            element={<LocationProbe />}
          />
          <Route path="/hope/assessments/:id" element={<LocationProbe />} />
          <Route path="/admissions/:admissionId/hope/sfv/:sfvId" element={<LocationProbe />} />
          <Route path="/patients/:patientId/assessments" element={<LocationProbe />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Admission HOPE overview", () => {
  it("renders backend-provided fixed RFAs, SFVs, and distinct M9/M10 admission assessment labels", async () => {
    renderOverview(clientFor());

    await loaded();
    expect(screen.getByText("HOPE Admission Assessment")).toBeTruthy();
    expect(screen.getByText("Admission RFA")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "HUV1" })).toBeTruthy();
    expect(screen.getAllByText("Due soon").length).toBeGreaterThan(0);
    expect(screen.getByText(/Window closes Sep/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "HUV2" })).toBeTruthy();
    expect(screen.getByText("Upcoming")).toBeTruthy();
    expect(screen.getByText("Discharge Assessment")).toBeTruthy();
    expect(screen.getByText("Not applicable")).toBeTruthy();
    expect(screen.getByText("Symptom Follow-Up Visits")).toBeTruthy();
    expect(screen.getByText(/This Symptom Follow-Up Visit is due/)).toBeTruthy();
    expect(screen.getByText("Triggered by Admission")).toBeTruthy();
    expect(screen.getByText("Clinical Admission Assessment")).toBeTruthy();
    expect(
      screen.getByText(
        "M9 clinical admission assessment remains separate from the M10 HOPE Admission RFA.",
      ),
    ).toBeTruthy();
  });

  it("shows workflow issues separately from clinical overdue work", async () => {
    renderOverview(
      clientFor(
        workflow({
          huv1: {
            kind: "02_huv1",
            status: "workflow_not_initialized",
            scheduleId: null,
            windowStart: null,
            windowEnd: null,
            lateDeadline: null,
            completedAt: null,
            assessmentId: null,
            attention: {
              state: "workflow_issue",
              severity: "warn",
              action: "REPAIR_WORKFLOW",
              message: "The expected HOPE schedule was not initialized for this Admission.",
              deadline: null,
            },
          },
          summary: {
            actionableCount: 1,
            overdueCount: 0,
            completedCount: 1,
            nextDeadline: "2026-09-04T23:59:59.999Z",
            highestSeverity: "warn",
            dueSoonCount: 0,
            workflowIssueCount: 1,
          },
        }),
      ),
    );

    await loaded();
    expect(screen.getAllByText("Workflow issue").length).toBeGreaterThan(0);
    expect(screen.getByText("1 workflow issue")).toBeTruthy();
    expect(screen.getByText("Overdue/missed")).toBeTruthy();
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
  });

  it("never says no action is required while the summary counts actions", async () => {
    renderOverview(
      clientFor(
        workflow({
          summary: {
            actionableCount: 2,
            overdueCount: 0,
            completedCount: 1,
            nextDeadline: "2026-09-04T23:59:59.999Z",
            highestSeverity: "none",
            dueSoonCount: 0,
            workflowIssueCount: 0,
          },
        }),
      ),
    );

    await waitFor(() => expect(screen.getByText("2 action required")).toBeTruthy());
    expect(screen.queryByText(/No HOPE action is currently required/)).toBeNull();
    expect(screen.getByText(/Review HOPE items that need attention/)).toBeTruthy();
  });

  it("opens an existing draft instead of offering to create another timepoint draft", async () => {
    renderOverview(
      clientFor(
        workflow({
          admissionAssessment: {
            kind: "01_admission",
            status: "open",
            scheduleId: "sched-adm",
            windowStart: "2026-08-27T00:00:00.000Z",
            windowEnd: "2026-08-31T23:59:59.999Z",
            lateDeadline: "2026-09-07T23:59:59.999Z",
            completedAt: null,
            assessmentId: "draft-adm",
            attention: {
              state: "none",
              severity: "none",
              action: "NONE",
              message: null,
              deadline: null,
            },
          },
        }),
      ),
    );

    await loaded();
    expect(screen.getByText("Draft in progress")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue draft" }));
    expect(screen.getByLabelText("location").textContent).toBe("/hope/assessments/draft-adm");
  });

  it("navigates to a contextual HUV workflow without requiring raw RFA selection", async () => {
    renderOverview(clientFor());

    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Complete HUV1" }));
    expect(screen.getByLabelText("location").textContent).toBe(
      `/admissions/${admissionId}/hope/timepoints/02_huv1`,
    );
  });

  it("navigates to a contextual SFV workflow without manufacturing a trigger", async () => {
    renderOverview(clientFor());
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Complete Follow-Up" }));
    expect(screen.getByLabelText("location").textContent).toBe(
      `/admissions/${admissionId}/hope/sfv/sfv-1`,
    );
  });

  it("navigates to a contextual Discharge RFA workflow when M10 makes discharge applicable", async () => {
    renderOverview(
      clientFor(
        workflow({
          dischargeAssessment: {
            kind: "05_discharge",
            status: "open",
            scheduleId: "sched-dc",
            windowStart: "2026-09-01T00:00:00.000Z",
            windowEnd: "2026-09-07T23:59:59.999Z",
            lateDeadline: "2026-09-14T23:59:59.999Z",
            completedAt: null,
            assessmentId: null,
          },
        }),
      ),
    );

    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Complete Discharge Assessment" }));
    expect(screen.getByLabelText("location").textContent).toBe(
      `/admissions/${admissionId}/hope/timepoints/05_discharge`,
    );
  });
});
