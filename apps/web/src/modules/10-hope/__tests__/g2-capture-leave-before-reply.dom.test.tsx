// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeTimepointCapture } from "../hope-capture-workspace";
import { SESSION } from "./workspace-test-kit";

// Group g2: the capture form's write answers after the clinician has left the page. Of everything the reply could do, only the
// navigation to the new draft is observable once the screen is gone (a state update on an unmounted component is a no-op), so
// that is what the guard is for and what this holds: the clinician who moved on is not pulled to the draft the reply created.
// The request is held, the screen is left, the reply is released, and the location is asserted (mutation-checked: without the
// guard the location becomes the draft's).

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WINDOW = {
  windowStart: "2026-09-02T00:00:00.000Z",
  windowEnd: "2026-09-11T23:59:59.999Z",
  lateDeadline: "2026-09-18T23:59:59.999Z",
};
const timepoint = (kind: string, status: string) => ({
  kind,
  status,
  ...WINDOW,
  assessmentId: null,
});
const workflow = {
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

function Where() {
  return <output aria-label="location">{useLocation().pathname}</output>;
}

describe("a capture whose reply arrives after the clinician has left", () => {
  it("does not pull them to the draft it created", async () => {
    let release: (reply: unknown) => void = () => undefined;
    const POST = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const GET = vi.fn(async (path: string) =>
      path.includes("/hope")
        ? ok(workflow)
        : ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" }),
    );
    render(
      <SessionProvider session={SESSION}>
        <MemoryRouter initialEntries={[`/admissions/${admissionId}/hope/timepoints/02_huv1`]}>
          <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
            <Where />
            <Routes>
              <Route
                path="/admissions/:admissionId/hope/timepoints/:kind"
                element={
                  <>
                    <HopeTimepointCapture />
                    <Link to="/elsewhere">Leave</Link>
                  </>
                }
              />
              <Route path="/elsewhere" element={<p>Somewhere else</p>} />
              <Route path="/hope/assessments/:id" element={<p>The new draft</p>} />
            </Routes>
          </ApiClientProvider>
        </MemoryRouter>
      </SessionProvider>,
    );
    await screen.findByRole("heading", { name: "HUV1 Assessment" });
    fireEvent.click(screen.getByRole("button", { name: /Create HOPE draft/ }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("link", { name: "Leave" }));
    expect(await screen.findByText("Somewhere else")).toBeTruthy();
    await act(async () => {
      release({
        data: { id: "draft-1" },
        error: undefined,
        response: new Response(null, { status: 201 }),
      });
    });

    expect(screen.getByLabelText("location").textContent).toBe("/elsewhere");
    expect(screen.queryByText("The new draft")).toBeNull();
  });
});
