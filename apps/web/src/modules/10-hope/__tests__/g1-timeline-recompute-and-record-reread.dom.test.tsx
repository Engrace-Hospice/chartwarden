// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { PatientHopeTimeline } from "../patient-hope-timeline";

// Group g1 (web-k16, web-k18): the patient timeline's "Recompute schedules" is a platform-category permission that no role template
// grants, so a session KNOWN to lack it is not offered the control (an unknown one is, and the server decides); and a record dialog
// whose capture nobody confirmed makes the timeline read again, so the page it tells the clinician to check shows what is true.

afterEach(cleanup);

const REGENERATE = "hope.admin.regenerate_schedules";
const TIMELINE = "/api/v1/patients/{patientId}/hope/assessments";
const row = {
  id: "a-1",
  admissionId: "adm-1",
  rfaKind: "01_admission",
  status: "signed",
  targetDate: "2026-09-08T00:00:00.000Z",
  authorDiscipline: "",
  j2051MaxSeverity: null,
  j2051TriggerFired: false,
  wasLate: false,
  supersededByAssessmentId: null,
};
const PATIENT = {
  id: "patient-1",
  mrn: "MRN-patient-1",
  firstName: "Ada",
  lastName: "Lovelace",
  dob: "1948-03-02",
  status: "active",
};
const session = (permissions: string[] | undefined) => ({
  userId: "u",
  organizationId: "o",
  membershipId: "m",
  roles: ["rn"],
  permissions,
  isAdmin: false,
});

function mount(sessionValue: unknown, post: ReturnType<typeof vi.fn> = vi.fn()) {
  const get = vi.fn(async (path: string) => {
    if (path === TIMELINE)
      return {
        data: { assessments: [row] },
        error: undefined,
        response: new Response(null, { status: 200 }),
      };
    if (path === "/api/v1/patients/{patientId}/admissions") return { data: { items: [] } };
    return path === "/api/v1/patients/{id}" ? { data: PATIENT } : { data: {} };
  });
  const client = { GET: get, POST: post } as unknown as ApiClient;
  render(
    <SessionProvider session={sessionValue as ReturnType<typeof session>}>
      <MemoryRouter initialEntries={["/patients/patient-1/hope"]}>
        <ApiClientProvider client={client}>
          <ToastProvider>
            <Routes>
              <Route path="/patients/:patientId/hope" element={<PatientHopeTimeline />} />
            </Routes>
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
  return { get, post, timelineReads: () => get.mock.calls.filter(([p]) => p === TIMELINE).length };
}

describe("Recompute schedules", () => {
  it("is not offered to a session known to lack the permission (Record timepoint still is)", async () => {
    mount(session(["hope.timepoint.write"]));

    await screen.findByRole("button", { name: "Record timepoint" });

    expect(screen.queryByRole("button", { name: "Create missing timepoint windows" })).toBeNull();
  });

  it("is not offered to a session with no permissions at all", async () => {
    mount(session([]));

    await screen.findByRole("button", { name: "Record timepoint" });

    expect(screen.queryByRole("button", { name: "Create missing timepoint windows" })).toBeNull();
  });

  it("is offered to a holder of the permission", async () => {
    mount(session([REGENERATE]));

    expect(
      await screen.findByRole("button", { name: "Create missing timepoint windows" }),
    ).toBeTruthy();
  });

  it("is offered when the session's permissions are unknown (the server decides), and with no session", async () => {
    mount(session(undefined));
    expect(
      await screen.findByRole("button", { name: "Create missing timepoint windows" }),
    ).toBeTruthy();
    cleanup();

    mount(null);
    expect(
      await screen.findByRole("button", { name: "Create missing timepoint windows" }),
    ).toBeTruthy();
  });
});

describe("the Record timepoint dialog on the timeline", () => {
  async function openAndRecord(post: ReturnType<typeof vi.fn>) {
    const view = mount(session([]), post);
    fireEvent.click(await screen.findByRole("button", { name: "Record timepoint" }));
    const dialog = await screen.findByRole("dialog", { name: "Record HOPE timepoint" });
    await waitFor(() => expect(view.timelineReads()).toBe(1));
    fireEvent.click(within(dialog).getByRole("button", { name: "Record draft" }));
    await within(dialog).findByRole("alert");
    return view;
  }

  it("makes the timeline read again after a capture nobody confirmed", async () => {
    const view = await openAndRecord(vi.fn(async () => Promise.reject(new TypeError("offline"))));

    await waitFor(() => expect(view.timelineReads()).toBe(2));
  });

  it("does not read it again after a refusal", async () => {
    const view = await openAndRecord(
      vi.fn(async () => ({
        data: undefined,
        error: { error: { code: "VALIDATION_FAILED", message: "No." } },
        response: new Response(null, { status: 422 }),
      })),
    );

    expect(view.timelineReads()).toBe(1);
  });
});

describe("the schedule dialog on the timeline (web-k4: it re-reads for any outcome that may have changed the page)", () => {
  /** Opens the dialog from its button and presses its submit (found by position, not wording: the labels are the dialog's own). */
  async function openAndSubmit(post: ReturnType<typeof vi.fn>) {
    const view = mount(session([REGENERATE]), post);
    fireEvent.click(
      await screen.findByRole("button", { name: "Create missing timepoint windows" }),
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(view.timelineReads()).toBe(1));
    const submit = within(dialog)
      .getAllByRole("button")
      .find((b) => b.textContent !== "Cancel") as HTMLElement;
    fireEvent.click(submit);
    await within(dialog).findByRole("alert");
    return view;
  }

  it("reads the timeline again after a request nobody answered", async () => {
    const view = await openAndSubmit(vi.fn(async () => Promise.reject(new TypeError("offline"))));

    await waitFor(() => expect(view.timelineReads()).toBe(2));
  });

  it("reads the timeline again after a 409 that says the record changed", async () => {
    const view = await openAndSubmit(
      vi.fn(async () => ({
        data: undefined,
        error: { error: { code: "CONFLICT", message: "Changed." } },
        response: new Response(null, { status: 409 }),
      })),
    );

    await waitFor(() => expect(view.timelineReads()).toBe(2));
  });

  it("does not read it again after a 403 refusal", async () => {
    const view = await openAndSubmit(
      vi.fn(async () => ({
        data: undefined,
        error: { error: { code: "FORBIDDEN", message: "No." } },
        response: new Response(null, { status: 403 }),
      })),
    );

    expect(view.timelineReads()).toBe(1);
  });
});
