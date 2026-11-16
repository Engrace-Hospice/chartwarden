// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeTimepointCapture } from "../hope-capture-workspace";
import { SESSION } from "./workspace-test-kit";

// Group g1: the capture form. The window it read at load can be out of date by the time it is submitted: a refusal about the
// window must re-read it (so the page offers what the server now asks for), and a refusal of any kind takes keyboard focus.

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function workflow(status: string) {
  const timepoint = (kind: string, st: string) => ({
    kind,
    status: st,
    windowStart: "2026-09-02T00:00:00.000Z",
    windowEnd: "2026-09-11T23:59:59.999Z",
    lateDeadline: "2026-09-18T23:59:59.999Z",
    assessmentId: null,
  });
  return {
    admissionId,
    patientId: "patient-1",
    admissionStatus: "active",
    admissionAt: "2026-08-27T00:00:00.000Z",
    admissionAssessment: timepoint("01_admission", "completed"),
    huv1: timepoint("02_huv1", status),
    huv2: timepoint("03_huv2", "upcoming"),
    sfvs: [],
    dischargeAssessment: timepoint("05_discharge", "not_applicable"),
  };
}
const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const refusal = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: "refused" } },
  response: new Response(null, { status }),
});

/** `statuses[n]` is what the nth read of the workflow says huv1 is (the last one repeats). */
function mount(statuses: string[], POST: ReturnType<typeof vi.fn>) {
  let reads = 0;
  const GET = vi.fn(async (path: string) =>
    path.includes("/hope")
      ? ok(workflow(statuses[Math.min(reads++, statuses.length - 1)] ?? "open"))
      : ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" }),
  );
  const client = { GET, POST } as unknown as ApiClient;
  render(
    <SessionProvider session={SESSION}>
      <MemoryRouter initialEntries={[`/admissions/${admissionId}/hope/timepoints/02_huv1`]}>
        <ApiClientProvider client={client}>
          <Routes>
            <Route
              path="/admissions/:admissionId/hope/timepoints/:kind"
              element={<HopeTimepointCapture />}
            />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
  return GET;
}
/** How many times the workflow itself was read (the patient's name is read besides it). */
const workflowReads = (GET: ReturnType<typeof vi.fn>) =>
  GET.mock.calls.filter(([path]) => String(path).includes("/hope")).length;
const create = () => screen.getByRole("button", { name: /Create HOPE draft/ }) as HTMLButtonElement;
const ready = () => screen.findByRole("heading", { name: "HUV1 Assessment" });
/** A late item asks for its reason before Create can send (the form's own required input, as in the record dialog). */
const chooseLateReason = () =>
  fireEvent.change(screen.getByLabelText("Late completion reason"), {
    target: { value: "hospitalization" },
  });

describe("a refusal about a window that moved on since the page loaded", () => {
  it("shows that the period has ended, not an override instruction the page cannot follow, for an expired window", async () => {
    mount(
      ["late", "expired"],
      vi.fn(async () => refusal(409, "M10_TIMEPOINT_EXPIRED")),
    );
    await ready();
    chooseLateReason();
    fireEvent.click(create());
    expect(await screen.findByText("The allowed capture period has expired.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create HOPE draft/ })).toBeNull();
    expect(screen.queryByText(/authorized override is required/)).toBeNull();
  });

  it("re-reads the window for a timepoint the server says is not open yet", async () => {
    const GET = mount(
      ["open", "upcoming"],
      vi.fn(async () => refusal(409, "M10_TIMEPOINT_NOT_OPEN")),
    );
    await ready();
    fireEvent.click(create());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Create HOPE draft/ })).toBeNull(),
    );
    expect((await screen.findAllByText(/opens /)).length).toBeGreaterThan(0);
    expect(workflowReads(GET)).toBe(2);
  });

  it("holds Create shut for a late item until its reason is chosen, and sends nothing before that", async () => {
    const POST = vi.fn(async () => refusal(400, "M10_LATE_REASON_REQUIRED"));
    const GET = mount(["late"], POST);
    await ready();
    expect(create().disabled).toBe(true);
    fireEvent.click(create());
    expect(POST).not.toHaveBeenCalled();
    chooseLateReason();
    expect(create().disabled).toBe(false);
    expect(workflowReads(GET)).toBe(1);
  });

  it("frees the form again after the re-read, so the clinician can go on", async () => {
    mount(
      ["open", "late"],
      vi.fn(async () => refusal(400, "M10_LATE_REASON_REQUIRED")),
    );
    await ready();
    fireEvent.click(create());
    await screen.findByLabelText("Late completion reason");
    // Create now waits for the reason the re-read just asked for; once it is chosen, the form is free to send.
    chooseLateReason();
    await waitFor(() => expect(create().disabled).toBe(false));
  });
});

describe("a refused or unconfirmed capture", () => {
  it.each([
    ["a rejected request", () => Promise.reject(new TypeError("offline")), /Could not confirm/],
    ["a refusal", async () => refusal(409, "M10_VERSION_CONFLICT"), /changed since it was loaded/],
  ])("takes focus for %s, so the keyboard user keeps their place", async (_name, answer, text) => {
    mount(["open"], vi.fn(answer));
    await ready();
    fireEvent.click(create());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(text);
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});
