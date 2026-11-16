// @vitest-environment jsdom
// Group g2: when HopeActionModal reports a real 409 (the record changed under the clinician), the screen that opened it re-reads, so
// the row or control the server just refused stops being offered. A 409 M10_RECORD_BUSY is not a changed record (the step was not
// applied), so it does not re-read.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { RECORD_BUSY_CODE } from "../hope-api";
import { HopeDashboard } from "../hope-dashboard";
import { PatientHopeTimeline } from "../patient-hope-timeline";

afterEach(cleanup);

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ADMISSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SCHEDULE = "cccccccc-3333-4333-8333-cccccccccccc";
const CHANGED = {
  error: {
    code: "CONFLICT",
    message: `HOPE schedule ${SCHEDULE} is completed; only an open schedule can be skipped`,
  },
};
const BUSY = { error: { code: RECORD_BUSY_CODE, message: "The record is busy." } };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the dashboard's Skip dialog", () => {
  function mountDashboard(skipAnswer: Response) {
    const reads: string[] = [];
    const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/api/v1/hope/schedules" && req.method === "GET") {
        reads.push(path);
        return json({
          schedules: [
            {
              id: SCHEDULE,
              patientId: PATIENT,
              admissionId: ADMISSION,
              rfaKind: "02_huv1",
              status: "open",
              windowOpensAt: "2000-01-01T00:00:00.000Z",
              windowClosesAt: "2999-01-01T00:00:00.000Z",
              lateDeadlineAt: "2999-02-01T00:00:00.000Z",
            },
          ],
        });
      }
      if (path === `/api/v1/hope/schedules/${SCHEDULE}/skip`) return skipAnswer;
      return json({});
    };
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider
          session={{
            userId: "11111111-1111-4111-8111-111111111111",
            organizationId: "org-1",
            displayName: "Dr",
            permissions: ["hope.schedule.read"],
          }}
        >
          <ToastProvider>
            <MemoryRouter>
              <HopeDashboard />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    return reads;
  }

  async function skipWithReason(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    const dialog = await screen.findByRole("dialog", { name: "Skip timepoint window" });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "patient_deceased" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Skip window" }));
    return dialog;
  }

  it("re-reads the schedules when the server says the window is no longer open", async () => {
    const reads = mountDashboard(json(CHANGED, 409));
    const dialog = await skipWithReason();

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "only an open schedule",
    );
    await waitFor(() => expect(reads.length).toBe(2));
  });

  it("does not re-read the schedules for a busy record (the skip was not applied)", async () => {
    const reads = mountDashboard(json(BUSY, 409));
    const dialog = await skipWithReason();

    expect((await within(dialog).findByRole("alert")).textContent).toContain("busy");
    // Give a wrongly-scheduled re-read the chance to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads.length).toBe(1);
  });
});

describe("the patient timeline's Recompute dialog", () => {
  function mountTimeline(regenerateAnswer: unknown) {
    const timelineReads = vi.fn();
    const client = {
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/patients/{patientId}/hope/assessments") {
          timelineReads();
          return { data: { assessments: [] } };
        }
        if (path === "/api/v1/patients/{patientId}/admissions") {
          return { data: { items: [{ id: ADMISSION, dischargedAt: null }] } };
        }
        if (path === "/api/v1/patients/{id}") {
          return {
            data: {
              id: PATIENT,
              mrn: "MRN-1",
              firstName: "Ada",
              lastName: "Lovelace",
              dob: "1948-03-02",
              status: "active",
            },
          };
        }
        return { data: {} };
      }),
      POST: vi.fn(async () => regenerateAnswer),
    } as unknown as ApiClient;
    render(
      <SessionProvider session={null}>
        <MemoryRouter initialEntries={[`/patients/${PATIENT}/hope`]}>
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
    return timelineReads;
  }

  const refused = (body: unknown) => ({
    data: undefined,
    error: body,
    response: new Response(null, { status: 409 }),
  });

  async function recompute(): Promise<HTMLElement> {
    fireEvent.click(
      await screen.findByRole("button", { name: "Create missing timepoint windows" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Create missing timepoint windows" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create missing windows" }));
    return dialog;
  }

  it("re-reads the timeline when the server says the record changed", async () => {
    const timelineReads = mountTimeline(refused(CHANGED));
    await waitFor(() => expect(timelineReads).toHaveBeenCalledTimes(1));
    const dialog = await recompute();

    await within(dialog).findByRole("alert");
    await waitFor(() => expect(timelineReads).toHaveBeenCalledTimes(2));
  });

  it("does not re-read the timeline for a busy record", async () => {
    const timelineReads = mountTimeline(refused(BUSY));
    await waitFor(() => expect(timelineReads).toHaveBeenCalledTimes(1));
    const dialog = await recompute();

    await within(dialog).findByRole("alert");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(timelineReads).toHaveBeenCalledTimes(1);
  });
});
