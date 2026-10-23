// #591 — the three unfiltered HOPE list reads (schedules, submissions, compliance) answer a caller who is not
// org-wide scoped with 404 (deny-as-not-found). Each screen must say "this view is limited", not "could not
// load" and never render the denied/failed read as an empty list or a zero count.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type JSX, StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { HopeDashboard } from "./hope-dashboard";
import { HqrpComplianceDashboard } from "./hqrp-compliance-dashboard";
import { SubmissionWorklist } from "./submission-worklist";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Screen {
  name: string;
  path: string;
  emptyBody: unknown;
  Component: () => JSX.Element;
  emptyText: RegExp;
  /** Accessible name of the focusable results wrapper. */
  groupName: string;
  failedTitle: RegExp;
  /** KPI cards that must read an em dash (not 0) when the read did not succeed. */
  kpiCount: number;
  /** The list-count line that must say the data is unavailable instead of "0 of 0". */
  countLine: RegExp | null;
}

const SCREENS: Screen[] = [
  {
    name: "HOPE schedules",
    path: "/api/v1/hope/schedules",
    emptyBody: { schedules: [] },
    Component: HopeDashboard,
    emptyText: /No HOPE schedules are currently open/,
    groupName: "HOPE schedules",
    failedTitle: /HOPE schedules could not be loaded/,
    kpiCount: 4,
    countLine: /Schedules unavailable/,
  },
  {
    name: "HOPE submissions",
    path: "/api/v1/hope/submissions",
    emptyBody: { submissions: [] },
    Component: SubmissionWorklist,
    emptyText: /No HOPE submission batches have been assembled/,
    groupName: "HOPE submissions",
    failedTitle: /HOPE submissions could not be loaded/,
    kpiCount: 0,
    countLine: /Submissions unavailable/,
  },
  {
    name: "HQRP compliance",
    path: "/api/v1/hope/dashboard/compliance",
    emptyBody: {
      providerEntityId: null,
      hopeOnTimeRate: null,
      hopeOnTimeCounts: { total: 0 },
      sfvOnTimeRate: null,
      sfvOnTimeCounts: { total: 0 },
      submissionAcceptanceRate: null,
      submissionAcceptanceCounts: { total: 0 },
    },
    Component: HqrpComplianceDashboard,
    emptyText: /No observations|no observations/,
    groupName: "HQRP compliance",
    failedTitle: /compliance dashboard could not be loaded/,
    kpiCount: 3,
    countLine: null,
  },
];

function mount(
  screenDef: Screen,
  responses: Array<() => Response | Promise<Response>>,
  strict = false,
) {
  let n = 0;
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(req.url, "http://localhost").pathname !== screenDef.path) return json({});
    const next = responses[Math.min(n, responses.length - 1)];
    n += 1;
    return (next as () => Response | Promise<Response>)();
  };
  const { Component } = screenDef;
  const tree = (
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "11111111-1111-4111-8111-111111111111",
          organizationId: "org-1",
          displayName: "Nurse",
          permissions: [],
        }}
      >
        <ToastProvider>
          <MemoryRouter>
            <Component />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe.each(SCREENS)("$name read states", (def) => {
  it("shows the spinner then the empty state for a successful empty read", async () => {
    mount(def, [() => json(def.emptyBody)]);
    await waitFor(() => expect(screen.getAllByText(def.emptyText).length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([403, 404])("shows the scoped denied state on %i, not an empty list", async (status) => {
    mount(def, [() => json({ error: { code: "NOT_FOUND", message: "no" } }, status)]);
    await screen.findByText("You do not have access");
    const denied = screen.getByRole("status");
    expect(denied.textContent).toMatch(/do not have access/i);
    expect(denied.textContent).toMatch(
      /Your access is limited to your own caseload or provider entity/,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(def.emptyText)).toBeNull();
    expect(screen.queryByText(/Retry/)).toBeNull();
    expect(screen.queryAllByText("—").length).toBeGreaterThanOrEqual(def.kpiCount);
    if (def.countLine) expect(screen.getByText(def.countLine)).toBeTruthy();
  });

  it("shows a retryable error on 503, goes back to loading, and recovers on success", async () => {
    let release: (r: Response) => void = () => {};
    mount(def, [
      () => json({ error: { code: "UNAVAILABLE", message: "down" } }, 503),
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(def.failedTitle);
    expect(screen.queryByText(def.emptyText)).toBeNull();
    expect(screen.queryAllByText("—").length).toBeGreaterThanOrEqual(def.kpiCount);
    if (def.countLine) expect(screen.getByText(def.countLine)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // In flight: the old error and its Retry are gone, a loading state shows instead.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
    // The error cleared because the retry succeeded, not merely because it started.
    await act(async () => release(json(def.emptyBody)));
    await waitFor(() => expect(screen.getAllByText(def.emptyText).length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a retryable error, not a stuck spinner, when the request is rejected", async () => {
    mount(def, [() => Promise.reject(new TypeError("network")), () => json(def.emptyBody)]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(def.failedTitle);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getAllByText(def.emptyText).length).toBeGreaterThan(0));
  });

  it("applies only the latest response when loads overlap", async () => {
    // StrictMode runs the mount effect twice, so two real loads are in flight at once.
    const resolvers: Array<(r: Response) => void> = [];
    mount(def, [() => new Promise<Response>((resolve) => resolvers.push(resolve))], true);
    await waitFor(() => expect(resolvers).toHaveLength(2));
    // The newer load succeeds first; the older one then fails late and must not overwrite it.
    await act(async () => resolvers[1]?.(json(def.emptyBody)));
    await waitFor(() => expect(screen.getAllByText(def.emptyText).length).toBeGreaterThan(0));
    await act(async () =>
      resolvers[0]?.(json({ error: { code: "UNAVAILABLE", message: "down" } }, 503)),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByText(def.emptyText).length).toBeGreaterThan(0);
  });

  it("focuses the results region by name after Retry succeeds", async () => {
    mount(def, [
      () => json({ error: { code: "UNAVAILABLE", message: "down" } }, 503),
      () => json(def.emptyBody),
    ]);
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getAllByText(def.emptyText).length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("group", { name: def.groupName })),
    );
  });

  it("focuses the new Retry button when Retry fails again", async () => {
    mount(def, [
      () => json({ error: { code: "UNAVAILABLE", message: "down" } }, 503),
      () => json({ error: { code: "UNAVAILABLE", message: "still down" } }, 503),
    ]);
    const first = await screen.findByRole("button", { name: "Retry" });
    first.focus();
    fireEvent.click(first);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" })),
    );
  });
});

describe("HQRP compliance ok-but-empty body", () => {
  it("is a failed read with Retry, not an endless spinner", async () => {
    const def = SCREENS[2] as Screen;
    mount(def, [() => json(null)]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(def.failedTitle);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// The "Refreshing…" cue (dim + label + aria-busy) is for a reload while rows are already on screen. Only the
// schedules screen can reload with data present (a Record/Skip modal calls load() on success). The submissions
// and compliance screens load on mount and via Retry, and both clear their data before any Retry is possible,
// so they carry no such cue and only mark the region busy during the load.
const SCHEDULE_ROW = {
  id: "cccccccc-3333-4333-8333-cccccccccccc",
  patientId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  admissionId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  rfaKind: "02_huv1",
  status: "open",
  windowOpensAt: "2000-01-01T00:00:00.000Z",
  windowClosesAt: "2999-01-01T00:00:00.000Z",
  lateDeadlineAt: "2999-02-01T00:00:00.000Z",
  generatedBy: "system",
  completedByAssessmentId: null,
};

describe("HOPE schedules Refreshing cue", () => {
  it("dims, labels and marks the region busy during a post-write reload, then clears", async () => {
    let release: (r: Response) => void = () => {};
    mount(SCREENS[0] as Screen, [
      () => json({ schedules: [SCHEDULE_ROW] }),
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ]);
    const region = await screen.findByRole("group", { name: "HOPE schedules" });
    await waitFor(() => expect(region.getAttribute("aria-busy")).toBe("false"));
    expect(region.style.opacity).toBe("1");
    expect(screen.queryByText("Refreshing…")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip window" }));

    await waitFor(() => expect(region.getAttribute("aria-busy")).toBe("true"));
    expect(region.style.opacity).toBe("0.6");
    expect(screen.getByText("Refreshing…")).toBeTruthy();
    expect(screen.getByText("1 of 1 schedules")).toBeTruthy();

    await act(async () => release(json({ schedules: [SCHEDULE_ROW] })));
    await waitFor(() => expect(region.getAttribute("aria-busy")).toBe("false"));
    expect(region.style.opacity).toBe("1");
    expect(screen.queryByText("Refreshing…")).toBeNull();
  });
});

describe.each([SCREENS[1], SCREENS[2]] as Screen[])("$name busy region", (def) => {
  it("is busy only while loading and never shows a Refreshing cue", async () => {
    let release: (r: Response) => void = () => {};
    mount(def, [
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ]);
    const region = await screen.findByRole("group", { name: def.groupName });
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("Refreshing…")).toBeNull();
    await act(async () => release(json(def.emptyBody)));
    await waitFor(() => expect(region.getAttribute("aria-busy")).toBe("false"));
    expect(region.style.opacity).toBe("");
  });
});
