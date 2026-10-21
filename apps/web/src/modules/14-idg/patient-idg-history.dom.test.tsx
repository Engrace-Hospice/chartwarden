// The patient IDG history lists the patient's current care team as the IDG team. An `admitting_staff`
// row is an access grant for whoever created the patient from a referral, not an IDG discipline, so it
// must not appear there.
import { render, screen } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { PatientIdgHistory } from "./patient-idg-history";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Ada Administrator",
  permissions: ["patient.read"],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const row = (id: string, role: string) => ({
  id,
  patientId: PATIENT,
  clinicianUserId: `${id}-user`,
  role,
  assignedAt: "2026-10-01",
  unassignedAt: null,
  reason: null,
  current: true,
});

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === `/api/v1/patients/${PATIENT}/care-team`) {
    return json({
      assignments: [row("rn", "primary_rn"), row("adm", "admitting_staff")],
      caregivers: [],
      emergencyContacts: [],
    });
  }
  if (path === `/api/v1/patients/${PATIENT}`) {
    return json({
      id: PATIENT,
      organizationId: "org-1",
      firstName: "Pat",
      lastName: "Ient",
      status: "active",
      mrn: "M1",
      dob: "1940-01-01",
    });
  }
  if (path === `/api/v1/patients/${PATIENT}/idg-history`) return json({ meetings: [] });
  return json({ error: { code: "NOT_FOUND", message: "nf" } }, 404);
}

describe("PatientIdgHistory team", () => {
  it("omits admitting_staff rows from the IDG team", async () => {
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider session={session}>
          <ToastProvider>
            <MemoryRouter initialEntries={[`/patients/${PATIENT}/idg`]}>
              <Routes>
                <Route path="/patients/:patientId/idg" element={<PatientIdgHistory />} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    expect(await screen.findByText("Registered Nurse")).toBeTruthy();
    expect(screen.queryByText(/Admitting staff/i)).toBeNull();
  });
});
