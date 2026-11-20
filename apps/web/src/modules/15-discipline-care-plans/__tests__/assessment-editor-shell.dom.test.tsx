import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the assessment editor shows the SAME patient header as the
// other discipline-plan tabs (shared banner + Patient Summary rail + chart module rail), not a bare page title.
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AssessmentEditor } from "../assessment-editor";

const PATIENT = "patient-1";
const PLAN = "plan-1";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["discipline_assessment.author"],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

describe("discipline assessment editor — patient workspace", () => {
  it("shows the patient banner, Patient Summary rail and chart rail around the editor", async () => {
    const plan = {
      planId: PLAN,
      patientId: PATIENT,
      admissionId: "admission-1",
      providerEntityId: "provider-1",
      locationId: "location-1",
      kind: "msw_plan",
      status: "active",
      goals: [],
      interventions: [],
      assessments: [],
      supervisoryVisits: [],
      volunteerAssignments: [],
      versions: [],
      supervisoryCadence: null,
      redacted_categories: [],
      version: 1,
    };
    const client = {
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/discipline-plans/{planId}") return ok(plan);
        if (path === "/api/v1/patients/{id}")
          return ok({
            id: PATIENT,
            organizationId: "org-1",
            mrn: "MRN-0007",
            firstName: "June",
            lastName: "Rivera",
            dob: "1950-02-14",
            status: "active",
          });
        return ok({});
      }),
      POST: vi.fn(async () => ok({})),
    } as unknown as ApiClient;

    render(
      <MemoryRouter
        initialEntries={[`/patients/${PATIENT}/discipline-plans/msw_plan/${PLAN}/assessments/new`]}
      >
        <ApiClientProvider client={client}>
          <ToastProvider>
            <SessionProvider session={session}>
              <Routes>
                <Route
                  path="/patients/:patientId/discipline-plans/:kind/:planId/assessments/:assessmentId"
                  element={<AssessmentEditor />}
                />
              </Routes>
            </SessionProvider>
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Capture assessment" })).toBeTruthy(),
    );
    expect(screen.getByRole("link", { name: "June Rivera" })).toBeTruthy();
    expect(screen.getByText("Patient Summary")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Patient chart" })).toBeTruthy();
  });
});
