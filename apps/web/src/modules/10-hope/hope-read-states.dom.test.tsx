// #591 — the three unfiltered HOPE list reads (schedules, submissions, compliance) answer a caller who is not
// org-wide scoped with 404 (deny-as-not-found). Each screen must say "this view is limited", not "could not
// load" and never render the denied/failed read as an empty list or a zero count.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
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
    failedTitle: /compliance dashboard could not be loaded/,
    kpiCount: 3,
    countLine: null,
  },
];

function mount(screenDef: Screen, responses: Array<() => Response | Promise<Response>>) {
  let n = 0;
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(req.url, "http://localhost").pathname !== screenDef.path) return json({});
    const next = responses[Math.min(n, responses.length - 1)];
    n += 1;
    return (next as () => Response | Promise<Response>)();
  };
  const { Component } = screenDef;
  return render(
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
    </ApiClientProvider>,
  );
}

describe.each(SCREENS)("$name read states", (def) => {
  it("shows the spinner then the empty state for a successful empty read", async () => {
    mount(def, [() => json(def.emptyBody)]);
    await waitFor(() => expect(screen.getAllByText(def.emptyText).length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([403, 404])("shows the scoped denied state on %i, not an empty list", async (status) => {
    mount(def, [() => json({ error: { code: "NOT_FOUND", message: "no" } }, status)]);
    const denied = await screen.findByRole("status", { name: "" });
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
    const resolvers: Array<(r: Response) => void> = [];
    mount(def, [
      () => json({ error: { code: "UNAVAILABLE", message: "down" } }, 503),
      () => new Promise<Response>((resolve) => resolvers.push(resolve)),
    ]);
    await screen.findByRole("alert");
    // A single in-flight retry settles the screen; a stale (older) failure can never overwrite it.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(resolvers).toHaveLength(1));
    await act(async () => resolvers[0]?.(json(def.emptyBody)));
    await waitFor(() => expect(screen.getAllByText(def.emptyText).length).toBeGreaterThan(0));
  });

  it("keeps keyboard focus off <body> after Retry succeeds", async () => {
    mount(def, [
      () => json({ error: { code: "UNAVAILABLE", message: "down" } }, 503),
      () => json(def.emptyBody),
    ]);
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getAllByText(def.emptyText).length).toBeGreaterThan(0));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });
});
