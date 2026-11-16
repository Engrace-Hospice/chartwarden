// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionHopeOverview } from "../admission-hope-overview";
import { REQUEST_TIMEOUT_MS } from "../hope-api";

// Group g1: the overview's reads. A request nobody answers, an admission left before its reply, a refusal and a missing id each
// end in a state the clinician can act on (or is told is final), never a spinner, a stale admission or a "Loading patient...".

afterEach(() => {
  vi.useRealTimers();
});

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherAdmissionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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
const workflow = (id: string, patientId = "patient-1") => ({
  admissionId: id,
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
const never = () => new Promise<Reply>(() => undefined);
const retry = () => screen.getByRole("button", { name: /Retry/ });
const workflowReads = (get: ReturnType<typeof vi.fn>) =>
  get.mock.calls.filter(([path]) => String(path).includes("/hope")).length;

function Jump(): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`/admissions/${otherAdmissionId}/hope`)}>
      Go to the other admission
    </button>
  );
}

function renderOverview(
  GET: (path: string, init?: unknown) => Promise<Reply>,
  path = `/admissions/${admissionId}/hope`,
): ReturnType<typeof vi.fn> & { unmount: () => void } {
  const get = vi.fn(GET);
  const { unmount } = render(
    <MemoryRouter initialEntries={[path]}>
      <ApiClientProvider client={{ GET: get } as unknown as ApiClient}>
        <Jump />
        <Routes>
          <Route path="/admissions/:admissionId/hope" element={<AdmissionHopeOverview />} />
          <Route path="/admissions/hope" element={<AdmissionHopeOverview />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return Object.assign(get, { unmount });
}

describe("Admission HOPE overview: the workflow read", () => {
  it("ends in the error state with Retry when the request is never answered", async () => {
    vi.useFakeTimers();
    renderOverview(() => never());
    expect(screen.getByLabelText("Loading HOPE workflow")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    });
    vi.useRealTimers();
    expect(await screen.findByText("Unable to load HOPE workflow")).toBeTruthy();
    expect(screen.queryByLabelText("Loading HOPE workflow")).toBeNull();
    expect(retry()).toBeTruthy();
  });

  it("is a refusal of access, with no Retry that cannot help, for a 403", async () => {
    renderOverview(async () => ({
      data: undefined,
      error: { error: { code: "FORBIDDEN" } },
      response: new Response(null, { status: 403 }),
    }));
    expect(await screen.findByText(/Your access is limited/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(screen.queryByText("Unable to load HOPE workflow")).toBeNull();
  });

  it("moves focus to the error, and back to it after a second failure, so the keyboard keeps its place", async () => {
    const get = renderOverview(async () => Promise.reject(new TypeError("offline")));
    await screen.findByText("Unable to load HOPE workflow");
    fireEvent.click(retry());
    await waitFor(() => expect(workflowReads(get)).toBe(2));
    const again = await screen.findByRole("button", { name: /Retry/ });
    await waitFor(() => expect(again.closest("[tabindex='-1']")).toBe(document.activeElement));
  });

  it("reads once for a double press of Retry", async () => {
    const get = renderOverview(async () => Promise.reject(new TypeError("offline")));
    const first = await screen.findByRole("button", { name: /Retry/ });
    fireEvent.click(first);
    fireEvent.click(first);
    await screen.findByRole("button", { name: /Retry/ });
    expect(workflowReads(get)).toBe(2);
  });

  it("ends in the error state, not a spinner, when the route has no admission id", async () => {
    const get = renderOverview(async () => ok(workflow(admissionId)), "/admissions/hope");
    expect(await screen.findByText("Unable to load HOPE workflow")).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it("does not let a slow reply for the admission just left replace the one now open", async () => {
    let releaseFirst: (reply: Reply) => void = () => undefined;
    const idOf = (init: unknown) =>
      (init as { params?: { path?: { admissionId?: string } } }).params?.path?.admissionId;
    const get = renderOverview((path, init) => {
      if (!path.includes("/hope"))
        return Promise.resolve(ok({ id: "x", firstName: "A", lastName: "B" }));
      if (idOf(init) === admissionId)
        return new Promise<Reply>((resolve) => {
          releaseFirst = resolve;
        });
      return Promise.resolve(ok(workflow(otherAdmissionId, "patient-2")));
    });
    await waitFor(() => expect(workflowReads(get)).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Go to the other admission" }));
    await waitFor(() => expect(workflowReads(get)).toBe(2));
    await screen.findByText("Discharge Assessment");
    // The patient's name is a second read, after the workflow: wait for it, or the late reply is released before the link exists.
    expect((await screen.findByRole("link", { name: /A B/ })).getAttribute("href")).toBe(
      "/patients/patient-2",
    );
    await act(async () => {
      releaseFirst(ok(workflow(admissionId, "patient-1")));
    });
    // The patient link is the page's own: it points at the admission now open, not the one that answered late.
    expect(screen.getByRole("link", { name: /A B/ }).getAttribute("href")).toBe(
      "/patients/patient-2",
    );
  });

  // There is deliberately no "reply after the whole screen unmounted" test, and the component has no unmount guard to test:
  // React 18 emits no warning for a state update on an unmounted component and the update is a no-op, so nothing is observable.
  // A reply that is stale while the screen stays mounted is the observable case, covered above (it fails with the `latestLoad`
  // check in `load` deleted).
});

describe("Admission HOPE overview: the patient lookup", () => {
  it("ends as a plain link when the lookup is never answered, never as Loading patient... for good", async () => {
    vi.useFakeTimers();
    renderOverview(async (path) => (path.includes("/hope") ? ok(workflow(admissionId)) : never()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Loading patient...")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    });
    vi.useRealTimers();
    expect(await screen.findByText("Open patient record")).toBeTruthy();
    expect(screen.queryByText("Loading patient...")).toBeNull();
  });

  it("ends as a plain link for a rejected lookup and for an empty non-OK reply", async () => {
    renderOverview(async (path) => {
      if (path.includes("/hope")) return ok(workflow(admissionId));
      return { data: undefined, error: undefined, response: new Response(null, { status: 502 }) };
    });
    expect(await screen.findByText("Open patient record")).toBeTruthy();
  });

  it("does not let a slow lookup for the patient just left replace the name of the one now open", async () => {
    let releaseFirst: (reply: Reply) => void = () => undefined;
    const paramOf = (init: unknown, key: "admissionId" | "id") =>
      (init as { params?: { path?: Record<string, string> } }).params?.path?.[key];
    const get = renderOverview((path, init) => {
      if (path.includes("/hope")) {
        const left = paramOf(init, "admissionId") === admissionId;
        return Promise.resolve(
          ok(left ? workflow(admissionId, "patient-1") : workflow(otherAdmissionId, "patient-2")),
        );
      }
      if (paramOf(init, "id") === "patient-1")
        return new Promise<Reply>((resolve) => {
          releaseFirst = resolve;
        });
      return Promise.resolve(ok({ id: "patient-2", firstName: "Grace", lastName: "Hopper" }));
    });
    const lookups = () => get.mock.calls.filter(([path]) => String(path).includes("/patients/"));
    await waitFor(() => expect(lookups()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Go to the other admission" }));
    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
    await act(async () => {
      releaseFirst(ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" }));
    });
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
  });

  it("shows the patient's name once the lookup answers", async () => {
    renderOverview(async (path) =>
      path.includes("/hope")
        ? ok(workflow(admissionId))
        : ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" }),
    );
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
  });
});
