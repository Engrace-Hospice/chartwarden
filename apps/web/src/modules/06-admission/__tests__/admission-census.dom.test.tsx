import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AdmissionCensus } from "../admission-census";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Sarah Miller",
  permissions: ["admission.read", "patient.read"],
};

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function clientFor(): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/admissions") {
        return ok({
          items: [
            {
              id: "adm-1",
              state: "pending",
              version: 3,
              patientId: "patient-1",
              patient: { id: "patient-1", firstName: "Elena", lastName: "Rivera", mrn: "MRN-1001" },
              patientAgeYears: 80,
              referralId: "ref-1",
              admissionAt: "2026-08-28T10:00:00.000Z",
              serviceAddressSnapshot: { city: "Portland", state: "OR" },
              hospicePhysician: { displayName: "Dr. Quinn" },
            },
          ],
          nextCursor: null,
        });
      }
      return ok({});
    }),
  } as unknown as ApiClient;
}

function renderCensus(client: ApiClient, permissions = session.permissions): void {
  render(
    <MemoryRouter initialEntries={["/admissions"]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={{ ...session, permissions }}>
          <Routes>
            <Route path="/admissions" element={<AdmissionCensus />} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Admission census", () => {
  it("shows the linked patient and row facts from the list response alone (no per-row reads)", async () => {
    const client = clientFor();
    renderCensus(client);

    await waitFor(() => expect(screen.getByRole("link", { name: "Elena Rivera" })).toBeTruthy());

    const patientLink = screen.getByRole("link", { name: "Elena Rivera" });
    expect(patientLink.getAttribute("href")).toBe("/patients/patient-1");
    // The MRN is masked to its last four in the table (full value in the cell's title).
    expect(screen.getAllByText("…1001").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Dr\. Quinn/).length).toBeGreaterThan(0);
    const paths = (client.GET as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/api/v1/patients/{id}");
    expect(paths).not.toContain("/api/v1/admissions/{id}");
  });

  it("does not link to the patient chart when the user cannot read patients", async () => {
    renderCensus(clientFor(), ["admission.read"]);
    await waitFor(() => expect(screen.getAllByText("Elena Rivera").length).toBeGreaterThan(0));
    expect(screen.queryByRole("link", { name: "Elena Rivera" })).toBeNull();
    expect(screen.getAllByText("…1001").length).toBeGreaterThan(0);
  });
});
