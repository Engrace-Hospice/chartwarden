// A viewer without member.manage never loads the staff roster; the Overview Care Team panel must still show
// the server-resolved name, and the system-issued admitting_staff access grant must not appear as a team seat.
import { render, screen } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { OverviewTab, type PatientSummary, usePatientChartData } from "./patient-overview";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG = "org-1";
const session: Session = {
  userId: "u1",
  organizationId: ORG,
  displayName: "Nora",
  permissions: ["patient.read"],
};
const patient = { id: PATIENT, organizationId: ORG } as unknown as PatientSummary;

const assignment = (id: string, role: string, displayName: string) => ({
  id,
  clinicianUserId: `user-${id}`,
  role,
  assignedAt: "2026-10-01",
  current: true,
  displayName,
});

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const { pathname } = new URL(req.url, "http://localhost");
  const body =
    pathname === `/api/v1/patients/${PATIENT}/care-team`
      ? {
          assignments: [
            assignment("rn", "rn", "Nora Visit, RN"),
            assignment("adm", "admitting_staff", "Ada Intake"),
          ],
          emergencyContacts: [],
        }
      : {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function Harness(): JSX.Element {
  const data = usePatientChartData(patient);
  return <OverviewTab patient={patient} data={data} />;
}

describe("Overview Care Team panel without the staff roster", () => {
  it("shows the server displayName and no Admitting Staff row", async () => {
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider session={session}>
          <ToastProvider>
            <MemoryRouter>
              <Harness />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    expect((await screen.findAllByText("Nora Visit, RN")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Ada Intake")).toBeNull();
    expect(screen.queryByText(/Admitting Staff/i)).toBeNull();
  });
});
