import { ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { MyVisits } from "../my-visits";
import { NewVisitModal, VisitActionPanel } from "../scheduling-workflow";

const visit = {
  id: "00000000-0000-4000-8000-000000000017",
  organizationId: "org-1",
  patientId: "00000000-0000-4000-8000-000000000005",
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

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}</output>;
}

function renderMyVisits(client: { GET: ReturnType<typeof vi.fn>; POST: ReturnType<typeof vi.fn> }) {
  render(
    <MemoryRouter initialEntries={["/me/visits"]}>
      <ApiClientProvider client={client as never}>
        <SessionProvider
          session={{
            userId: "user-1",
            organizationId: "org-1",
            permissions: ["visit.read", "visit.start", "visit.create"],
          }}
        >
          <Routes>
            <Route path="/me/visits" element={<MyVisits />} />
            <Route path="/step-up" element={<LocationProbe />} />
            <Route
              path="/patients/:patientId/encounters/:encounterId"
              element={<LocationProbe />}
            />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

function renderSchedulingWidget(
  client: { GET: ReturnType<typeof vi.fn>; POST: ReturnType<typeof vi.fn> },
  element: ReactNode,
) {
  render(
    <MemoryRouter initialEntries={["/scheduling/day"]}>
      <ApiClientProvider client={client as never}>
        <SessionProvider
          session={{
            userId: "user-1",
            organizationId: "org-1",
            permissions: [
              "visit.read",
              "visit.read_team",
              "visit.create",
              "visit.start",
              "visit.reassign",
              "visit.reschedule",
              "visit.cancel",
              "visit.mark_no_show",
            ],
          }}
        >
          <Routes>
            <Route path="/scheduling/day" element={element} />
            <Route path="/scheduling/visits/:visitId" element={<LocationProbe />} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("MyVisits web workflow", () => {
  const REASON =
    "Device GPS was offline in the patient's rural home; no EVV bracket could be recorded.";

  async function openStartDialog(client: {
    GET: ReturnType<typeof vi.fn>;
    POST: ReturnType<typeof vi.fn>;
  }) {
    renderMyVisits(client);
    await screen.findByText("Scheduled visit");
    fireEvent.click(screen.getByRole("button", { name: /^start visit/i }));
    return screen.findByRole("dialog");
  }

  it("starts a published Visit with the mandatory EVV reason and refreshes the list", async () => {
    const get = vi.fn(async (..._args: unknown[]) => ({ data: [visit] }));
    const post = vi.fn(async () => ({ data: { ...visit, status: "en_route" } }));
    const dialog = await openStartDialog({ GET: get, POST: post });

    fireEvent.change(within(dialog).getByLabelText(/reason there is no evv bracket/i), {
      target: { value: REASON },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /confirm/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/visits/{visitId}/start", {
        params: { path: { visitId: visit.id } },
        body: { evvMissingReason: REASON },
      }),
    );
    // The list loads, then reloads after the start (patient-name lookups are separate GETs).
    expect(get.mock.calls.filter(([path]) => path === "/api/v1/visits")).toHaveLength(2);
  });

  it("refuses a start reason shorter than 40 characters without calling the server", async () => {
    const post = vi.fn(async () => ({ data: visit }));
    const dialog = await openStartDialog({
      GET: vi.fn(async () => ({ data: [visit] })),
      POST: post,
    });

    fireEvent.change(within(dialog).getByLabelText(/reason there is no evv bracket/i), {
      target: { value: "too short" },
    });
    expect(within(dialog).getByText(/at least 40 characters \(9\/40\)/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /confirm/i }));

    expect((await within(dialog).findAllByRole("alert")).length).toBeGreaterThan(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("sends the user through step-up when the server asks for a fresh one", async () => {
    const post = vi.fn(async () => ({
      error: { code: "STEP_UP_REQUIRED" },
      response: { status: 403 },
    }));
    const dialog = await openStartDialog({
      GET: vi.fn(async () => ({ data: [visit] })),
      POST: post,
    });

    fireEvent.change(within(dialog).getByLabelText(/reason there is no evv bracket/i), {
      target: { value: REASON },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /confirm/i }));

    const where = await screen.findByLabelText("location");
    expect(where.textContent).toBe("/step-up");
  });

  it("explains the 403 when the caller is not the assigned clinician", async () => {
    const post = vi.fn(async () => ({
      error: { code: "FORBIDDEN", message: "ASSIGNED_CLINICIAN_REQUIRED" },
      response: { status: 403 },
    }));
    const dialog = await openStartDialog({
      GET: vi.fn(async () => ({ data: [visit] })),
      POST: post,
    });

    fireEvent.change(within(dialog).getByLabelText(/reason there is no evv bracket/i), {
      target: { value: REASON },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /confirm/i }));

    expect(await within(dialog).findByText(/only the clinician assigned/i)).toBeTruthy();
  });

  it("opens the linked Encounter without creating a duplicate Encounter", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/visits") return { data: [{ ...visit, status: "in_visit" }] };
      if (path === "/api/v1/encounters")
        return {
          data: {
            encounters: [
              {
                id: "enc-1",
                patientId: visit.patientId,
                admissionId: visit.admissionId,
                visitId: visit.id,
                encounterType: "routine_visit",
                discipline: "rn",
                serviceDate: "2026-08-31",
                status: "draft",
                signedAt: null,
                cosignedAt: null,
              },
            ],
          },
        };
      return { data: null };
    });
    const post = vi.fn(async () => ({ data: null }));
    renderMyVisits({ GET: get, POST: post });

    await screen.findByText("Scheduled visit");
    fireEvent.click(screen.getByRole("button", { name: /^open encounter/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        `/patients/${visit.patientId}/encounters/enc-1`,
      ),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("creates a Visit through the real M17 create contract", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/patients")
        return {
          data: {
            items: [
              {
                id: visit.patientId,
                firstName: "Ava",
                lastName: "Stone",
                dob: "1950-01-01",
                mrn: "MRN1",
                status: "active",
              },
            ],
          },
        };
      // F-066 (#161): the admission lookup reads the PATIENT's admissions, never the org-wide census.
      if (path === "/api/v1/patients/{patientId}/admissions")
        return {
          data: {
            items: [
              {
                id: visit.admissionId,
                state: "active",
                admissionAt: "2026-01-02T00:00:00.000Z",
                dischargedAt: null,
              },
            ],
          },
        };
      if (path === "/api/v1/scheduling/eligible-clinicians")
        return {
          data: [
            {
              membershipId: visit.assignedMembershipId,
              displayName: "Nurse One",
              disciplines: ["rn"],
              eligible: true,
              reasonCodes: [],
            },
          ],
        };
      if (path === "/api/v1/orgs/{id}/members")
        return {
          data: {
            members: [
              {
                membershipId: visit.assignedMembershipId,
                displayName: "Nurse One",
                email: "nurse@example.test",
                status: "active",
              },
            ],
          },
        };
      return { data: null };
    });
    const post = vi.fn(async () => ({ data: visit }));
    renderSchedulingWidget(
      { GET: get, POST: post },
      <NewVisitModal open onClose={() => undefined} onCreated={() => undefined} />,
    );

    fireEvent.focus(screen.getByPlaceholderText(/search patient name or mrn/i));
    await waitFor(() => expect(screen.getByText("Stone, Ava")).toBeTruthy());
    fireEvent.click(screen.getByText("Stone, Ava"));
    await waitFor(() =>
      expect((screen.getByLabelText(/active admission/i) as HTMLInputElement).disabled).toBe(false),
    );
    fireEvent.focus(screen.getByLabelText(/active admission/i));
    await waitFor(() => expect(screen.getByText(/Admitted Jan 2, 2026/i)).toBeTruthy());
    fireEvent.click(screen.getByText(/Admitted Jan 2, 2026/i));
    await waitFor(() => expect(screen.getByRole("option", { name: /nurse one/i })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/assigned clinician/i), {
      target: { value: visit.assignedMembershipId },
    });
    fireEvent.change(screen.getByLabelText(/scheduled start/i), {
      target: { value: "2026-08-31T10:00" },
    });
    fireEvent.change(screen.getByLabelText(/scheduled end/i), {
      target: { value: "2026-08-31T11:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create visit/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/visits",
        expect.objectContaining({
          body: expect.objectContaining({
            patientId: visit.patientId,
            admissionId: visit.admissionId,
            assignedMembershipId: visit.assignedMembershipId,
          }),
        }),
      ),
    );
  });

  it("uses dedicated M17 endpoints for reassign, cancel, no-show, and reschedule", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/scheduling/eligible-clinicians")
        return {
          data: [
            {
              membershipId: "00000000-0000-4000-8000-000000000008",
              displayName: "Nurse Two",
              disciplines: ["rn"],
              eligible: true,
              reasonCodes: [],
            },
          ],
        };
      if (path === "/api/v1/orgs/{id}/members")
        return {
          data: {
            members: [
              {
                membershipId: "00000000-0000-4000-8000-000000000008",
                displayName: "Nurse Two",
                email: "nurse2@example.test",
                status: "active",
              },
            ],
          },
        };
      return { data: null };
    });
    const post = vi.fn(async (path: string) => ({
      data:
        path === "/api/v1/visits/{visitId}/reschedule"
          ? { original: { ...visit, status: "rescheduled" }, created: { ...visit, id: "visit-2" } }
          : visit,
    }));
    renderSchedulingWidget(
      { GET: get, POST: post },
      <VisitActionPanel visit={visit} encounter={null} onChanged={() => undefined} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reassign/i }));
    await waitFor(() => expect(screen.getByRole("option", { name: /nurse two/i })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/new clinician/i), {
      target: { value: "00000000-0000-4000-8000-000000000008" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/visits/{visitId}/reassign", expect.any(Object)),
    );

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.getByLabelText(/reason for cancellation/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/reason for cancellation/i), {
      target: { value: "Patient cancelled due to appointment conflict." },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/visits/{visitId}/cancel", expect.any(Object)),
    );

    fireEvent.click(screen.getByRole("button", { name: /no-show/i }));
    fireEvent.change(screen.getByLabelText(/^reason$/i), {
      target: { value: "Patient was not available at scheduled time." },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/visits/{visitId}/no-show", expect.any(Object)),
    );

    fireEvent.click(screen.getByRole("button", { name: /reschedule/i }));
    fireEvent.change(screen.getByLabelText(/new start/i), {
      target: { value: "2026-09-01T10:00" },
    });
    fireEvent.change(screen.getByLabelText(/new end/i), { target: { value: "2026-09-01T11:00" } });
    await waitFor(() => expect(screen.getByRole("option", { name: /nurse two/i })).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "00000000-0000-4000-8000-000000000008" },
    });
    fireEvent.change(screen.getByLabelText(/reason for rescheduling/i), {
      target: { value: "Patient requested a different time." },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/visits/{visitId}/reschedule", expect.any(Object)),
    );
  });

  it("explains a clinician scheduling conflict when rescheduling", async () => {
    const post = vi.fn(async () => ({
      error: {
        code: "CONFLICT",
        reason: "CLINICIAN_SCHEDULE_CONFLICT",
        message: "This clinician already has another visit during this time.",
      },
    }));
    renderSchedulingWidget(
      {
        GET: vi.fn(async (path: string) =>
          path === "/api/v1/scheduling/eligible-clinicians"
            ? {
                data: [
                  {
                    membershipId: visit.assignedMembershipId,
                    displayName: "Nurse One",
                    disciplines: ["rn"],
                    eligible: true,
                    reasonCodes: [],
                  },
                ],
              }
            : { data: null },
        ),
        POST: post,
      },
      <VisitActionPanel visit={visit} encounter={null} onChanged={() => undefined} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reschedule/i }));
    await waitFor(() => expect(screen.getByRole("option", { name: /nurse one/i })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/reason for rescheduling/i), {
      target: { value: "Patient requested a different time." },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(
      await screen.findByText(
        "The selected clinician already has a visit during this time. Choose another clinician or a different time.",
      ),
    ).toBeTruthy();
  });
});
