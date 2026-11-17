// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { DisciplineVersionHistory } from "../version-history";

const PATIENT = "patient-1";
const PLAN = "plan-1";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["discipline_plan.read"],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

describe("discipline version history — patient workspace", () => {
  it("retains patient context and links back to the matching discipline plan", async () => {
    const plan = {
      planId: PLAN,
      patientId: PATIENT,
      admissionId: "admission-1",
      providerEntityId: "provider-1",
      locationId: "location-1",
      kind: "spiritual_plan",
      status: "active",
      nextSupervisoryDueAt: null,
      initialAssessmentClockStartedAt: null,
      initialAssessmentSignedAt: null,
      spiritualCareDeclinedAt: null,
      updatedAt: "2026-11-01T00:00:00.000Z",
      version: 1,
    };
    const client = {
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/discipline-plans")
          return ok({ data: [plan], next_cursor: null, has_more: false });
        if (path === "/api/v1/discipline-plans/{planId}/versions")
          return ok({ data: [], next_cursor: null, has_more: false });
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
        initialEntries={[`/patients/${PATIENT}/discipline-plans/spiritual_plan/versions`]}
      >
        <ApiClientProvider client={client}>
          <ToastProvider>
            <SessionProvider session={session}>
              <Routes>
                <Route
                  path="/patients/:patientId/discipline-plans/:kind/versions"
                  element={<DisciplineVersionHistory />}
                />
              </Routes>
            </SessionProvider>
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Spiritual Care Plan — version history" }),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("link", { name: "June Rivera" })).toBeTruthy();
    expect(screen.getByText("Patient Summary")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Patient chart" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to Spiritual Care Plan" }).getAttribute("href"),
    ).toBe(`/patients/${PATIENT}/discipline-plans/spiritual-plan`);
  });
});
