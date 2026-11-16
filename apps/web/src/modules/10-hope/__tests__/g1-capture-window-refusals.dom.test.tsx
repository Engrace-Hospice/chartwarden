// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeTimepointCapture } from "../hope-capture-workspace";
import { SESSION } from "./workspace-test-kit";

// Group g1: a window refusal on the capture form. The clinician's own typed target date is the usual cause (the server judges
// "before the window opens" on the typed date itself, and everything else at the later of it and now), so a refusal that
// the re-read does not explain is worded as the date's, not as "the window changed". The re-read is quiet: the form (and the
// typed date) stay, and the explanation sits in a region that outlives the form, where focus goes.

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MOVED = "The window for this assessment changed while you were on this page.";

type Window = { windowStart: string; windowEnd: string; lateDeadline: string };
const BASE_WINDOW: Window = {
  windowStart: "2026-09-02T00:00:00.000Z",
  windowEnd: "2026-09-11T23:59:59.999Z",
  lateDeadline: "2026-09-18T23:59:59.999Z",
};
function workflow(status: string, window: Window = BASE_WINDOW) {
  const timepoint = (kind: string, st: string) => ({
    kind,
    status: st,
    ...window,
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
type Reply = { data?: unknown; error?: unknown; response?: Response };
const ok = (data: unknown): Reply => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const refusal = (status: number, code: string): Reply => ({
  data: undefined,
  error: { error: { code, message: `server words for ${code}` } },
  response: new Response(null, { status }),
});

/** `reads[n]` is what the nth read of the workflow answers (the last one repeats): a reply, or a function to reject. */
function mount(reads: Array<Reply | (() => Promise<Reply>)>, POST: ReturnType<typeof vi.fn>) {
  let n = 0;
  const GET = vi.fn(async (path: string) => {
    if (!path.includes("/hope"))
      return ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" });
    const next = reads[Math.min(n++, reads.length - 1)];
    return typeof next === "function" ? next() : (next as Reply);
  });
  render(
    <SessionProvider session={SESSION}>
      <MemoryRouter initialEntries={[`/admissions/${admissionId}/hope/timepoints/02_huv1`]}>
        <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
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
const workflowReads = (GET: ReturnType<typeof vi.fn>) =>
  GET.mock.calls.filter(([path]) => String(path).includes("/hope")).length;
const create = () => screen.getByRole("button", { name: /Create HOPE draft/ }) as HTMLButtonElement;
const ready = () => screen.findByRole("heading", { name: "HUV1 Assessment" });
const typeDate = (value: string) =>
  fireEvent.change(screen.getByLabelText("Target date/time"), { target: { value } });

describe("a window refusal the re-read does not explain", () => {
  it.each([
    ["M10_TIMEPOINT_NOT_OPEN", 409, "2026-09-01T10:00", /before this assessment's window opens/],
    ["M10_TIMEPOINT_EXPIRED", 409, "2026-09-30T10:00", /after the late deadline/],
    ["M10_LATE_REASON_REQUIRED", 400, "2026-09-15T10:00", /after the normal window closed/],
  ])(
    "words %s as the typed date's, keeps the form and focuses the explanation",
    async (code, status, typed, words) => {
      const GET = mount(
        [ok(workflow("open"))],
        vi.fn(async () => refusal(status, code)),
      );
      await ready();
      const dateInput = screen.getByLabelText("Target date/time");
      typeDate(typed);
      fireEvent.click(create());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(words);
      expect(alert.textContent).not.toContain(MOVED);
      // Quiet re-read: the form was never swapped for the loading region, so the typed date is the same element and value.
      expect(screen.getByLabelText("Target date/time")).toBe(dateInput);
      expect((dateInput as HTMLInputElement).value).toBe(typed);
      expect(workflowReads(GET)).toBe(2);
      await waitFor(() => expect(document.activeElement).toBe(alert));
      await waitFor(() => expect(create().disabled).toBe(false));
    },
  );

  it("still says the window changed when the re-read shows other windows for the same status", async () => {
    mount(
      [
        ok(workflow("open")),
        ok(workflow("open", { ...BASE_WINDOW, windowStart: "2026-09-05T00:00:00.000Z" })),
      ],
      vi.fn(async () => refusal(409, "M10_TIMEPOINT_NOT_OPEN")),
    );
    await ready();
    fireEvent.click(create());
    expect((await screen.findByRole("alert")).textContent).toContain(MOVED);
  });
});

describe("a window that moved on since the page loaded", () => {
  it("keeps the explanation, with focus on it, when the form goes away", async () => {
    mount(
      [ok(workflow("open")), ok(workflow("expired"))],
      vi.fn(async () => refusal(409, "M10_TIMEPOINT_EXPIRED")),
    );
    await ready();
    fireEvent.click(create());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(MOVED);
    expect(screen.getByText("The allowed capture period has expired.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create HOPE draft/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it.each([
    ["a rejected request", () => Promise.reject(new TypeError("offline"))],
    [
      "an empty 502",
      () =>
        Promise.resolve({
          data: undefined,
          error: undefined,
          response: new Response(null, { status: 502 }),
        }),
    ],
  ])(
    "keeps the form and says so, with focus on the message, when the re-read is %s",
    async (_name, answer) => {
      const GET = mount(
        [ok(workflow("open")), answer],
        vi.fn(async () => refusal(409, "M10_TIMEPOINT_EXPIRED")),
      );
      await ready();
      fireEvent.click(create());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/could not re-read the window/);
      // Not the unavailable-workflow view: the form (and what was typed) is still there to correct.
      expect(screen.queryByText("Unable to load HOPE workflow")).toBeNull();
      expect(workflowReads(GET)).toBe(2);
      await waitFor(() => expect(document.activeElement).toBe(alert));
      await waitFor(() => expect(create().disabled).toBe(false));
    },
  );

  // There is deliberately no "clinician left before the re-read answers" test: React 18 emits no warning for a state update on an
  // unmounted component and the update is a no-op, so such a test passes with or without the `mounted` guards in rereadWorkflow
  // and submitTimepoint (checked: with every guard removed from a copy of the component, all of this file still passed). The one
  // guard with an observable effect, no navigation to the draft the write created once the clinician has left, is covered in
  // hope-capture-workspace.dom.test.tsx ("does not pull the clinician to the draft it created ...").
});

describe("the capture workspace read", () => {
  it("is a refusal of access, with no Retry that cannot help, for a 404 (deny-as-not-found)", async () => {
    const GET = mount([refusal(404, "NOT_FOUND")], vi.fn());
    expect(await screen.findByText(/Your access is limited/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(workflowReads(GET)).toBe(1);
  });
});
