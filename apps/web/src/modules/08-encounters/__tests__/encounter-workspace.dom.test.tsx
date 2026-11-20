import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Fragment } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { NoteClosureProvider } from "../../../shell/note-closure";
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

function renderEncounter(
  client: {
    GET: ReturnType<typeof vi.fn>;
    PATCH: ReturnType<typeof vi.fn>;
    POST: ReturnType<typeof vi.fn>;
  },
  /** Mount the shell's closure-status provider around the screen, as the app does. */
  withClosureStatus = false,
) {
  const Closure = withClosureStatus ? NoteClosureProvider : Fragment;
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters/enc-1"]}>
      <ApiClientProvider client={client as never}>
        <ToastProvider>
          <SessionProvider
            session={{
              userId: "user-1",
              organizationId: "org-1",
              permissions: [
                "encounter.author",
                "encounter.finalize",
                "encounter.sign",
                "vitals.author",
              ],
            }}
          >
            <Closure>
              <Routes>
                <Route
                  path="/patients/:patientId/encounters/:encounterId"
                  element={<EncounterRead />}
                />
              </Routes>
            </Closure>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

function renderPatientEncounters(client: {
  GET: ReturnType<typeof vi.fn>;
  POST: ReturnType<typeof vi.fn>;
}) {
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters"]}>
      <ApiClientProvider client={client as never}>
        <ToastProvider>
          <SessionProvider
            session={{
              userId: "user-1",
              organizationId: "org-1",
              permissions: ["encounter.author", "encounter.read"],
            }}
          >
            <Routes>
              <Route path="/patients/:patientId/encounters" element={<PatientEncounters />} />
              <Route
                path="/patients/:patientId/encounters/:encounterId"
                element={<output aria-label="location">created</output>}
              />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Encounter workspace web workflow", () => {
  it.each([
    ["carePlan", "Open care plan", "/patients/patient-1/care-plan"],
    ["evv", "Open EVV reconciliation", "/evv/missing-resolutions"],
  ])(
    "links a server %s finalize blocker to its canonical correction surface",
    async (field, action, href) => {
      const get = vi.fn(async (path: string) => {
        if (path === "/api/v1/encounters/{encounterId}") return { data: encounter };
        if (path === "/api/v1/encounters/{encounterId}/cosignature")
          return { data: { status: null } };
        if (path === "/api/v1/patients/{id}")
          return {
            data: {
              firstName: "Ava",
              lastName: "Stone",
              dob: "1950-01-01",
              mrn: "MRN1",
              status: "active",
            },
          };
        if (path === "/api/v1/internal/care-plan/relevant-elements")
          return { data: { problems: [], goals: [], interventions: [], redacted: false } };
        return { data: { assessments: [] } };
      });
      const patch = vi.fn(async () => ({ data: { status: "ok" }, response: new Response() }));
      const post = vi.fn(async (path: string) =>
        path.endsWith("/finalize")
          ? {
              error: {
                error: {
                  code: "COMPLIANCE_GATE_FAILED",
                  message: "The encounter is not ready to finalize.",
                  details: [
                    {
                      field,
                      message: "Resolve this server-identified blocker before finalizing.",
                    },
                  ],
                },
              },
              response: new Response(null, { status: 422 }),
            }
          : { data: { status: "ok" }, response: new Response() },
      );
      renderEncounter({ GET: get, PATCH: patch, POST: post });

      fireEvent.click(await screen.findByRole("button", { name: "Review & finalize" }));
      const link = await screen.findByRole("link", { name: action });
      expect(link.getAttribute("href")).toBe(href);
    },
  );

  it("asks for the closure status again after a signature, so a lifted block's banner clears at once", async () => {
    let closureReads = 0;
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/encounters/closure-status") {
        closureReads += 1;
        return { data: { mode: "block", verdict: "clear", stage: "ok" }, response: new Response() };
      }
      if (path === "/api/v1/encounters/{encounterId}")
        return { data: { ...encounter, status: "finalized" } };
      if (path === "/api/v1/encounters/{encounterId}/cosignature")
        return { data: { status: null } };
      if (path === "/api/v1/patients/{id}")
        return {
          data: {
            firstName: "Ava",
            lastName: "Stone",
            dob: "1950-01-01",
            mrn: "MRN1",
            status: "active",
          },
        };
      if (path === "/api/v1/internal/care-plan/relevant-elements")
        return { data: { problems: [], goals: [], interventions: [], redacted: false } };
      return { data: { assessments: [] } };
    });
    const patch = vi.fn(async () => ({ data: { status: "ok" }, response: new Response() }));
    const post = vi.fn(async () => ({ data: { status: "ok" }, response: new Response() }));
    renderEncounter({ GET: get, PATCH: patch, POST: post }, true);

    fireEvent.click(await screen.findByRole("button", { name: "Sign encounter" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    // The sign ceremony asks how the visit was delivered (an RN's note cannot be signed without it).
    fireEvent.click(await screen.findByRole("radio", { name: "In person" }));
    await waitFor(() => expect(closureReads).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Sign & commit" }));
    await waitFor(() => expect(closureReads).toBe(2));
    expect(post).toHaveBeenCalledWith("/api/v1/encounters/{encounterId}/sign", expect.anything());
  });

  it("explains when an active Care Plan's linkable items are privacy-restricted", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/encounters/{encounterId}") return { data: encounter };
      if (path === "/api/v1/encounters/{encounterId}/cosignature")
        return { data: { status: null } };
      if (path === "/api/v1/patients/{id}")
        return {
          data: {
            firstName: "Ava",
            lastName: "Stone",
            dob: "1950-01-01",
            mrn: "MRN1",
            status: "active",
          },
        };
      if (path === "/api/v1/internal/care-plan/relevant-elements")
        return {
          data: {
            problems: [],
            goals: [],
            interventions: [],
            redacted: true,
          },
        };
      if (
        path === "/api/v1/patients/{patientId}/assessments" ||
        path === "/api/v1/patients/{patientId}/hope/assessments"
      )
        return { data: { assessments: [] } };
      return { data: null };
    });
    const patch = vi.fn(async () => ({ data: { status: "ok" }, response: new Response() }));
    const post = vi.fn(async () => ({ data: { status: "ok" }, response: new Response() }));
    renderEncounter({ GET: get, PATCH: patch, POST: post });

    expect(await screen.findByText("Care Plan items restricted")).toBeTruthy();
    expect(screen.getByText(/privacy or consent settings/i)).toBeTruthy();
    expect(screen.queryByText("No active Care Plan items")).toBeNull();
  });

  it("renders the addenda the server returns on a signed encounter, with their actions", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/encounters/{encounterId}")
        return {
          data: {
            ...encounter,
            status: "signed",
            signedAt: "2026-09-01T10:00:00Z",
            addenda: [
              {
                id: "add-1",
                status: "finalized",
                reason: "Correction to the recorded pain score",
                authoredByUserId: "mem-9",
                createdAt: "2026-09-02T10:00:00Z",
                signedAt: null,
                version: 1,
              },
            ],
          },
        };
      if (path === "/api/v1/encounters/{encounterId}/cosignature")
        return { data: { status: null } };
      if (path === "/api/v1/patients/{id}")
        return {
          data: {
            firstName: "Ava",
            lastName: "Stone",
            dob: "1950-01-01",
            mrn: "MRN1",
            status: "active",
          },
        };
      if (path === "/api/v1/internal/care-plan/relevant-elements")
        return { data: { problems: [], goals: [], interventions: [], redacted: false } };
      if (path === "/api/v1/encounters/{encounterId}/selections")
        return { data: { sections: [], layer1Preview: "", version: 1 } };
      return { data: { assessments: [] } };
    });
    const ok = vi.fn(async () => ({ data: { status: "ok" }, response: new Response() }));
    renderEncounter({ GET: get, PATCH: ok, POST: ok });

    expect(await screen.findByText("Correction to the recorded pain score")).toBeTruthy();
    expect(screen.getByText("mem-9")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign addendum" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
  });

  it("persists documentation, vitals, care-plan links, and finalize through M8 APIs", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/encounters/{encounterId}") return { data: encounter };
      if (path === "/api/v1/encounters/{encounterId}/cosignature")
        return { data: { status: null } };
      if (path === "/api/v1/patients/{id}")
        return {
          data: {
            firstName: "Ava",
            lastName: "Stone",
            dob: "1950-01-01",
            mrn: "MRN1",
            status: "active",
          },
        };
      if (path === "/api/v1/internal/care-plan/relevant-elements")
        return {
          data: {
            problems: [
              { problemId: "problem-1", description: "Pain management", status: "active" },
            ],
            goals: [
              {
                goalId: "goal-1",
                problemId: "problem-1",
                text: "Pain at target",
                status: "in_progress",
              },
            ],
            interventions: [
              {
                interventionId: "intervention-1",
                problemId: "problem-1",
                scopeText: "Assess pain response",
                frequencyText: "Each visit",
                discipline: "rn",
                status: "active",
              },
            ],
            redacted: false,
          },
        };
      if (path === "/api/v1/patients/{patientId}/assessments") return { data: { assessments: [] } };
      if (path === "/api/v1/patients/{patientId}/hope/assessments")
        return { data: { assessments: [] } };
      return { data: null };
    });
    const patch = vi.fn(async () => ({ data: { status: "ok" }, response: new Response() }));
    const post = vi.fn(async () => ({ data: { status: "ok" }, response: new Response() }));
    renderEncounter({ GET: get, PATCH: patch, POST: post });

    // #91/#114 — the note is authored in the HearthNote composer (sections + DEK-sealed free text), not
    // a single free-text box; the workspace links to it for a draft.
    expect(await screen.findByRole("button", { name: /compose note/i })).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Heart rate/i), { target: { value: "72" } });
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

  it("says the note was signed while the vitals were being saved (409 IMMUTABLE_AFTER_SIGN), in the app's words", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/encounters/{encounterId}") return { data: encounter };
      if (path === "/api/v1/encounters/{encounterId}/cosignature")
        return { data: { status: null } };
      if (path === "/api/v1/patients/{id}")
        return {
          data: {
            firstName: "Ava",
            lastName: "Stone",
            dob: "1950-01-01",
            mrn: "MRN1",
            status: "active",
          },
        };
      if (path === "/api/v1/internal/care-plan/relevant-elements")
        return { data: { problems: [], goals: [], interventions: [], redacted: false } };
      return { data: { assessments: [] } };
    });
    const post = vi.fn(async () => ({
      error: {
        error: {
          code: "IMMUTABLE_AFTER_SIGN",
          message: "encounter is 'signed'; edits are only permitted via an addendum",
        },
      },
      response: new Response(null, { status: 409 }),
    }));
    renderEncounter({ GET: get, PATCH: vi.fn(), POST: post });

    fireEvent.change(await screen.findByLabelText(/Heart rate/i), { target: { value: "72" } });
    fireEvent.click(screen.getByRole("button", { name: /save vitals/i }));
    expect(await screen.findByText(/signed while you were working/)).toBeTruthy();
    expect(screen.getByText(/not saved/)).toBeTruthy();
    expect(screen.queryByText(/edits are only permitted/)).toBeNull();
  });

  it("creates a PRN Encounter without inventing an M17 Visit", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/encounters") return { data: { encounters: [] } };
      if (path === "/api/v1/patients/{id}")
        return {
          data: {
            firstName: "Ava",
            lastName: "Stone",
            dob: "1950-01-01",
            mrn: "MRN1",
            status: "active",
          },
        };
      // #161 — the admission lookup reads the PATIENT-scoped list (not the org-wide census) and
      // filters to `state="active"` client-side, so a discharged admission must not be offered.
      if (path === "/api/v1/patients/{patientId}/admissions")
        return {
          data: {
            items: [
              {
                id: "admission-1",
                state: "active",
                admissionAt: "2026-08-01T00:00:00Z",
                dischargedAt: null,
              },
              {
                id: "admission-0",
                state: "discharged",
                admissionAt: "2025-01-01T00:00:00Z",
                dischargedAt: "2025-03-01T00:00:00Z",
              },
            ],
          },
        };
      return { data: null };
    });
    const post = vi.fn(async () => ({ data: { id: "enc-prn" }, response: new Response() }));
    renderPatientEncounters({ GET: get, POST: post });

    await screen.findByText("Encounters / Visits");
    fireEvent.click(screen.getByRole("button", { name: /^new encounter$/i }));
    // The admission lookup is an ARIA combobox whose popup listbox shares its label, so the
    // label alone matches two nodes — address the input by its role.
    fireEvent.focus(screen.getByRole("combobox", { name: /active admission/i }));
    await waitFor(() => expect(screen.getByText("Admitted Aug 1, 2026")).toBeTruthy());
    expect(get).toHaveBeenCalledWith(
      "/api/v1/patients/{patientId}/admissions",
      expect.objectContaining({ params: { path: { patientId: "patient-1" } } }),
    );
    expect(screen.queryByText("Admitted Jan 1, 2025")).toBeNull();
    fireEvent.click(screen.getByText("Admitted Aug 1, 2026"));
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

  it("offers patient-scoped admission creation paths when no active admission matches", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/encounters") return { data: { encounters: [] } };
      if (path === "/api/v1/patients/{id}")
        return {
          data: {
            firstName: "Ava",
            lastName: "Stone",
            dob: "1950-01-01",
            mrn: "MRN1",
            status: "active",
          },
        };
      if (path === "/api/v1/patients/{patientId}/admissions") return { data: { items: [] } };
      return { data: null };
    });
    const post = vi.fn(async () => ({ data: { id: "enc-prn" }, response: new Response() }));
    renderPatientEncounters({ GET: get, POST: post });

    await screen.findByText("Encounters / Visits");
    fireEvent.click(screen.getByRole("button", { name: /^new encounter$/i }));
    // The admission lookup is an ARIA combobox whose popup listbox shares its label, so the
    // label alone matches two nodes — address the input by its role.
    fireEvent.focus(screen.getByRole("combobox", { name: /active admission/i }));

    expect(
      (await screen.findByRole("link", { name: /direct admission/i })).getAttribute("href"),
    ).toBe("/admissions/new?patientId=patient-1");
    expect(screen.getByRole("link", { name: /start referral/i }).getAttribute("href")).toBe(
      "/referrals/new?patientId=patient-1",
    );
  });
});
