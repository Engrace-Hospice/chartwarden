// @vitest-environment jsdom
// Group g1: an INSTANT is shown in the viewer's zone, never as its UTC calendar day; a DATE keeps its day in every zone.
// A US zone BEFORE any Date is built (an org-local day boundary is stored as a UTC instant: for Chicago, Sep 11 23:59:59.999
// local is 2026-09-12T04:59:59.999Z).
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";

import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { formatDate, formatInstant, formatTargetDate } from "../hope-format";
import { PatientHopeTimeline } from "../patient-hope-timeline";
import { SfvWorklist } from "../sfv-worklist";
import {
  assessment,
  clientFor,
  renderWorkspace,
  review,
  useStubbedLocalStorage,
  workspace,
} from "./workspace-test-kit";

afterEach(cleanup);
afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});

const WINDOW_START = "2026-09-02T05:00:00.000Z"; // Sep 2 00:00 Chicago
const WINDOW_END = "2026-09-12T04:59:59.999Z"; // Sep 11 23:59:59.999 Chicago
const EVENING_VISIT = "2026-09-12T01:30:00.000Z"; // Sep 11 20:30 Chicago

describe("the HOPE date helpers", () => {
  it("shows an instant on the viewer's day, not its UTC day", () => {
    expect(formatInstant(WINDOW_END)).toBe("Sep 11, 2026");
    expect(formatInstant(WINDOW_START)).toBe("Sep 2, 2026");
    // The UTC reading these screens used to show.
    expect(formatDate(WINDOW_END)).toBe("Sep 12, 2026");
  });

  it("keeps a date's own day, and an instant's local day, for a target date", () => {
    expect(formatTargetDate("2026-09-08")).toBe("Sep 8, 2026");
    expect(formatTargetDate("2026-09-08T00:00:00.000Z")).toBe("Sep 8, 2026");
    expect(formatTargetDate(EVENING_VISIT)).toBe("Sep 11, 2026");
  });

  it("says nothing was recorded for none, and returns what it cannot read", () => {
    expect(formatInstant(null)).toBe("Not recorded");
    expect(formatTargetDate(undefined)).toBe("Not recorded");
    expect(formatInstant("not a date")).toBe("not a date");
  });
});

describe("the HUV timing banner", () => {
  useStubbedLocalStorage();

  it("words the window by the viewer's days, with the end on the day the org sees", async () => {
    const huv = {
      scheduleId: "sch-1",
      scheduleStatus: "open",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      lateDeadline: null,
      timingState: "within_window",
      z0350: null,
    };
    renderWorkspace(
      clientFor({
        assessment: { ...assessment, rfaKind: "02_huv1" },
        workspace: workspace({
          huv,
          assessment: { ...workspace().assessment, rfaKind: "02_huv1" },
        }),
        review: review({ isc: "HUV" }),
      }),
    );
    expect(
      await screen.findByText(/Recommended completion window Sep 2, 2026 - Sep 11, 2026/),
    ).toBeTruthy();
    expect(screen.queryByText(/Sep 12, 2026/)).toBeNull();
  });
});

describe("the SFV queue's Triggered column", () => {
  it("shows the viewer's own wall time, not the UTC one", async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const row = {
      id: "11111111-aaaa-4aaa-8aaa-111111111111",
      patientId: "22222222-bbbb-4bbb-8bbb-222222222222",
      admissionId: "adm-1",
      triggeringAssessmentId: "33333333-cccc-4ccc-8ccc-333333333333",
      status: "open",
      triggeredAt: "2026-09-12T04:59:00.000Z",
      dueAt: "2999-01-01T10:00:00.000Z",
    };
    render(
      <ApiClientProvider
        client={createApiClient({
          baseUrl: "http://localhost",
          fetch: async () => json({ sfvs: [row] }),
        })}
      >
        <MemoryRouter>
          <SfvWorklist />
        </MemoryRouter>
      </ApiClientProvider>,
    );
    expect(await screen.findByText("2026-09-11 23:59")).toBeTruthy();
    expect(screen.queryByText("2026-09-12 04:59")).toBeNull();
  });
});

describe("the patient timeline's Target date column", () => {
  it("shows a visit entered in the evening on the day the clinician entered it", async () => {
    const GET = vi.fn(async (path: string) => {
      if (path === "/api/v1/patients/{patientId}/hope/assessments")
        return {
          data: {
            assessments: [
              {
                id: "a-1",
                admissionId: "adm-1",
                rfaKind: "01_admission",
                status: "signed",
                targetDate: EVENING_VISIT,
                authorDiscipline: "",
                j2051MaxSeverity: null,
                j2051TriggerFired: false,
                wasLate: false,
                supersededByAssessmentId: null,
              },
            ],
          },
        };
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
    expect(await screen.findByText("Sep 11, 2026")).toBeTruthy();
    expect(screen.queryByText("Sep 12, 2026")).toBeNull();
  });
});
