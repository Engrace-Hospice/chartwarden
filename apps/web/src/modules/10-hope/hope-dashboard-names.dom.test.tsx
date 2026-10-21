// Finding 9 — the HOPE worklist names the patient (and shows no admission id prefix) instead of raw uuid
// prefixes; a patient the viewer cannot read falls back to the "Name unavailable".
import { render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { HopeDashboard } from "./hope-dashboard";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ADMISSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SCHEDULE = "cccccccc-3333-4333-8333-cccccccccccc";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mount(patientStatus: number) {
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/api/v1/hope/schedules") {
      return json({
        schedules: [
          {
            id: SCHEDULE,
            patientId: PATIENT,
            admissionId: ADMISSION,
            rfaKind: "02_huv1",
            status: "open",
            windowOpensAt: "2000-01-01T00:00:00.000Z",
            windowClosesAt: "2999-01-01T00:00:00.000Z",
            lateDeadlineAt: "2999-02-01T00:00:00.000Z",
          },
        ],
      });
    }
    if (path === `/api/v1/patients/${PATIENT}`) {
      return patientStatus === 200
        ? json({ id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" })
        : json({ error: { code: "NOT_FOUND", message: "no" } }, patientStatus);
    }
    return json({});
  };
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "11111111-1111-4111-8111-111111111111",
          organizationId: "org-1",
          displayName: "Dr",
          permissions: ["hope.schedule.read"],
        }}
      >
        <ToastProvider>
          <MemoryRouter>
            <HopeDashboard />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("HOPE dashboard patient column", () => {
  it("shows the patient's name, never the patient or admission id prefix", async () => {
    mount(200);
    await waitFor(() => expect(screen.getByText("Lovelace, Ada")).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(PATIENT.slice(0, 8));
    expect(text).not.toContain(ADMISSION.slice(0, 8));
  });

  it("falls back to a neutral label when the patient is not readable", async () => {
    mount(404);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    // Wait for the lookup to SETTLE: still pending reads "Loading…", settled-unreadable reads "Name unavailable".
    await waitFor(() => expect(screen.getByText("Name unavailable")).toBeTruthy());
    expect(document.body.textContent).not.toContain("Loading\u2026");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(PATIENT.slice(0, 8));
    expect(text).not.toContain(ADMISSION.slice(0, 8));
  });
});
