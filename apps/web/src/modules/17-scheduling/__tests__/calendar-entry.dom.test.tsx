// Workflow 09, WP1 (T01, T36) — the calendar's visit panel opens the visit and its encounter with the calendar as it is now (view, date,
// visit) as the way back; a draft opens where it is finished, any other status on its record.
import { ApiClientProvider } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { CalendarPage } from "../calendar-page";

const VISIT = "00000000-0000-4000-8000-000000000017";
const PATIENT = "00000000-0000-4000-8000-000000000005";
const ADMISSION = "00000000-0000-4000-8000-000000000006";

const visit = {
  id: VISIT,
  organizationId: "org-1",
  patientId: PATIENT,
  admissionId: ADMISSION,
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

const encounter = (status: string) => ({
  id: "enc-1",
  patientId: PATIENT,
  admissionId: ADMISSION,
  visitId: VISIT,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-31",
  status,
  signedAt: null,
  cosignedAt: null,
});

function mount(status: string, permissions: string[] = ["visit.read", "encounter.author"]): string {
  const here = `/calendar?view=day&date=2026-08-31&visit=${VISIT}`;
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/visits") return { data: [visit] };
      if (path === "/api/v1/encounters") return { data: { encounters: [encounter(status)] } };
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
    POST: vi.fn(),
  };
  render(
    <MemoryRouter initialEntries={[here]}>
      <ApiClientProvider client={client as never}>
        <SessionProvider session={{ userId: "u", organizationId: "org-1", permissions }}>
          <CalendarPage />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return here;
}

describe("the calendar's visit panel", () => {
  it("opens the visit and a draft's composer with the calendar as the way back", async () => {
    const here = mount("draft");
    const documentation = await screen.findByRole("link", { name: "Open Documentation" });
    expect(documentation.getAttribute("href")).toBe(
      `/patients/${PATIENT}/encounters/enc-1/compose?from=${encodeURIComponent(here)}`,
    );
    expect(screen.getByRole("link", { name: /Open\s+Visit/ }).getAttribute("href")).toBe(
      `/scheduling/visits/${VISIT}?from=${encodeURIComponent(here)}`,
    );
  });

  it("opens a draft on its record, not the composer, when the session may read but not author", async () => {
    const here = mount("draft", ["visit.read", "encounter.read"]);
    const documentation = await screen.findByRole("link", { name: "Open Documentation" });
    expect(documentation.getAttribute("href")).toBe(
      `/patients/${PATIENT}/encounters/enc-1?from=${encodeURIComponent(here)}`,
    );
  });

  it("opens a signed encounter on its record, not in the composer", async () => {
    const here = mount("signed");
    const documentation = await screen.findByRole("link", { name: "Open Documentation" });
    expect(documentation.getAttribute("href")).toBe(
      `/patients/${PATIENT}/encounters/enc-1?from=${encodeURIComponent(here)}`,
    );
  });
});
