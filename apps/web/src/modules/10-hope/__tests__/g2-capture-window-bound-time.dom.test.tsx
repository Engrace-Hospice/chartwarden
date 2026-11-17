// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeTimepointCapture } from "../hope-capture-workspace";
import { SESSION } from "./workspace-test-kit";

// Group g2: a window refusal names the bound it crossed as an INSTANT (date and time, in the clinician's zone), not as a calendar
// day. The bounds are timestamps; "on or after Sep 1" for a window that opens at Sep 1 8:00 PM local sends a clinician who types
// Sep 1 10:00 AM straight into the same refusal.

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WINDOW = {
  windowStart: "2026-09-02T00:00:00.000Z",
  windowEnd: "2026-09-11T23:59:59.999Z",
  lateDeadline: "2026-09-18T23:59:59.999Z",
};
const inZone = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );

const originalZone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (originalZone === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = originalZone;
});

function workflow() {
  const timepoint = (kind: string, status: string) => ({
    kind,
    status,
    ...WINDOW,
    assessmentId: null,
  });
  return {
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
}
const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const refusal = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: `server words for ${code}` } },
  response: new Response(null, { status }),
});

async function refusedWith(status: number, code: string): Promise<string> {
  const GET = vi.fn(async (path: string) =>
    path.includes("/hope")
      ? ok(workflow())
      : ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" }),
  );
  const POST = vi.fn(async () => refusal(status, code));
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
  await screen.findByRole("heading", { name: "HUV1 Assessment" });
  fireEvent.click(screen.getByRole("button", { name: /Create HOPE draft/ }));
  return (await screen.findByRole("alert")).textContent ?? "";
}

describe("a window refusal that names its bound", () => {
  it("gives the zone's wall time, so the viewer can aim for it (2026-09-02T00:00Z is 8:00 PM the day before in New York)", () => {
    expect(inZone(WINDOW.windowStart)).toContain("Sep 1, 2026");
    expect(inZone(WINDOW.windowStart)).toContain("8:00");
  });

  it.each([
    ["M10_TIMEPOINT_NOT_OPEN", 409, WINDOW.windowStart, /at or after it/],
    ["M10_TIMEPOINT_EXPIRED", 409, WINDOW.lateDeadline, /at or before it/],
    ["M10_LATE_REASON_REQUIRED", 400, WINDOW.windowEnd, /inside the window/],
  ])("words %s with the bound's date and time", async (code, status, bound, advice) => {
    const shown = await refusedWith(status, code);

    expect(shown).toContain(inZone(bound));
    expect(shown).toMatch(advice);
    expect(shown).toMatch(/date and time/);
  });
});
