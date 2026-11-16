// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeTimepointCapture } from "../hope-capture-workspace";
import { SESSION } from "./workspace-test-kit";

// Group g1: the capture form opens with the target date set to the current time, as the record dialog does, and says so beside the field
// until the clinician has entered a date: a visit that took place earlier is not filed as "now" by a default nobody mentioned.

afterEach(cleanup);

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEFAULTED = /Set to the current time/;

const timepoint = (kind: string, status: string) => ({
  kind,
  status,
  windowStart: "2026-09-02T00:00:00.000Z",
  windowEnd: "2026-09-11T23:59:59.999Z",
  lateDeadline: "2026-09-18T23:59:59.999Z",
  assessmentId: null,
});
const WORKFLOW = {
  admissionId,
  patientId: "patient-1",
  admissionStatus: "active",
  admissionAt: "2026-08-27T00:00:00.000Z",
  admissionAssessment: timepoint("01_admission", "completed"),
  huv1: timepoint("02_huv1", "open"),
  huv2: timepoint("03_huv2", "upcoming"),
  sfvs: [],
  dischargeAssessment: timepoint("05_discharge", "not_applicable"),
};
const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(POST: ReturnType<typeof vi.fn>) {
  const GET = vi.fn(async (path: string) =>
    path.includes("/hope")
      ? ok(WORKFLOW)
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
            <Route path="/hope/assessments/:id" element={<p>opened the draft</p>} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
}
const field = async () => (await screen.findByLabelText("Target date/time")) as HTMLInputElement;

describe("the capture form's target date", () => {
  it("says it is set to the current time, beside the field, until the clinician enters a date", async () => {
    mount(vi.fn());
    const input = await field();
    const hint = screen.getByText(DEFAULTED);
    expect(hint).toBeTruthy();
    // The hint is read with the field by a screen reader, not only seen beside it.
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);

    fireEvent.change(input, { target: { value: "2026-01-05T09:30" } });

    expect(screen.queryByText(DEFAULTED)).toBeNull();
    expect(input.getAttribute("aria-describedby") ?? "").not.toContain(hint.id);
  });

  it("sends the value shown, and a date the clinician entered", async () => {
    const POST = vi.fn(async () => ok({ id: "created-1" }));
    mount(POST);
    const input = await field();
    fireEvent.change(input, { target: { value: "2026-01-05T09:30" } });
    fireEvent.click(await screen.findByRole("button", { name: /Create HOPE draft/ }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    const sent = (POST.mock.calls[0] as unknown as [string, { body: { targetDate: string } }])[1]
      .body;
    expect(sent.targetDate).toBe(new Date("2026-01-05T09:30").toISOString());
  });
});
