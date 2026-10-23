// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
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

function clientFor(patientReadUnavailable = false): ApiClient {
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
            },
          ],
          nextCursor: null,
        });
      }
      if (path === "/api/v1/patients/{id}") {
        if (patientReadUnavailable)
          return { data: undefined, error: { code: "FORBIDDEN" }, response: new Response(null, { status: 403 }) };
        return ok({
          id: "patient-1",
          organizationId: "org-1",
          mrn: "MRN-1001",
          firstName: "Elena",
          lastName: "Rivera",
          dob: "1946-04-12",
          status: "active",
        });
      }
      return ok({});
    }),
  } as unknown as ApiClient;
}

function renderCensus(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={["/admissions"]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <Routes>
            <Route path="/admissions" element={<AdmissionCensus />} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Admission census", () => {
  it("shows the linked patient name in the admissions table", async () => {
    const client = clientFor();
    renderCensus(client);

    await waitFor(() => expect(screen.getByRole("link", { name: "Elena Rivera" })).toBeTruthy());

    const patientLink = screen.getByRole("link", { name: "Elena Rivera" });
    expect(patientLink.getAttribute("href")).toBe("/patients/patient-1");
    // The MRN is masked to its last four in the table (full value in the cell's title).
    expect(screen.getAllByText("…1001").length).toBeGreaterThan(0);
    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/patients/{id}",
      expect.objectContaining({ params: { path: { id: "patient-1" } } }),
    );
  });

  it("keeps the admission-provided name when the separate patient read fails", async () => {
    renderCensus(clientFor(true));
    await waitFor(() => expect(screen.getAllByText("Elena Rivera").length).toBeGreaterThan(0));
    expect(screen.queryByRole("link", { name: "Elena Rivera" })).toBeNull();
    expect(screen.getAllByText("…1001").length).toBeGreaterThan(0);
  });
});
