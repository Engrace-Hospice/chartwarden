import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the printable summary shows the SAME patient header as the
// other discipline-plan tabs (shared banner + Patient Summary rail + chart module rail), not a bare page title.
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { DisciplinePlansSummary } from "../plans-summary";

const PATIENT = "patient-1";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["discipline_plan.read_summary"],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

describe("discipline plans summary — patient workspace", () => {
  it("shows the patient banner, Patient Summary rail and chart rail around the summary", async () => {
    const client = {
      GET: vi.fn(async (path: string) => {
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
        return ok({ data: [], next_cursor: null, has_more: false });
      }),
    } as unknown as ApiClient;

    render(
      <MemoryRouter initialEntries={[`/patients/${PATIENT}/discipline-plans/summary`]}>
        <ApiClientProvider client={client}>
          <ToastProvider>
            <SessionProvider session={session}>
              <Routes>
                <Route
                  path="/patients/:patientId/discipline-plans/summary"
                  element={<DisciplinePlansSummary />}
                />
              </Routes>
            </SessionProvider>
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Discipline plans — summary" })).toBeTruthy(),
    );
    expect(screen.getByRole("link", { name: "June Rivera" })).toBeTruthy();
    expect(screen.getByText("Patient Summary")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Patient chart" })).toBeTruthy();
  });
});
