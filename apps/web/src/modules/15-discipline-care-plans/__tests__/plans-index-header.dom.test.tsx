import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the Discipline plans tab shows the SAME patient header as the
// other chart tabs (the shared banner with the patient's identity, and the Patient Summary rail), not a bare page
// title. A regression here is the tab looking different from Plan of care, Assessments and the rest.
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { DisciplinePlansIndex } from "../plans-index";

const PATIENT = "patient-1";

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

function renderIndex(): void {
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/discipline-plans") return ok({ data: [], nextCursor: null });
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
    <MemoryRouter initialEntries={[`/patients/${PATIENT}/discipline-plans`]}>
      <ApiClientProvider client={client}>
        <ToastProvider>
          <SessionProvider session={session}>
            <Routes>
              <Route
                path="/patients/:patientId/discipline-plans"
                element={<DisciplinePlansIndex />}
              />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("discipline plans index — shared patient header", () => {
  it("shows the patient banner and the Patient Summary rail like every other chart tab", async () => {
    renderIndex();
    // The banner names the patient (it is the shared ChartBanner, which links the name to the chart).
    await waitFor(() => expect(screen.getByRole("link", { name: "June Rivera" })).toBeTruthy());
    expect(screen.getByText("Patient Summary")).toBeTruthy();
    // The page's own title moved into the content, and the printable summary stays one click away.
    expect(screen.getByRole("heading", { name: "Discipline plans" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Printable summary" }).getAttribute("href")).toBe(
      `/patients/${PATIENT}/discipline-plans/summary`,
    );
  });
});
