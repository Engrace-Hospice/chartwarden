// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AdmissionHopeOverview } from "../admission-hope-overview";

// The overview's reads must end in a state the clinician can act on when the connection fails: a rejected request is an
// error with Retry, never a spinner that never ends or an unhandled rejection.

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const noAttention = {
  state: "none",
  severity: "none",
  action: "NONE",
  message: null,
  deadline: null,
};
const timepoint = (kind: string) => ({
  kind,
  status: "not_applicable",
  scheduleId: null,
  windowStart: null,
  windowEnd: null,
  lateDeadline: null,
  completedAt: null,
  assessmentId: null,
  attention: noAttention,
});
const workflow = {
  admissionId,
  patientId: "patient-1",
  admissionStatus: "active",
  admissionAt: "2026-08-27T00:00:00.000Z",
  activatedAt: null,
  dischargedAt: null,
  admissionAssessment: timepoint("01_admission"),
  huv1: timepoint("02_huv1"),
  huv2: timepoint("03_huv2"),
  sfvs: [],
  dischargeAssessment: timepoint("05_discharge"),
  summary: {
    actionableCount: 0,
    overdueCount: 0,
    completedCount: 0,
    nextDeadline: null,
    highestSeverity: "none",
    dueSoonCount: 0,
    workflowIssueCount: 0,
  },
};

type Reply = { data?: unknown; error?: unknown; response?: Response };
const ok = (data: unknown): Reply => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const empty = (status: number): Reply => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status }),
});

function renderOverview(GET: (path: string) => Promise<Reply>): ReturnType<typeof vi.fn> {
  const get = vi.fn(GET);
  render(
    <MemoryRouter initialEntries={[`/admissions/${admissionId}/hope`]}>
      <ApiClientProvider client={{ GET: get } as unknown as ApiClient}>
        <Routes>
          <Route path="/admissions/:admissionId/hope" element={<AdmissionHopeOverview />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return get;
}

const unavailable = () => screen.findByText("Unable to load HOPE workflow");
const retry = () => screen.getByRole("button", { name: /Retry/ });

describe("Admission HOPE overview reads", () => {
  it("ends the loading state with Retry when the workflow read is rejected, and Retry heals it", async () => {
    let attempts = 0;
    renderOverview(async (path) => {
      if (path.includes("/hope")) {
        if (attempts++ === 0) throw new TypeError("Failed to fetch");
        return ok(workflow);
      }
      return ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" });
    });
    await unavailable();
    expect(screen.queryByLabelText("Loading HOPE workflow")).toBeNull();
    fireEvent.click(retry());
    await waitFor(() => expect(screen.queryByText("Unable to load HOPE workflow")).toBeNull());
    expect(await screen.findByText("Discharge Assessment")).toBeTruthy();
  });

  it("is not an empty workflow when the read comes back empty-bodied and non-OK", async () => {
    renderOverview(async () => empty(502));
    await unavailable();
    expect(retry()).toBeTruthy();
  });

  it("still shows the workflow when only the patient lookup is rejected", async () => {
    renderOverview(async (path) => {
      if (path.includes("/hope")) return ok(workflow);
      throw new TypeError("Failed to fetch");
    });
    expect(await screen.findByText("Discharge Assessment")).toBeTruthy();
    expect(screen.queryByText("Unable to load HOPE workflow")).toBeNull();
  });
});
