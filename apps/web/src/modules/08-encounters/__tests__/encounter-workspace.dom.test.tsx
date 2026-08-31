import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../../../shell/session";
import { EncounterRead } from "../encounter-read";
import { PatientEncounters } from "../patient-encounters";

const encounter = {
  id: "enc-1",
  organizationId: "org-1",
  patientId: "patient-1",
  admissionId: "admission-1",
  visitId: "visit-1",
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-31",
  status: "draft",
  lateEntryTier: "normal",
  version: 1,
  authoredByUserId: "mem-1",
  isF2f: false,
  signedAt: null,
  cosignedAt: null,
  selections: { narrative: { clinicalSummary: "Initial note" } },
  finalDocumentation: null,
  vitals: null,
  mileage: null,
  carePlanLinks: [],
};

function renderEncounter(client: { GET: ReturnType<typeof vi.fn>; POST: ReturnType<typeof vi.fn> }) {
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters/enc-1"]}>
      <ApiClientProvider client={client as never}>
        <SessionProvider
          session={{
            userId: "user-1",
            organizationId: "org-1",
            permissions: ["encounter.author", "encounter.finalize", "encounter.sign", "vitals.author"],
          }}
        >
          <Routes>
            <Route path="/patients/:patientId/encounters/:encounterId" element={<EncounterRead />} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

function renderPatientEncounters(client: { GET: ReturnType<typeof vi.fn>; POST: ReturnType<typeof vi.fn> }) {
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters"]}>
      <ApiClientProvider client={client as never}>
        <SessionProvider
          session={{
            userId: "user-1",
            organizationId: "org-1",
            permissions: ["encounter.author", "encounter.read"],
          }}
        >
          <Routes>
            <Route path="/patients/:patientId/encounters" element={<PatientEncounters />} />
            <Route path="/patients/:patientId/encounters/:encounterId" element={<output aria-label="location">created</output>} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Encounter workspace web workflow", () => {
  it("persists documentation, vitals, care-plan links, and finalize through M8 APIs", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/encounters/{encounterId}") return { data: encounter };
      if (path === "/api/v1/encounters/{encounterId}/cosignature") return { data: { status: null } };
      if (path === "/api/v1/patients/{id}") return { data: { firstName: "Ava", lastName: "Stone", dob: "1950-01-01", mrn: "MRN1", status: "active" } };
      if (path === "/api/v1/internal/care-plan/relevant-elements")
        return {
          data: {
            problems: [{ problemId: "problem-1", description: "Pain management", status: "active" }],
            goals: [{ goalId: "goal-1", problemId: "problem-1", text: "Pain at target", status: "in_progress" }],
            interventions: [{ interventionId: "intervention-1", problemId: "problem-1", scopeText: "Assess pain response", frequencyText: "Each visit", discipline: "rn", status: "active" }],
            redacted: false,
          },
        };
      if (path === "/api/v1/patients/{patientId}/assessments") return { data: { assessments: [] } };
      if (path === "/api/v1/patients/{patientId}/hope/assessments") return { data: { assessments: [] } };
      return { data: null };
    });
    const post = vi.fn(async () => ({ data: { status: "ok" }, response: new Response() }));
    renderEncounter({ GET: get, POST: post });

    const note = await screen.findByLabelText("Clinical documentation");
    fireEvent.change(note, { target: { value: "Patient comfortable after intervention." } });
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/encounters/{encounterId}/selections",
        expect.objectContaining({ body: expect.objectContaining({ selections: expect.any(Object) }) }),
      ),
    );

    fireEvent.change(screen.getByLabelText("Heart rate"), { target: { value: "72" } });
    fireEvent.click(screen.getByRole("button", { name: /save vitals/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/encounters/{encounterId}/vitals",
        expect.objectContaining({ body: expect.objectContaining({ heartRate: 72 }) }),
      ),
    );

    fireEvent.click(screen.getByLabelText(/Pain management/i));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/encounters/{encounterId}/care-plan-links",
        expect.objectContaining({ body: { problemId: "problem-1" } }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /finalize/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/encounters/{encounterId}/finalize",
        expect.objectContaining({ body: {} }),
      ),
    );
  });

  it("creates a PRN Encounter without inventing an M17 Visit", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/encounters") return { data: { encounters: [] } };
      if (path === "/api/v1/patients/{id}")
        return { data: { firstName: "Ava", lastName: "Stone", dob: "1950-01-01", mrn: "MRN1", status: "active" } };
      if (path === "/api/v1/admissions")
        return { data: { items: [{ id: "admission-1", patientId: "patient-1", state: "active" }] } };
      return { data: null };
    });
    const post = vi.fn(async () => ({ data: { id: "enc-prn" }, response: new Response() }));
    renderPatientEncounters({ GET: get, POST: post });

    await screen.findByText("Encounters / Visits");
    fireEvent.click(screen.getByRole("button", { name: /new prn encounter/i }));
    fireEvent.focus(screen.getByLabelText(/active admission/i));
    await waitFor(() => expect(screen.getByText(/Admission admissio/i)).toBeTruthy());
    fireEvent.click(screen.getByText(/Admission admissio/i));
    fireEvent.change(screen.getByLabelText(/service date/i), { target: { value: "2026-08-31" } });
    fireEvent.click(screen.getByRole("button", { name: /create encounter/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/encounters",
        expect.objectContaining({
          body: expect.objectContaining({
            patientId: "patient-1",
            admissionId: "admission-1",
            serviceDate: "2026-08-31",
          }),
        }),
      ),
    );
  });
});
