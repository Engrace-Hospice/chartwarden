// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AdmissionHopeOverview } from "../admission-hope-overview";

// Group g1: the overview's header and its deny-as-not-found read. The admission date is a calendar day (a date column serialized
// as midnight UTC) and must read as that day in a US zone; a workflow with no patient must not leave "Loading patient..." and a
// link to /patients/null; and a 404 (hope.scope answers an out-of-caseload admission with it) is final, not a retryable failure.

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// A zone behind UTC: a date-only value parsed as UTC midnight and formatted locally reads as the day before here.
const priorTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (priorTz === undefined) {
    process.env.TZ = undefined;
    Reflect.deleteProperty(process.env, "TZ");
  } else process.env.TZ = priorTz;
});

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
const workflow = (patientId: string | null) => ({
  admissionId,
  patientId,
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
});

type Reply = { data?: unknown; error?: unknown; response?: Response };
const ok = (data: unknown): Reply => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function renderOverview(GET: (path: string, init?: unknown) => Promise<Reply>) {
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
const workflowReads = (get: ReturnType<typeof vi.fn>) =>
  get.mock.calls.filter(([path]) => String(path).includes("/hope")).length;

describe("Admission HOPE overview: header", () => {
  it("shows the admission's calendar day, not the day before it, in a zone behind UTC", async () => {
    renderOverview(async (path) =>
      path === "/api/v1/patients/{id}"
        ? ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" })
        : ok(workflow("patient-1")),
    );
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    // The day stored (27 August) formatted in UTC, so the machine's zone does not decide the expectation, and not by the
    // component's own formatter, which would agree with any mistake in it.
    const storedDay = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date("2026-08-27T00:00:00.000Z"));
    expect(screen.getByText((text) => text.includes(`Admission ${storedDay}`))).toBeTruthy();
  });

  it("says no patient is linked, with no link to /patients/null and no patient read, when the workflow has none", async () => {
    const get = renderOverview(async () => ok(workflow(null)));
    expect(await screen.findByText("Patient not linked")).toBeTruthy();
    expect(screen.queryByText("Loading patient...")).toBeNull();
    expect(document.querySelector('a[href="/patients/null"]')).toBeNull();
    expect(get.mock.calls.some(([path]) => String(path).includes("/patients/"))).toBe(false);
  });
});

describe("Admission HOPE overview: a 404 on the workflow read", () => {
  it("is shown as not available to this user, with no Retry that cannot help", async () => {
    const get = renderOverview(async () => ({
      data: undefined,
      error: { error: { code: "NOT_FOUND", message: "Not found" } },
      response: new Response(null, { status: 404 }),
    }));
    expect(await screen.findByText(/Your access is limited/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(screen.queryByText("Unable to load HOPE workflow")).toBeNull();
    expect(workflowReads(get)).toBe(1);
  });

  it("is still a retryable failure for a 500", async () => {
    renderOverview(async () => ({
      data: undefined,
      error: { error: { code: "INTERNAL" } },
      response: new Response(null, { status: 500 }),
    }));
    expect(await screen.findByText("Unable to load HOPE workflow")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });
});
