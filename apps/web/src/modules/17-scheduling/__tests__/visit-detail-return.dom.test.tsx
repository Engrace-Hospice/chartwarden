// Workflow 09, WP1 (T01, T22, T36) — Visit Detail leads to the visit's encounter where it is worked on, and goes back to where the visit
// was opened from (My Visits with its filters, the calendar) instead of always to the day view.
import { ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { VisitDetail } from "../visit-detail";

const VISIT = "00000000-0000-4000-8000-000000000017";
const PATIENT = "00000000-0000-4000-8000-000000000005";

const visit = {
  id: VISIT,
  organizationId: "org-1",
  patientId: PATIENT,
  admissionId: "00000000-0000-4000-8000-000000000006",
  assignedMembershipId: "00000000-0000-4000-8000-000000000007",
  visitPurpose: "routine_visit",
  visitSetting: "patient_home",
  scheduledStartedAt: "2026-08-31T14:00:00.000Z",
  scheduledEndedAt: "2026-08-31T15:00:00.000Z",
  serviceDate: "2026-08-31",
  status: "published",
  patientAddressId: null,
  externalFacilityId: null,
  rescheduledIntoVisitId: null,
};

const linked = (status: string) => ({
  id: "enc-1",
  patientId: PATIENT,
  admissionId: visit.admissionId,
  visitId: VISIT,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-31",
  status,
  signedAt: null,
  cosignedAt: null,
});

function fakeClient(encounter: ReturnType<typeof linked> | null) {
  return {
    POST: vi.fn(async () => ({ data: null })),
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/visits/{visitId}") return { data: visit };
      if (path === "/api/v1/encounters")
        return { data: { encounters: encounter ? [encounter] : [] } };
      if (path === "/api/v1/patients/{id}") {
        return {
          data: {
            firstName: "Ava",
            lastName: "Stone",
            dob: "1950-01-01",
            mrn: "MRN1",
            status: "active",
          },
        };
      }
      return { data: [] };
    }),
  };
}

function Where(): JSX.Element {
  const { pathname, search } = useLocation();
  return <output aria-label="location">{`${pathname}${search}`}</output>;
}

const AUTHOR_PERMISSIONS = ["visit.read", "encounter.author"];

function renderVisit(
  client: ReturnType<typeof fakeClient>,
  path: string,
  permissions: string[] = AUTHOR_PERMISSIONS,
): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ApiClientProvider client={client as never}>
        <SessionProvider session={{ userId: "u", organizationId: "org-1", permissions }}>
          <Where />
          <Routes>
            <Route path="/scheduling/visits/:visitId" element={<VisitDetail />} />
            <Route path="*" element={null} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const visitPath = `/scheduling/visits/${VISIT}`;
const origin = (path: string) => `?from=${encodeURIComponent(path)}`;

describe("Visit Detail: the way back", () => {
  it("goes back to My Visits, with its filters, when the visit was opened from there (T36)", async () => {
    renderVisit(
      fakeClient(linked("draft")),
      `${visitPath}${origin("/me/visits?status=published&page=2")}`,
    );
    const back = await screen.findByRole("link", { name: /Back to My Visits/ });
    expect(back.getAttribute("href")).toBe("/me/visits?status=published&page=2");
    expect(screen.queryByRole("link", { name: /Back to schedule/ })).toBeNull();
  });

  it("goes back to the calendar as it was left", async () => {
    renderVisit(fakeClient(null), `${visitPath}${origin("/calendar?view=week&date=2026-08-31")}`);
    const back = await screen.findByRole("link", { name: /Back to Calendar/ });
    expect(back.getAttribute("href")).toBe("/calendar?view=week&date=2026-08-31");
  });

  it("keeps the schedule link when it was not opened from a known screen, and ignores a hostile origin", async () => {
    renderVisit(fakeClient(null), `${visitPath}${origin("https://evil.example/me/visits")}`);
    expect(await screen.findByRole("link", { name: /Back to schedule/ })).toBeTruthy();
    expect(document.querySelector("a[href*='evil']")).toBeNull();
  });
});

describe("Visit Detail: the linked encounter", () => {
  it("opens a draft in the composer, with this visit (and where it came from) as the way back (T01, T36)", async () => {
    const client = fakeClient(linked("draft"));
    renderVisit(client, `${visitPath}${origin("/me/visits?status=published")}`);

    fireEvent.click(await screen.findByRole("button", { name: "Draft" }));

    const nested = `${visitPath}${origin("/me/visits?status=published")}`;
    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        `/patients/${PATIENT}/encounters/enc-1/compose${origin(nested)}`,
      ),
    );
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("opens a draft on its record, not the composer, when the session may read but not author", async () => {
    renderVisit(fakeClient(linked("draft")), visitPath, ["visit.read", "encounter.read"]);

    fireEvent.click(await screen.findByRole("button", { name: "Draft" }));

    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        `/patients/${PATIENT}/encounters/enc-1${origin(visitPath)}`,
      ),
    );
  });

  it("does the same from the visit actions panel for a session that may not author", async () => {
    renderVisit(fakeClient(linked("draft")), visitPath, ["visit.read", "encounter.read"]);

    fireEvent.click(await screen.findByRole("button", { name: /Open Encounter/ }));

    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        `/patients/${PATIENT}/encounters/enc-1${origin(visitPath)}`,
      ),
    );
  });

  it("opens a signed encounter on its record, never in the composer (T01)", async () => {
    renderVisit(fakeClient(linked("signed")), visitPath);

    fireEvent.click(await screen.findByRole("button", { name: "Signed" }));

    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        `/patients/${PATIENT}/encounters/enc-1${origin(visitPath)}`,
      ),
    );
  });

  it("does the same from the visit actions panel, and creates nothing (T03)", async () => {
    const client = fakeClient(linked("draft"));
    renderVisit(client, visitPath);

    fireEvent.click(await screen.findByRole("button", { name: /Open Encounter/ }));

    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        `/patients/${PATIENT}/encounters/enc-1/compose${origin(visitPath)}`,
      ),
    );
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("says the encounter is still processing when none is linked, and offers no link to a guess (T03)", async () => {
    const client = fakeClient(null);
    renderVisit(client, visitPath);

    expect(await screen.findByText("Processing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Draft" })).toBeNull();
    expect(client.POST).not.toHaveBeenCalled();
  });
});
