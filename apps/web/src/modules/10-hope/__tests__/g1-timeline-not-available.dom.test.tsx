// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { PatientHopeTimeline } from "../patient-hope-timeline";

// Group g1: hope.scope answers a patient outside the caller's caseload with 404 (deny-as-not-found), so a 404 on the timeline
// read is final: Try again cannot make the patient appear. Any other failure stays retryable.

type Reply = { data?: unknown; error?: unknown; response?: Response };

function renderTimeline(timeline: () => Reply) {
  const GET = vi.fn(async (path: string) => {
    if (path === "/api/v1/patients/{patientId}/hope/assessments") return timeline();
    if (path === "/api/v1/patients/{patientId}/admissions") return { data: { items: [] } };
    return path === "/api/v1/patients/{id}"
      ? {
          data: {
            id: "patient-1",
            mrn: "MRN-1",
            firstName: "Ada",
            lastName: "Lovelace",
            dob: "1948-03-02",
            status: "active",
          },
        }
      : { data: {} };
  });
  render(
    <SessionProvider session={null}>
      <MemoryRouter initialEntries={["/patients/patient-1/hope"]}>
        <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
          <ToastProvider>
            <Routes>
              <Route path="/patients/:patientId/hope" element={<PatientHopeTimeline />} />
            </Routes>
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
  return GET;
}
const timelineReads = (GET: ReturnType<typeof vi.fn>) =>
  GET.mock.calls.filter(([path]) => String(path).endsWith("/hope/assessments")).length;

describe("the patient HOPE timeline read", () => {
  it.each([403, 404])("is final, with no Try again that cannot help, for a %i", async (status) => {
    const GET = renderTimeline(() => ({
      data: undefined,
      error: { error: { code: "NOT_FOUND", message: "Not found" } },
      response: new Response(null, { status }),
    }));
    expect(
      await screen.findByText(/HOPE timeline was not found, or is not available to you/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(timelineReads(GET)).toBe(1);
  });

  it("is still retryable for a 502", async () => {
    renderTimeline(() => ({
      data: undefined,
      error: undefined,
      response: new Response(null, { status: 502 }),
    }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText("Could not load HOPE timeline.")).toBeTruthy();
  });
});
