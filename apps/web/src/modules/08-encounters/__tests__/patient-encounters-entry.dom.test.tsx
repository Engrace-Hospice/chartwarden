// Workflow 09, WP1 (T01, T22, T36) — the patient chart's encounter list opens a draft where it is finished and every other status on its
// record, shows which encounter came from a scheduled visit, and hands the list over as the way back.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { PatientEncounters } from "../patient-encounters";

const row = (id: string, status: string, visitId: string | null) => ({
  id,
  patientId: "patient-1",
  admissionId: "admission-1",
  visitId,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-31",
  status,
  isF2f: false,
  signedAt: null,
  cosignedAt: null,
});

function Where(): JSX.Element {
  const { pathname, search } = useLocation();
  return <output aria-label="location">{`${pathname}${search}`}</output>;
}

function mount(encounter: ReturnType<typeof row>, permissions: string[]): void {
  const client = {
    POST: vi.fn(),
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/encounters") return { data: { encounters: [encounter] } };
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
      return { data: null };
    }),
  };
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters"]}>
      <ApiClientProvider client={client as never}>
        <ToastProvider>
          <SessionProvider session={{ userId: "u", organizationId: "org-1", permissions }}>
            <Where />
            <Routes>
              <Route path="/patients/:patientId/encounters" element={<PatientEncounters />} />
              <Route path="*" element={null} />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const origin = `?from=${encodeURIComponent("/patients/patient-1/encounters")}`;

async function openSelected(): Promise<void> {
  const table = await screen.findByRole("table", { name: "Patient encounters" });
  fireEvent.click(within(table).getByText("Routine Visit"));
  fireEvent.click(await screen.findByRole("button", { name: "Open encounter" }));
}

describe("the patient chart's encounter list", () => {
  it("opens a draft in the composer for someone who may author, with the list as the way back", async () => {
    mount(row("enc-1", "draft", null), ["encounter.read", "encounter.author"]);
    await openSelected();
    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        `/patients/patient-1/encounters/enc-1/compose${origin}`,
      ),
    );
  });

  it("opens a draft on its record for someone who may not author it", async () => {
    mount(row("enc-1", "draft", null), ["encounter.read"]);
    await openSelected();
    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        `/patients/patient-1/encounters/enc-1${origin}`,
      ),
    );
  });

  it.each(["finalized", "signed", "cosign_pending", "cosigned"])(
    "opens a %s encounter on its record",
    async (status) => {
      mount(row("enc-1", status, null), ["encounter.read", "encounter.author"]);
      await openSelected();
      await waitFor(() =>
        expect(screen.getByLabelText("location").textContent).toBe(
          `/patients/patient-1/encounters/enc-1${origin}`,
        ),
      );
    },
  );

  it("has no separate Compose note button next to Open encounter", async () => {
    mount(row("enc-1", "draft", null), ["encounter.read", "encounter.author"]);
    const table = await screen.findByRole("table", { name: "Patient encounters" });
    fireEvent.click(within(table).getByText("Routine Visit"));
    await screen.findByRole("button", { name: "Open encounter" });
    expect(screen.queryByRole("button", { name: "Compose note" })).toBeNull();
  });

  it("links the encounter that came from a scheduled visit to that visit, and says so for a PRN one (T22)", async () => {
    mount(row("enc-1", "signed", "visit-1"), ["encounter.read"]);
    const table = await screen.findByRole("table", { name: "Patient encounters" });
    fireEvent.click(within(table).getByText("Routine Visit"));
    const link = await screen.findByRole("link", { name: "Open scheduled visit" });
    expect(link.getAttribute("href")).toBe(`/scheduling/visits/visit-1${origin}`);
  });

  it("calls an encounter without a visit PRN / unscheduled", async () => {
    mount(row("enc-1", "signed", null), ["encounter.read"]);
    const table = await screen.findByRole("table", { name: "Patient encounters" });
    fireEvent.click(within(table).getByText("Routine Visit"));
    expect(await screen.findByText("PRN / unscheduled")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open scheduled visit" })).toBeNull();
  });
});
