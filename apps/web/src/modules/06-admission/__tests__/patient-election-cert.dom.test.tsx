// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { PatientElectionCert } from "../patient-election-cert";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Sarah Miller",
  roles: ["rn", "medical_director"],
  permissions: ["election.read"],
};

function ok(data: unknown) {
  return {
    data,
    error: undefined,
    response: new Response(null, { status: 200 }),
  };
}

function clientFor(
  options: {
    failCtiOnce?: boolean;
    f2fState?: "scheduled" | "completed" | "attested";
    outsideWindow?: boolean;
    /** Period 4's only CTI (default: none). */
    period4CtiStatus?: "voided" | "superseded";
  } = {},
): ApiClient {
  const f2fState = options.f2fState ?? "attested";
  let ctiFailuresRemaining = options.failCtiOnce ? 1 : 0;

  return {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/patients/{id}") {
        return ok({
          id: "patient-1",
          mrn: "MRN-1001",
          firstName: "Elena",
          lastName: "Rivera",
          dob: "1946-04-12",
          status: "active",
        });
      }

      if (path === "/api/v1/patients/{patientId}/election-certification") {
        return ok({
          admission: {
            id: "admission-1",
            state: "active",
            admissionAt: "2026-10-01T10:00:00.000Z",
            activatedAt: "2026-10-01T12:00:00.000Z",
            dischargedAt: null,
            version: 2,
          },
          periods: [
            {
              id: "period-1",
              sequenceNumber: 1,
              periodKind: "ninety_day",
              effectiveAt: "2026-10-01",
              scheduledEndAt: "2026-12-29",
              actualEndAt: null,
              status: "active",
              electionStatement: {
                id: "election-1",
                status: "signed",
                signerKind: "patient",
                signedAt: "2026-10-01T09:30:00.000Z",
                sourceType: "structured",
              },
              cti: {
                id: "cti-1",
                status: "signed",
                sourceType: "structured",
                hospiceMdSigned: true,
                attendingMdSigned: false,
                signedLate: false,
                periodStart: "2026-10-01",
                periodEnd: "2026-12-29",
              },
              faceToFace: null,
            },
            {
              id: "period-2",
              sequenceNumber: 2,
              periodKind: "ninety_day",
              effectiveAt: "2026-12-30",
              scheduledEndAt: "2027-03-29",
              actualEndAt: null,
              status: "pending",
              electionStatement: null,
              cti: {
                id: "cti-2",
                status: "awaiting_hospice_md",
                sourceType: "structured",
                hospiceMdSigned: false,
                attendingMdSigned: false,
                signedLate: false,
                periodStart: "2026-12-30",
                periodEnd: "2027-03-29",
              },
              faceToFace: null,
            },
            {
              id: "period-3",
              sequenceNumber: 3,
              periodKind: "sixty_day",
              effectiveAt: "2027-03-30",
              scheduledEndAt: "2027-05-28",
              actualEndAt: null,
              status: "active",
              electionStatement: null,
              cti: null,
              faceToFace: {
                id: "f2f-3",
                status: f2fState,
                performerRole: "hospice_physician",
                performerUserId: session.userId,
                encounterDate: f2fState === "scheduled" ? null : "2027-03-20",
                encounterLocation: f2fState === "scheduled" ? null : "telehealth",
                attestationNoteEncounterId: null,
                withinWindow: f2fState === "scheduled" ? null : !options.outsideWindow,
                windowOverride: false,
                attested: f2fState === "attested",
              },
            },
            {
              id: "period-4",
              sequenceNumber: 4,
              periodKind: "sixty_day",
              effectiveAt: "2027-05-29",
              scheduledEndAt: "2027-07-27",
              actualEndAt: null,
              status: "pending",
              electionStatement: null,
              cti: options.period4CtiStatus
                ? {
                    id: "cti-4",
                    status: options.period4CtiStatus,
                    sourceType: "structured",
                    hospiceMdSigned: false,
                    attendingMdSigned: false,
                    signedLate: false,
                    periodStart: "2027-05-29",
                    periodEnd: "2027-07-27",
                  }
                : null,
              faceToFace: null,
            },
          ],
          complianceWindows: [],
        });
      }

      if (path === "/api/v1/election-statements/{id}") {
        return ok({ id: "election-1", state: "signed", version: 3 });
      }

      if (path === "/api/v1/cti/{id}") {
        if (ctiFailuresRemaining > 0) {
          ctiFailuresRemaining -= 1;
          return {
            data: undefined,
            error: { error: { code: "UNAVAILABLE" } },
            response: new Response(null, { status: 503 }),
          };
        }
        return ok({ id: "cti-1", state: "signed", version: 4 });
      }

      if (path === "/api/v1/face-to-face/{id}") {
        return ok({ id: "f2f-3", state: f2fState, version: 2 });
      }

      if (path === "/api/v1/encounters") {
        const note = {
          encounterType: "face_to_face",
          discipline: "md",
          serviceDate: "2027-03-20",
          authoredByUserId: session.userId,
        };
        return ok({
          encounters: [
            { ...note, id: "enc-signed", status: "signed", signedAt: "2027-03-20T18:00:00Z" },
            { ...note, id: "enc-draft", status: "draft", signedAt: null },
            {
              ...note,
              id: "enc-other-author",
              status: "signed",
              signedAt: "2027-03-20T19:00:00Z",
              authoredByUserId: "someone-else",
            },
          ],
        });
      }

      return ok({});
    }),
    POST: vi.fn(async () => ok({})),
  } as unknown as ApiClient;
}

function renderWorkspace(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/election-certification"]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <Routes>
            <Route
              path="/patients/:patientId/election-certification"
              element={<PatientElectionCert />}
            />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Patient Election & Certification workspace", () => {
  it("separates the hospice election from period-specific CTI and F2F requirements", async () => {
    renderWorkspace(clientFor());

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Hospice Election" })).toBeTruthy(),
    );

    expect(screen.getAllByText("Election Statement")).toHaveLength(1);
    expect(screen.getByText("CTI — Initial Certification")).toBeTruthy();
    expect(screen.getAllByText("CTI — Recertification")).toHaveLength(3);
    expect(screen.getAllByText("Not required")).toHaveLength(2);
    expect(screen.getByText("Required — not scheduled")).toBeTruthy();
    expect(screen.getAllByText(/Attending pending/)).toHaveLength(1);

    expect(screen.getByRole("button", { name: "Sign CTI" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Create CTI" })).toHaveLength(2);
  });

  it("offers Create CTI beside a period's only (voided) CTI, which stays visible as history", async () => {
    renderWorkspace(clientFor({ period4CtiStatus: "voided" }));

    // Period 3 (no CTI) and period 4 (voided CTI only) can each start a new CTI.
    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "Create CTI" })).toHaveLength(2),
    );
    // The voided CTI is still shown, with its details reachable.
    expect(screen.getByRole("button", { name: "View Period 4 CTI details" })).toBeTruthy();
    // ...but it is never offered for signature.
    expect(screen.getAllByRole("button", { name: "Sign CTI" })).toHaveLength(1);
  });

  it("does not offer Create CTI beside a superseded CTI (the live replacement blocks a new draft)", async () => {
    renderWorkspace(clientFor({ period4CtiStatus: "superseded" }));

    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "Create CTI" })).toHaveLength(1),
    );
  });

  it("loads Election Statement details only after View details is clicked", async () => {
    const client = clientFor();
    renderWorkspace(client);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "View Election Statement details" })).toBeTruthy(),
    );
    expect(client.GET).not.toHaveBeenCalledWith(
      "/api/v1/election-statements/{id}",
      expect.anything(),
    );

    fireEvent.click(screen.getByRole("button", { name: "View Election Statement details" }));

    const dialog = await screen.findByRole("dialog", { name: "Election Statement details" });
    await waitFor(() => expect(within(dialog).getByText("Version")).toBeTruthy());
    expect(within(dialog).getByText("Structured")).toBeTruthy();
    expect(within(dialog).getByText("Patient")).toBeTruthy();
    expect(client.GET).toHaveBeenCalledWith("/api/v1/election-statements/{id}", {
      params: { path: { id: "election-1" } },
    });
  });

  it("loads and displays CTI details for the selected benefit period", async () => {
    const client = clientFor();
    renderWorkspace(client);

    fireEvent.click(await screen.findByRole("button", { name: "View Period 1 CTI details" }));

    const dialog = await screen.findByRole("dialog", { name: "CTI details" });
    await waitFor(() => expect(within(dialog).getByText("Initial Certification")).toBeTruthy());
    expect(within(dialog).getByText("Period 1")).toBeTruthy();
    expect(within(dialog).getByText("Hospice Medical Director")).toBeTruthy();
    expect(client.GET).toHaveBeenCalledWith("/api/v1/cti/{id}", {
      params: { path: { id: "cti-1" } },
    });
  });

  it("loads and displays Face-to-Face details for an existing record", async () => {
    const client = clientFor();
    renderWorkspace(client);

    fireEvent.click(
      await screen.findByRole("button", { name: "View Period 3 Face-to-Face details" }),
    );

    // 2026-09-25 redesign — the F2F opens in the right rail (admissions drawer), not a centered modal.
    const rail = await screen.findByRole("complementary", { name: "Face-to-Face details" });
    await waitFor(() => expect(within(rail).getByText("Period 3")).toBeTruthy());
    expect(within(rail).getByText("Hospice Physician")).toBeTruthy();
    expect(within(rail).getByText("Telehealth (audio + video)")).toBeTruthy();
    expect(within(rail).getByText("Written attestation")).toBeTruthy();
    expect(within(rail).getByText("G0679")).toBeTruthy();
    expect(client.GET).toHaveBeenCalledWith("/api/v1/face-to-face/{id}", {
      params: { path: { id: "f2f-3" } },
    });
  });

  it("records a telehealth completion with the (A)-(C) eligibility answers (R-F2F-05)", async () => {
    const client = clientFor({ f2fState: "scheduled" });
    renderWorkspace(client);
    fireEvent.click(
      await screen.findByRole("button", { name: "View Period 3 Face-to-Face details" }),
    );
    const rail = await screen.findByRole("complementary", { name: "Face-to-Face details" });
    const submit = await within(rail).findByRole("button", { name: "Record completion" });

    fireEvent.change(within(rail).getByLabelText(/Encounter date/), {
      target: { value: "2027-03-20" },
    });
    fireEvent.change(within(rail).getByLabelText(/Modality/), { target: { value: "telehealth" } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(rail).getByLabelText(/moratorium/), { target: { value: "no" } });
    fireEvent.change(within(rail).getByLabelText(/enhanced oversight/), {
      target: { value: "no" },
    });
    fireEvent.change(within(rail).getByLabelText(/Medicare-enrolled/), {
      target: { value: "yes" },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith("/api/v1/face-to-face/{id}/complete", {
        params: { path: { id: "f2f-3" } },
        body: {
          encounterDate: "2027-03-20",
          encounterLocation: "telehealth",
          telehealthEligibility: {
            patientInMoratoriumArea: false,
            hospiceUnderEnhancedOversight: false,
            performerMedicareEnrolledOrOptedOut: true,
          },
          ifVersion: 2,
        },
      }),
    );
  });

  it("schedules a missing face-to-face for a period that requires one (GAP-023)", async () => {
    const client = clientFor();
    renderWorkspace(client);
    fireEvent.click(await screen.findByRole("button", { name: "Schedule Period 4 Face-to-Face" }));
    const rail = await screen.findByRole("complementary", { name: "Schedule Face-to-Face" });
    const submit = within(rail).getByRole("button", { name: "Schedule face-to-face" });
    fireEvent.change(within(rail).getByLabelText(/Scheduled date/), {
      target: { value: "2027-05-20" },
    });
    fireEvent.change(within(rail).getByLabelText(/Performer role/), {
      target: { value: "hospice_md" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith("/api/v1/admissions/{id}/face-to-face", {
        params: { path: { id: "admission-1" } },
        body: {
          electionPeriodId: "period-4",
          scheduledDate: "2027-05-20",
          windowStart: "2027-04-29",
          windowEnd: "2027-05-29",
          clinicianRole: "hospice_md",
          scheduledClinicianId: session.userId,
        },
      }),
    );
  });

  it("overrides an out-of-window face-to-face with a reason (GAP-023)", async () => {
    const client = clientFor({ f2fState: "completed", outsideWindow: true });
    renderWorkspace(client);
    fireEvent.click(
      await screen.findByRole("button", { name: "View Period 3 Face-to-Face details" }),
    );
    const rail = await screen.findByRole("complementary", { name: "Face-to-Face details" });
    const submit = await within(rail).findByRole("button", { name: "Override window" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(rail).getByLabelText(/Override reason/), {
      target: { value: "Patient hospitalised during the window; documented by the MD." },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith("/api/v1/face-to-face/{id}/override-window", {
        params: { path: { id: "f2f-3" } },
        body: {
          reason: "Patient hospitalised during the window; documented by the MD.",
          ifVersion: 2,
        },
      }),
    );
  });

  it("attests by linking the performer's signed visit note, or a >= 100-char narrative (R-F2F-06)", async () => {
    const client = clientFor({ f2fState: "completed" });
    renderWorkspace(client);
    fireEvent.click(
      await screen.findByRole("button", { name: "View Period 3 Face-to-Face details" }),
    );
    const rail = await screen.findByRole("complementary", { name: "Face-to-Face details" });
    const noteSelect = (await within(rail).findByLabelText(
      /Signed visit note/,
    )) as HTMLSelectElement;
    // Only the performer's SIGNED note on the encounter date is offered.
    expect(Array.from(noteSelect.options).map((o) => o.value)).toEqual(["", "enc-signed"]);
    fireEvent.change(noteSelect, { target: { value: "enc-signed" } });
    fireEvent.click(within(rail).getByRole("button", { name: "Attest face-to-face" }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith("/api/v1/face-to-face/{id}/attest", {
        params: { path: { id: "f2f-3" } },
        body: { signedNoteEncounterId: "enc-signed", ifVersion: 2 },
      }),
    );

    fireEvent.change(within(rail).getByLabelText(/^Attestation$/), {
      target: { value: "narrative" },
    });
    const attest = within(rail).getByRole("button", { name: "Attest face-to-face" });
    fireEvent.change(within(rail).getByLabelText(/Attestation narrative/), {
      target: { value: "too short" },
    });
    expect((attest as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(rail).getByLabelText(/Attestation narrative/), {
      target: { value: "x".repeat(100) },
    });
    expect((attest as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks for the physician narrative when the CTI has none (transfer-in draft) and signs with it", async () => {
    const client = clientFor();
    const narrative = "N".repeat(200);
    let signs = 0;
    client.POST = vi.fn(async (_path: string, init: { body?: { narrative?: string } }) => {
      signs += 1;
      if (init.body?.narrative === undefined) {
        return {
          data: undefined,
          error: {
            error: {
              code: "CTI_NARRATIVE_REQUIRED",
              message: "The certification narrative is required before signing.",
            },
          },
          response: new Response(null, { status: 422 }),
        };
      }
      return ok({ id: "cti-2", state: "signed", version: 5 });
    }) as never;
    renderWorkspace(client);

    fireEvent.click(await screen.findByRole("button", { name: "Sign CTI" }));
    const dialog = await screen.findByRole("dialog", { name: "Add the certification narrative" });
    const submit = within(dialog).getByRole("button", { name: "Sign CTI" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // < 200 characters

    fireEvent.change(within(dialog).getByLabelText(/Physician narrative/), {
      target: { value: narrative },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(signs).toBe(2));
    expect(client.POST).toHaveBeenLastCalledWith("/api/v1/cti/{id}/sign-hospice-md", {
      params: { path: { id: "cti-2" } },
      body: { ifVersion: 4, narrative },
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add the certification narrative" })).toBeNull(),
    );
  });

  it("shows a readable detail error and retries the request", async () => {
    const client = clientFor({ failCtiOnce: true });
    renderWorkspace(client);

    fireEvent.click(await screen.findByRole("button", { name: "View Period 1 CTI details" }));

    expect(await screen.findByText("Unable to load CTI details.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    const dialog = screen.getByRole("dialog", { name: "CTI details" });
    await waitFor(() => expect(within(dialog).getByText("Initial Certification")).toBeTruthy());
    // 2 page reads + the FY2027 election-addendum read + 2 CTI detail attempts.
    expect(client.GET).toHaveBeenCalledTimes(5);
  });
});
