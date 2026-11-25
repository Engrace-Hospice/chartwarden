// The link the visit note's "Schedule next visit" opens: the Calendar reads the patient from the URL, opens the New Visit form for that
// patient (the purpose and the day are chosen in the form, never carried in the URL), and drops `newVisit` (not the patient) when the form
// closes. Synthetic ids only.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { CalendarPage } from "./calendar-page";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ADMISSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["scheduler"],
  permissions: ["visit.read", "visit.create"],
  isAdmin: false,
};

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const path = url.pathname;
  const body =
    path === `/api/v1/patients/${PATIENT}`
      ? { firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" }
      : path.endsWith("/admissions")
        ? { items: [{ id: ADMISSION, state: "active", admissionAt: "2026-08-01T00:00:00.000Z" }] }
        : path === "/api/v1/visits" ||
            path.endsWith("/addresses") ||
            path === "/api/v1/scheduling/eligible-clinicians"
          ? path.endsWith("/addresses")
            ? { addresses: [] }
            : []
          : {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function Where(): null {
  const { search } = useLocation();
  document.body.dataset.search = search;
  return null;
}

function mount(entry: string): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[entry]}>
            <Where />
            <Routes>
              <Route path="/calendar" element={<CalendarPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  delete document.body.dataset.search;
});

describe("Calendar opened from the visit note's Schedule next visit link", () => {
  it("opens New Visit on the scheduler's own default purpose", async () => {
    mount(`/calendar?patient=${PATIENT}&newVisit=1`);

    const purpose = (await screen.findByLabelText(/visit purpose/i)) as HTMLSelectElement;
    expect(purpose.value).toBe("routine_visit");
  });

  it("drops newVisit, and keeps the patient, when the form is closed", async () => {
    mount(`/calendar?patient=${PATIENT}&newVisit=1`);
    await screen.findByLabelText(/visit purpose/i);

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^close$/i }));

    await waitFor(() => {
      const params = new URLSearchParams(document.body.dataset.search);
      expect(params.get("patient")).toBe(PATIENT);
      expect(params.has("newVisit")).toBe(false);
    });
  });
});
