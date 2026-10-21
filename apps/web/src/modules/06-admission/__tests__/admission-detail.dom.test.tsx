// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AdmissionDetail, type InitialEvidenceUpload } from "../admission-detail";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Sarah Miller",
  permissions: ["admission.read", "admission.update"],
};

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const providerEntityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const locationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const hospicePhysicianId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

interface ReadinessFixture {
  admissionId: string;
  status: string;
  canActivate: boolean;
  completed: number;
  blockingRemaining: number;
  requirements: Array<{
    code: string;
    label: string;
    status: string;
    blocking: boolean;
    message?: string;
    action?: string;
    reasonCode?: string;
  }>;
}

function readiness(overrides?: Partial<ReadinessFixture>): ReadinessFixture {
  return { ...baseReadiness(), ...overrides };
}

function baseReadiness(): ReadinessFixture {
  return {
    admissionId,
    status: "action_required",
    canActivate: false,
    completed: 4,
    blockingRemaining: 2,
    requirements: [
      {
        code: "patient_identity",
        label: "Patient identity",
        status: "complete",
        blocking: true,
      },
      {
        code: "admission_details",
        label: "Admission details",
        status: "complete",
        blocking: true,
      },
      {
        code: "patient_privacy",
        label: "Patient privacy",
        status: "complete",
        blocking: true,
      },
      {
        code: "notice_of_rights",
        label: "Notice of Rights",
        status: "action_required",
        blocking: true,
        message: "Notice of Rights acknowledgment is required.",
        action: "ACKNOWLEDGE_NOR",
      },
      {
        code: "election_statement",
        label: "Election Statement",
        status: "action_required",
        blocking: true,
        message: "Election Statement must be signed.",
        action: "COMPLETE_ELECTION",
      },
      {
        code: "cti",
        label: "Certification of Terminal Illness",
        status: "complete",
        blocking: true,
      },
      { code: "f2f", label: "Face-to-Face", status: "not_applicable", blocking: false },
    ],
  };
}

function clientFor(readinessResponse = readiness()): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/admissions/{id}") {
        return ok({
          id: admissionId,
          state: "pending",
          status: "pending",
          version: 4,
          patientId: "patient-1",
          referralId: "referral-1",
          admissionAt: "2026-08-28T10:00:00.000Z",
          activatedAt: null,
          providerEntityId,
          locationId,
          hospicePhysicianId,
          hospicePhysician: { displayName: "Dr. Amara Okafor" },
          activationGate: { ready: false, missing: ["election_signed", "nor_acknowledged"] },
        });
      }
      if (path === "/api/v1/admissions/{id}/readiness") {
        return ok(readinessResponse);
      }
      if (path === "/api/v1/admissions/{admissionId}/hope") {
        return ok({
          admissionAssessment: {
            status: "completed",
            attention: { state: "none", severity: "none" },
          },
          huv1: { status: "open", attention: { state: "due_soon", severity: "warn" } },
          huv2: { status: "upcoming", attention: { state: "upcoming", severity: "info" } },
          dischargeAssessment: {
            status: "not_applicable",
            attention: { state: "none", severity: "none" },
          },
          sfvs: [{ status: "overdue", attention: { state: "overdue", severity: "critical" } }],
          summary: {
            actionableCount: 2,
            overdueCount: 1,
            dueSoonCount: 1,
            workflowIssueCount: 0,
            highestSeverity: "critical",
            nextDeadline: "2026-09-04T23:59:59.999Z",
          },
        });
      }
      if (path === "/api/v1/admissions/{id}/election-periods")
        return ok({ items: [{ id: "period-1", state: "active", version: 1 }], nextCursor: null });
      if (path === "/api/v1/patients/{patientId}/election-certification")
        return ok({
          admission: null,
          periods: [
            {
              id: "period-1",
              state: "pending",
              version: 1,
              sequenceNumber: 1,
              periodKind: "ninety_day",
              effectiveAt: null,
              scheduledEndAt: null,
              actualEndAt: null,
              electionStatement: null,
              cti: null,
            },
          ],
        });
      if (path === "/api/v1/patients/{id}")
        return ok({
          id: "patient-1",
          organizationId: "org-1",
          mrn: "MRN-1001",
          lastName: "Rivera",
          firstName: "Elena",
          dob: "1946-04-12",
          status: "active",
        });
      if (path === "/api/v1/patients/{id}/addresses")
        return ok({
          addresses: [
            {
              id: "address-1",
              kind: "home",
              isPrimary: true,
              current: true,
              line1: "12 Harbor Rd",
              line2: null,
              city: "Portland",
              state: "OR",
              postalCode: "97201",
              country: "US",
            },
          ],
        });
      if (path === "/api/v1/admissions/{id}/compliance-windows")
        return ok({ items: [], nextCursor: null });
      return ok({ items: [], nextCursor: null });
    }),
    POST: vi.fn(async () => ok({ id: admissionId, state: "pending", version: 5 })),
    PATCH: vi.fn(async () => ok({ id: admissionId, state: "pending", version: 5 })),
  } as unknown as ApiClient;
}

function renderWithShell(
  client: ApiClient,
  as: Session = session,
  initialUpload?: InitialEvidenceUpload,
): void {
  render(
    <MemoryRouter initialEntries={[`/admissions/${admissionId}`]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={as}>
          <Routes>
            <Route
              path="/admissions/:id"
              element={<AdmissionDetail {...(initialUpload ? { initialUpload } : {})} />}
            />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Admission intake workspace", () => {
  it("renders pending readiness from the server and keeps activation disabled", async () => {
    const client = clientFor();
    renderWithShell(client);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );
    expect(screen.getByText("4 of 7 items complete")).toBeTruthy();
    expect(
      screen.getAllByText("Notice of Rights acknowledgment is required.").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Election Statement must be signed.").length).toBeGreaterThan(0);
    // The admission is still "pending" (not yet active) — `HopeEntry` gates HOPE assessment access
    // behind activation (`active={admission.state === "active"}`), so it shows this message rather
    // than the "HOPE Admission Assessment" mini-widget + "Open HOPE" button, which only render once
    // the admission is active.
    expect(
      screen.getAllByText("Activate this admission before accessing or creating HOPE assessments.")
        .length,
    ).toBeGreaterThan(0);
    const patientLinks = screen.getAllByRole("link", { name: "Elena Rivera" });
    expect(patientLinks.length).toBeGreaterThan(0);
    expect(patientLinks[0]?.getAttribute("href")).toBe("/patients/patient-1");
    // "1 overdue or missed" / "Due soon" are `HopeMini` status pills, rendered only in the active-admission
    // branch of `HopeEntry` — not reachable here since the admission under test is still "pending".
    expect(
      (screen.getByRole("button", { name: "Activate Admission" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/admissions/{id}/readiness",
      expect.objectContaining({ params: { path: { id: admissionId } } }),
    );
  });

  it("surfaces guided actions for admission details, election, and CTI blockers", async () => {
    const client = clientFor(
      readiness({
        completed: 3,
        blockingRemaining: 3,
        requirements: [
          {
            code: "admission_details",
            label: "Admission details",
            status: "action_required",
            blocking: true,
            message: "Missing admission date, terminal diagnosis, hospice medical director.",
            action: "COMPLETE_ADMISSION_DETAILS",
          },
          {
            code: "election_statement",
            label: "Election Statement",
            status: "action_required",
            blocking: true,
            message: "Election Statement is required.",
            action: "COMPLETE_ELECTION",
          },
          {
            code: "cti",
            label: "Certification of Terminal Illness",
            status: "action_required",
            blocking: true,
            message: "Certification of Terminal Illness is required.",
            action: "REVIEW_CTI",
          },
        ],
      }),
    );
    renderWithShell(client);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );

    expect(
      screen.getAllByRole("button", { name: "Complete admission details" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Complete Election Statement" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Create CTI" }).length).toBeGreaterThan(0);
  });

  it("saves admission details with the persisted provider and hospice physician", async () => {
    const client = clientFor(
      readiness({
        requirements: [
          {
            code: "admission_details",
            label: "Admission details",
            status: "action_required",
            blocking: true,
            message: "Missing admission details.",
            action: "COMPLETE_ADMISSION_DETAILS",
          },
        ],
      }),
    );
    renderWithShell(client);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );

    const detailsButton = screen.getAllByRole("button", {
      name: "Complete admission details",
    })[0];
    expect(detailsButton).toBeTruthy();
    fireEvent.click(detailsButton!);
    expect(screen.getByText("Hospice provider")).toBeTruthy();
    expect(screen.getByText("Service location / residence")).toBeTruthy();
    expect(screen.getAllByText("12 Harbor Rd").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Save admission details" }));

    await waitFor(() =>
      expect(client.PATCH).toHaveBeenCalledWith(
        "/api/v1/admissions/{id}",
        expect.objectContaining({
          params: { path: { id: admissionId } },
          body: {
            ifVersion: 4,
            admissionAt: "2026-08-28T12:00:00.000Z",
            providerEntityId,
            hospicePhysicianId,
          },
        }),
      ),
    );
  });

  // F-238 — no residence in M5, but DocLens extracted one that is still waiting in intake review.
  function withoutAddress(pending: (path: string) => unknown): ApiClient {
    const base = clientFor(
      readiness({
        requirements: [
          {
            code: "admission_details",
            label: "Admission details",
            status: "action_required",
            blocking: true,
            message: "Missing admission details.",
            action: "COMPLETE_ADMISSION_DETAILS",
          },
        ],
      }),
    );
    const baseGet = base.GET as unknown as (path: string, init?: unknown) => Promise<unknown>;
    return {
      ...base,
      GET: vi.fn(async (path: string, init?: unknown) => {
        if (path === "/api/v1/patients/{id}/addresses") return ok({ addresses: [] });
        if (path === "/api/v1/patients/{patientId}/intake-pending-address") return pending(path);
        return baseGet(path, init);
      }),
    } as unknown as ApiClient;
  }

  async function openDetails(): Promise<void> {
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Complete admission details" })[0]!);
    expect(screen.getByText("No patient residence address on file.")).toBeTruthy();
  }

  it("says a residence address is required to complete details (not optional) and blocks saving without one", async () => {
    const client = withoutAddress(() => ok({ batches: [] }));
    renderWithShell(client);
    await openDetails();

    const required = "A patient residence address is required before completing admission details.";
    const block = screen.getByText("No patient residence address on file.").parentElement!;
    expect(block.textContent).not.toMatch(/optional/i);
    expect(within(block).getByText(new RegExp(required))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save admission details" }));

    // The save gate refuses with the very same sentence the dialog shows, now in the alert too.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(required);
    expect(client.PATCH).not.toHaveBeenCalled();
  });

  // Patient reads fail with `status`; `failing.current` lets a test flip the mock back to success.
  function withPatientFailure(status: number, readinessResponse = readiness()) {
    const base = clientFor(readinessResponse);
    const baseGet = base.GET as unknown as (path: string, init?: unknown) => Promise<unknown>;
    const failing = { current: true };
    const failure = {
      data: undefined,
      error: { code: "X" },
      response: new Response(null, { status }),
    };
    const client = {
      ...base,
      GET: vi.fn(async (path: string, init?: unknown) => {
        if (
          failing.current &&
          (path === "/api/v1/patients/{id}" ||
            path === "/api/v1/patients/{id}/addresses" ||
            path === "/api/v1/patients/{patientId}/election-certification")
        )
          return failure;
        return baseGet(path, init);
      }),
    } as unknown as ApiClient;
    return { client, failing };
  }
  const getCalls = (client: ApiClient, path: string): number =>
    (client.GET as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === path)
      .length;

  it("shows a not-visible state instead of a raw patient id on 404, and Retry recovers in place", async () => {
    const { client, failing } = withPatientFailure(404);
    renderWithShell(client);

    const notice = await screen.findByTestId("patient-unavailable");
    expect(notice.tagName).toBe("SECTION");
    expect(notice.getAttribute("role")).toBeNull();
    expect(within(notice).getByRole("heading").textContent).toMatch(/not visible to you/i);
    expect(document.body.textContent).not.toContain("patient-1");
    expect(
      within(notice).getByRole("link", { name: "Back to referral" }).getAttribute("href"),
    ).toBe("/referrals/referral-1");
    expect(screen.getByText("4 of 7 items complete")).toBeTruthy();

    const loadsBefore = getCalls(client, "/api/v1/admissions/{id}");
    const patientBefore = getCalls(client, "/api/v1/patients/{id}");
    failing.current = false;
    fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByTestId("patient-unavailable")).toBeNull());
    expect(getCalls(client, "/api/v1/patients/{id}")).toBe(patientBefore + 1);
    // The focused Retry button is gone; focus moves to the page heading, not to <body>.
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Admission Intake" }));
    // Patient-only refetch: the admission itself is not reloaded and the page never blanks.
    expect(getCalls(client, "/api/v1/admissions/{id}")).toBe(loadsBefore);
    expect(screen.getAllByRole("link", { name: "Elena Rivera" }).length).toBeGreaterThan(0);
  });

  it("announces the notice Retry politely: still failing keeps the notice and says so", async () => {
    const { client } = withPatientFailure(503);
    renderWithShell(client);
    const notice = await screen.findByTestId("patient-unavailable");
    const status = within(notice).getByTestId("patient-retry-status");
    expect(status.getAttribute("role") ?? status.tagName).toMatch(/status|OUTPUT/i);
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");

    fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(status.textContent).toMatch(/Still couldn.t load/));
    expect(document.activeElement).not.toBe(
      screen.getByRole("heading", { name: "Admission Intake" }),
    );
  });

  it("does not claim 'no access' when the patient read fails with a 503", async () => {
    const { client } = withPatientFailure(503);
    renderWithShell(client);

    const notice = await screen.findByTestId("patient-unavailable");
    expect(notice.textContent).toMatch(/Couldn.t load the patient record\. Try again\./);
    expect(notice.textContent).not.toMatch(/not visible|access/i);
    expect(within(notice).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("503 notice is announced as an alert; the not-visible variant is not", async () => {
    const { client } = withPatientFailure(503);
    renderWithShell(client);
    const notice = await screen.findByTestId("patient-unavailable");
    expect(notice.getAttribute("role")).toBe("alert");
  });

  it("Retry that rejects clears the retrying state, keeps a retryable load_failed notice, and can be retried again", async () => {
    const { client, failing } = withPatientFailure(503);
    const failingGet = client.GET as unknown as (p: string, i?: unknown) => Promise<unknown>;
    const rejecting = { current: false };
    const wrapped = {
      ...client,
      GET: vi.fn(async (path: string, init?: unknown) => {
        if (rejecting.current && path === "/api/v1/patients/{id}") throw new Error("network down");
        return failingGet(path, init);
      }),
    } as unknown as ApiClient;
    renderWithShell(wrapped);
    const notice = await screen.findByTestId("patient-unavailable");

    rejecting.current = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
      await waitFor(() =>
        expect(
          within(notice).getByRole("button", { name: "Retry" }).getAttribute("aria-disabled"),
        ).toBe("false"),
      );
      expect(notice.textContent).toMatch(/Couldn.t load the patient record/);
    }

    rejecting.current = false;
    failing.current = false;
    fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("patient-unavailable")).toBeNull());
  });

  it("a Retry that resolves after the admission changed is ignored", async () => {
    const { client } = withPatientFailure(503);
    const baseGet = client.GET as unknown as (p: string, i?: unknown) => Promise<unknown>;
    let release: (v: unknown) => void = () => undefined;
    const hold = { current: false };
    const wrapped = {
      ...client,
      GET: vi.fn(async (path: string, init?: unknown) => {
        if (hold.current && path === "/api/v1/patients/{id}") {
          hold.current = false;
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return baseGet(path, init);
      }),
    } as unknown as ApiClient;
    function GoNext() {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() => navigate("/admissions/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")}
        >
          next admission
        </button>
      );
    }
    render(
      <MemoryRouter initialEntries={[`/admissions/${admissionId}`]}>
        <ApiClientProvider client={wrapped}>
          <SessionProvider session={session}>
            <GoNext />
            <Routes>
              <Route path="/admissions/:id" element={<AdmissionDetail />} />
            </Routes>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const notice = await screen.findByTestId("patient-unavailable");
    hold.current = true;
    fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "next admission" }));
    await waitFor(() => expect(getCalls(wrapped, "/api/v1/admissions/{id}")).toBe(2));
    // The stale retry now resolves with a readable patient; the new admission's own (failed) load wins.
    release({
      data: {
        id: "patient-1",
        organizationId: "org-1",
        lastName: "Stale",
        firstName: "Row",
        status: "active",
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("patient-unavailable")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Stale");
    expect(
      within(screen.getByTestId("patient-unavailable"))
        .getByRole("button", { name: "Retry" })
        .getAttribute("aria-disabled"),
    ).toBe("false");
  });

  it("a failed address read shows a retryable error and never claims 'no residence on file'", async () => {
    const base = clientFor(
      readiness({
        requirements: [
          {
            code: "admission_details",
            label: "Admission details",
            status: "action_required",
            blocking: true,
            message: "Missing admission details.",
            action: "COMPLETE_ADMISSION_DETAILS",
          },
        ],
      }),
    );
    const baseGet = base.GET as unknown as (p: string, i?: unknown) => Promise<unknown>;
    const addressFails = { current: true };
    const client = {
      ...base,
      GET: vi.fn(async (path: string, init?: unknown) =>
        addressFails.current && path === "/api/v1/patients/{id}/addresses"
          ? { data: undefined, error: { code: "X" }, response: new Response(null, { status: 503 }) }
          : baseGet(path, init),
      ),
    } as unknown as ApiClient;
    renderWithShell(client);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Complete admission details" }))[0]!,
    );

    expect(screen.queryByText("No patient residence address on file.")).toBeNull();
    expect(screen.getByText(/addresses could not be loaded/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save admission details" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/addresses could not be loaded/i);
    expect(alert.textContent).not.toMatch(/is required before completing/i);

    addressFails.current = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading addresses" }));
    await screen.findByText("Patient residence");
    // The address retry runs inside the modal: focus is not yanked out to the page heading.
    expect(document.activeElement).not.toBe(
      screen.getByRole("heading", { name: "Admission Intake" }),
    );
  });

  it("does not strand the user on an unfixable address error when the patient is not visible", async () => {
    const { client } = withPatientFailure(
      404,
      readiness({
        requirements: [
          {
            code: "admission_details",
            label: "Admission details",
            status: "action_required",
            blocking: true,
            message: "Missing admission details.",
            action: "COMPLETE_ADMISSION_DETAILS",
          },
        ],
      }),
    );
    renderWithShell(client);
    await screen.findByTestId("patient-unavailable");
    fireEvent.click(screen.getAllByRole("button", { name: "Complete admission details" })[0]!);

    expect(screen.queryByRole("link", { name: "Open patient addresses" })).toBeNull();
    const block = screen.getByText("Patient record unavailable.").parentElement!;
    expect(block.textContent).toMatch(/must be visible to you/i);

    fireEvent.click(screen.getByRole("button", { name: "Save admission details" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/must be visible to you to add a residence address/i);
    expect(client.PATCH).not.toHaveBeenCalled();
  });

  it("points at the intake reviews holding an extracted address, one link per batch (never the value)", async () => {
    const client = withoutAddress(() =>
      ok({
        items: [
          {
            batchId: "66f5013a-0000-4000-8000-000000000001",
            batchStatus: "extraction_complete",
            uploadedAt: "2026-10-03T10:00:00.000Z",
            reviewStatus: "not_started",
            pendingCount: 5,
            approvedCount: 0,
          },
          {
            batchId: "825f4bb6-0000-4000-8000-000000000002",
            batchStatus: "in_review",
            uploadedAt: "2026-10-01T10:00:00.000Z",
            reviewStatus: "in_progress",
            pendingCount: 0,
            approvedCount: 4,
          },
        ],
        totalBatches: 2,
      }),
    );
    renderWithShell(client);
    await openDetails();

    const hint = await screen.findByTestId("intake-pending-address");
    expect(hint.textContent).toContain(
      "An address was found in intake records that haven't been reviewed yet.",
    );
    const review = screen.getByRole("link", { name: /Review intake records/ });
    expect(review.getAttribute("href")).toBe("/intake/66f5013a-0000-4000-8000-000000000001/review");
    const complete = screen.getByRole("link", { name: /Complete the intake review/ });
    expect(complete.getAttribute("href")).toBe(
      "/intake/825f4bb6-0000-4000-8000-000000000002/review",
    );
    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/patients/{patientId}/intake-pending-address",
      expect.objectContaining({ params: { path: { patientId: "patient-1" } } }),
    );
  });

  it("says 'complete the review' when the only address waiting was already approved", async () => {
    const client = withoutAddress(() =>
      ok({
        items: [
          {
            batchId: "825f4bb6-0000-4000-8000-000000000002",
            batchStatus: "in_review",
            uploadedAt: "2026-10-01T10:00:00.000Z",
            reviewStatus: "in_progress",
            pendingCount: 0,
            approvedCount: 2,
          },
        ],
        totalBatches: 1,
      }),
    );
    renderWithShell(client);
    await openDetails();
    const hint = await screen.findByTestId("intake-pending-address");
    expect(hint.textContent).toContain(
      "An address from intake records was approved — complete the review to add it to the patient.",
    );
  });

  it("shows nothing extra when the caller cannot see intake (403)", async () => {
    const client = withoutAddress(() => ({
      data: undefined,
      error: { error: { code: "FORBIDDEN" } },
      response: new Response(null, { status: 403 }),
    }));
    renderWithShell(client);
    await openDetails();
    await waitFor(() =>
      expect(client.GET).toHaveBeenCalledWith(
        "/api/v1/patients/{patientId}/intake-pending-address",
        expect.anything(),
      ),
    );
    expect(screen.queryByTestId("intake-pending-address")).toBeNull();
    expect(screen.getByRole("link", { name: "Open patient addresses" })).toBeTruthy();
  });
});

describe("Patient privacy review (REVIEW_PRIVACY)", () => {
  const flaggedBatch = "66f5013a-0aa1-4ed4-8ed9-7c787c60e1f1";

  function privacyBlocked(reasonCode: string, message: string): ReadinessFixture {
    return readiness({
      status: "blocked",
      completed: 1,
      blockingRemaining: 1,
      requirements: [
        { code: "patient_identity", label: "Patient identity", status: "complete", blocking: true },
        {
          code: "patient_privacy",
          label: "Patient privacy",
          status: "blocked",
          blocking: true,
          message,
          action: "REVIEW_PRIVACY",
          reasonCode,
        },
      ],
    });
  }

  function withIntake(base: ApiClient, uploads: (view: string) => unknown): ApiClient {
    const baseGet = base.GET as unknown as (path: string, init?: unknown) => Promise<unknown>;
    return {
      ...base,
      GET: vi.fn(async (path: string, init?: unknown) =>
        path === "/api/v1/intake/uploads"
          ? uploads((init as { params: { query: { view: string } } }).params.query.view)
          : baseGet(path, init),
      ),
    } as unknown as ApiClient;
  }

  async function openPrivacy(): Promise<void> {
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );
    const buttons = screen.getAllByRole("button", { name: "Review privacy" });
    // Both the "Next step" banner and the Overview card offer it, and both open the dialog.
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[0]!);
    await screen.findByRole("heading", { name: "Review patient privacy" });
  }

  const ADVISORY =
    "An intake document is flagged for possibly specially protected records and hasn't been reviewed yet. This doesn't block admission; the records stay restricted until reviewed.";

  /** F-238 — the server's shape for an unreviewed intake detection: non-blocking, still actionable. */
  function privacyAdvisory(): ReadinessFixture {
    return readiness({
      status: "ready",
      canActivate: true,
      completed: 1,
      blockingRemaining: 0,
      requirements: [
        { code: "patient_identity", label: "Patient identity", status: "complete", blocking: true },
        {
          code: "patient_privacy",
          label: "Patient privacy",
          status: "action_required",
          blocking: false,
          message: ADVISORY,
          action: "REVIEW_PRIVACY",
          reasonCode: "INTAKE_DETECTION_UNREVIEWED",
        },
      ],
    });
  }

  const batch = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id,
    createdAt,
    status: "extraction_complete",
    sourceChannel: "fax",
    sudStatus: "detected",
    pageCount: 21,
    documentCount: 1,
    ...extra,
  });

  it("shows an unreviewed intake detection as advisory — activation stays enabled", async () => {
    renderWithShell(clientFor(privacyAdvisory()));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );
    const activate = screen.getByRole("button", { name: "Activate Admission" });
    expect((activate as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Admission cannot be activated")).toBeNull();
    expect(screen.getByText("Ready for Admission")).toBeTruthy();
    const advisory = screen.getByTestId("advisory-patient_privacy");
    expect(advisory.textContent).toContain(ADVISORY);
    expect(screen.getAllByText("Review advised").length).toBeGreaterThan(0);
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/\bsud\b|substance|part 2/);
  });

  it("links each flagged, non-discarded batch distinctly (channel, date AND time, size)", async () => {
    const client = withIntake(clientFor(privacyAdvisory()), () =>
      ok({
        items: [
          batch(flaggedBatch, "2026-10-04T09:38:00.000Z", { documentCount: 3 }),
          batch("77f5013a-0aa1-4ed4-8ed9-7c787c60e1f2", "2026-10-04T11:05:00.000Z", {
            pageCount: 1,
            sourceChannel: "email_ingest",
          }),
          batch("88f5013a-0aa1-4ed4-8ed9-7c787c60e1f3", "2026-10-04T12:00:00.000Z", {
            status: "discarded",
          }),
        ],
        nextCursor: null,
        hasMore: false,
      }),
    );
    renderWithShell(client, {
      ...session,
      permissions: ["admission.read", "intake.read", "intake.review"],
    });
    await openPrivacy();
    expect(screen.getByRole("dialog").textContent).toContain("This doesn't block admission.");

    const links = await screen.findAllByRole("link", { name: /Resolve the flag in intake review/ });
    // The discarded batch's detection was withdrawn — it is never offered.
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      `/intake/${flaggedBatch}/review`,
      "/intake/77f5013a-0aa1-4ed4-8ed9-7c787c60e1f2/review",
    ]);
    const labels = links.map((l) => l.textContent ?? "");
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toMatch(
      /^Resolve the flag in intake review — fax received Oct 4, 2026, \d{1,2}:38 (AM|PM) · 3 documents · 21 pages$/,
    );
    expect(labels[1]).toMatch(/email received Oct 4, 2026, \d{1,2}:05 (AM|PM) · 1 page$/);
    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/intake/uploads",
      expect.objectContaining({
        params: { query: { view: "open", patientId: "patient-1", sudStatus: "detected" } },
      }),
    );
    expect(client.GET).not.toHaveBeenCalledWith(
      "/api/v1/intake/uploads",
      expect.objectContaining({
        params: expect.objectContaining({ query: expect.objectContaining({ view: "done" }) }),
      }),
    );
  });

  it("says who to ask when the caller cannot open intake review (403)", async () => {
    const client = withIntake(clientFor(privacyAdvisory()), () => ({
      data: undefined,
      error: { error: { code: "FORBIDDEN" } },
      response: new Response(null, { status: 403 }),
    }));
    renderWithShell(client);
    await openPrivacy();
    expect(await screen.findByTestId("privacy-intake-unavailable")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /intake review/ })).toBeNull();
  });

  it("sends a confirmed restriction to the patient's consent capture", async () => {
    const client = clientFor(
      privacyBlocked(
        "CONSENT_REQUIRED",
        "A confidentiality restriction requires a patient consent on file.",
      ),
    );
    renderWithShell(client, {
      ...session,
      permissions: ["admission.read", "consent.read", "consent.author"],
    });
    await openPrivacy();
    expect(screen.getByRole("link", { name: "Record patient consent" }).getAttribute("href")).toBe(
      "/patients/patient-1/consents/new",
    );
    expect(
      screen.getByRole("link", { name: "View the patient's consents" }).getAttribute("href"),
    ).toBe("/patients/patient-1/consents");
  });

  it("re-checks readiness from the dialog", async () => {
    const client = clientFor(
      privacyBlocked("PRIVACY_CLEARANCE_UNAVAILABLE", "Privacy clearance could not be checked."),
    );
    renderWithShell(client);
    await openPrivacy();
    const before = (client.GET as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([p]) => p === "/api/v1/admissions/{id}/readiness",
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(
        (client.GET as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([p]) => p === "/api/v1/admissions/{id}/readiness",
        ).length,
      ).toBeGreaterThan(before),
    );
  });

  it("never renders a requirement action this screen can't perform as a live button", async () => {
    const client = clientFor(
      readiness({
        requirements: [
          {
            code: "f2f",
            label: "Face-to-Face",
            status: "action_required",
            blocking: true,
            message: "Face-to-face encounter is required.",
            action: "REVIEW_F2F",
          },
        ],
      }),
    );
    renderWithShell(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );
    const buttons = screen.getAllByRole("button", { name: /review f2f/i });
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Evidence upload ceremonies (NOR / Election / CTI) in the right-hand drawer", () => {
  it("opens in place of the readiness rail and refuses to submit without a file", async () => {
    const client = clientFor();
    renderWithShell(client, session, "nor-upload");
    const aside = await screen.findByRole("complementary", { name: "Upload Notice of Rights" });
    fireEvent.click(within(aside).getByRole("button", { name: "Attach document" }));
    expect(await within(aside).findByText("Choose a document to upload.")).toBeTruthy();
    expect(client.POST).not.toHaveBeenCalled();
    fireEvent.click(within(aside).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Upload Notice of Rights" })).toBeNull(),
    );
  });

  it("a signed Election Statement upload still requires the signer name and date", async () => {
    const client = clientFor();
    renderWithShell(client, session, "election-sign-upload");
    const aside = await screen.findByRole("complementary", {
      name: "Upload signed Election Statement",
    });
    fireEvent.change(within(aside).getByLabelText(/^Document/), {
      target: { files: [new File(["%PDF"], "es.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(within(aside).getByRole("button", { name: "Attach document" }));
    expect(
      await within(aside).findByText(/Signer name, signer role, and signature date are required/),
    ).toBeTruthy();
    expect(client.POST).not.toHaveBeenCalled();
  });
});

// An elected provider entity with several active locations makes the server refuse activation
// (422 M6_LOCATION_REQUIRED) unless the request names one — so the dialog has to offer the choice.
describe("Admission activation — service location", () => {
  const mainOffice = "55555555-0000-4000-8000-000000000001";
  const unsited = (base: ApiClient): ApiClient => {
    const get = base.GET as unknown as (path: string, init?: unknown) => Promise<unknown>;
    return {
      ...base,
      GET: vi.fn(async (path: string, init?: unknown) => {
        if (path === "/api/v1/admissions/{id}") {
          const res = (await get(path, init)) as { data: Record<string, unknown> };
          return ok({ ...res.data, locationId: null });
        }
        if (path === "/api/v1/locations")
          return ok({
            items: [
              {
                id: mainOffice,
                providerEntityId,
                name: "Main Office",
                addressLine1: "100 Hospice Way",
                city: "Asheville",
                state: "NC",
                postalCode: "28801",
                status: "active",
              },
            ],
          });
        return get(path, init);
      }),
    } as unknown as ApiClient;
  };

  it("sends the chosen service location with the activation request", async () => {
    const client = unsited(clientFor(readiness({ canActivate: true, blockingRemaining: 0 })));
    renderWithShell(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Activate Admission" })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.focus(within(dialog).getByRole("combobox", { name: /service location/i }));
    fireEvent.click(await within(dialog).findByRole("option", { name: /Main Office/ }));
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/admissions/{id}/activate",
        expect.objectContaining({ body: { ifVersion: 4, locationId: mainOffice } }),
      ),
    );
  });

  it("shows the server's location refusal in the open dialog and omits locationId when none is picked", async () => {
    const client = unsited(clientFor(readiness({ canActivate: true, blockingRemaining: 0 })));
    (client.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: undefined,
      error: { error: { code: "M6_LOCATION_REQUIRED" } },
      response: new Response(null, { status: 422 }),
    });
    renderWithShell(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Activate Admission" })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Activate" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "Choose the service location this admission is served from.",
    );
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/admissions/{id}/activate",
      expect.objectContaining({ body: { ifVersion: 4 } }),
    );
  });

  it("forgets a picked location when the dialog is cancelled and reopened", async () => {
    const client = unsited(clientFor(readiness({ canActivate: true, blockingRemaining: 0 })));
    renderWithShell(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Activate Admission" })[0]!);
    let dialog = await screen.findByRole("dialog");
    fireEvent.focus(within(dialog).getByRole("combobox", { name: /service location/i }));
    fireEvent.click(await within(dialog).findByRole("option", { name: /Main Office/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Activate Admission" })[0]!);
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/admissions/{id}/activate",
        expect.objectContaining({ body: { ifVersion: 4 } }),
      ),
    );
  });

  it("offers no location choice when the admission is already sited", async () => {
    renderWithShell(clientFor(readiness({ canActivate: true, blockingRemaining: 0 })));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Activate Admission" })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
  });
});
