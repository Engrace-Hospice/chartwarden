// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeTimepointCapture } from "../hope-capture-workspace";
import { SESSION } from "./workspace-test-kit";

// Group g1 (web-k18): the capture form's words for a create nobody confirmed say to check the record, and the page offers "Create HOPE
// draft" until it has been told a draft exists. So the workflow is read again after a rejected request, a timeout, an empty 5xx or a
// fault of the server's own (a create that landed then shows "Continue draft"), and never after a refusal or a busy record.

afterEach(cleanup);

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WINDOW = {
  windowStart: "2026-09-02T00:00:00.000Z",
  windowEnd: "2026-09-11T23:59:59.999Z",
  lateDeadline: "2026-09-18T23:59:59.999Z",
};
function workflow(huv1AssessmentId: string | null) {
  const timepoint = (kind: string, status: string, assessmentId: string | null = null) => ({
    kind,
    status,
    ...WINDOW,
    assessmentId,
  });
  return {
    admissionId,
    patientId: "patient-1",
    admissionStatus: "active",
    admissionAt: "2026-08-27T00:00:00.000Z",
    admissionAssessment: timepoint("01_admission", "completed"),
    huv1: timepoint("02_huv1", "open", huv1AssessmentId),
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
const empty = (status: number): Reply => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status }),
});

/** The first read of the workflow has no draft; the ones after it (when `created`) show the draft that a lost create made. */
function mount(post: ReturnType<typeof vi.fn>, created = false) {
  let reads = 0;
  const GET = vi.fn(async (path: string) => {
    if (!path.includes("/hope"))
      return ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" });
    reads += 1;
    return ok(workflow(created && reads > 1 ? "hope-9" : null));
  });
  const view = render(
    <SessionProvider session={SESSION}>
      <MemoryRouter initialEntries={[`/admissions/${admissionId}/hope/timepoints/02_huv1`]}>
        <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
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
  return { GET, view };
}
const workflowReads = (GET: ReturnType<typeof vi.fn>) =>
  GET.mock.calls.filter(([path]) => String(path).includes("/hope")).length;
const create = () => screen.getByRole("button", { name: /Create HOPE draft/ }) as HTMLButtonElement;
const ready = () => screen.findByRole("heading", { name: "HUV1 Assessment" });

describe("a create whose outcome is not known", () => {
  it.each([
    ["is rejected", () => Promise.reject(new TypeError("Failed to fetch")), "Could not confirm"],
    ["answers 502 with no body", async () => empty(502), "could not be confirmed"],
    [
      "answers 500 with the server's own fault",
      async () => refusal(500, "INTERNAL"),
      "could not be confirmed",
    ],
  ])(
    "reads the workflow again when the request %s, and the page then offers the draft it made",
    async (_n, answer, words) => {
      const { GET } = mount(vi.fn(answer), true);
      await ready();

      fireEvent.click(create());

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(words);
      // The draft the lost create made is there to continue, instead of a Create that would send a second request.
      fireEvent.click(await screen.findByRole("button", { name: "Continue draft" }));
      expect(workflowReads(GET)).toBe(2);
    },
  );

  it("keeps Create (and the words) when the re-read finds no draft", async () => {
    const { GET } = mount(
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
      false,
    );
    await ready();

    fireEvent.click(create());

    await waitFor(() => expect(workflowReads(GET)).toBe(2));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not confirm");
    await waitFor(() => expect(create().disabled).toBe(false));
  });
});

describe("a create whose outcome is known", () => {
  it.each([
    ["a 422 refusal", refusal(422, "VALIDATION_FAILED")],
    ["a 403 refusal", refusal(403, "FORBIDDEN")],
    ["a 409 M10_RECORD_BUSY (the step was not applied)", refusal(409, "M10_RECORD_BUSY")],
    ["a 4xx with no body", empty(403)],
  ])("does not read the workflow again after %s", async (_name, answer) => {
    const { GET } = mount(
      vi.fn(async () => answer),
      true,
    );
    await ready();

    fireEvent.click(create());

    await screen.findByRole("alert");
    await waitFor(() => expect(create().disabled).toBe(false));
    expect(workflowReads(GET)).toBe(1);
  });
});

describe("a create answered after the clinician has left the page", () => {
  it("does not read the workflow again", async () => {
    let fail: (reason: unknown) => void = () => undefined;
    const post = vi.fn(
      () =>
        new Promise<Reply>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { GET, view } = mount(post, true);
    await ready();
    fireEvent.click(create());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    view.unmount();
    fail(new TypeError("Failed to fetch"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(workflowReads(GET)).toBe(1);
  });
});
