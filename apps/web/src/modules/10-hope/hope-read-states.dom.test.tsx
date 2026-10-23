// #591 — the three unfiltered HOPE list reads (schedules, submissions, compliance) answer a caller who is not
// org-wide scoped with 404 (deny-as-not-found). Each screen must say "this view is limited", not "could not
// load" and never render the denied/failed read as an empty list or a zero count.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
}

const SCREENS: Screen[] = [
  {
    name: "HOPE schedules",
    path: "/api/v1/hope/schedules",
    emptyBody: { schedules: [] },
    Component: HopeDashboard,
    emptyText: /No HOPE schedules are currently open/,
    failedTitle: /HOPE schedules could not be loaded/,
  },
  {
    name: "HOPE submissions",
    path: "/api/v1/hope/submissions",
    emptyBody: { submissions: [] },
    Component: SubmissionWorklist,
    emptyText: /No HOPE submission batches have been assembled/,
    failedTitle: /HOPE submissions could not be loaded/,
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
  },
];

function mount(screenDef: Screen, responses: Array<() => Response>) {
  let n = 0;
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(req.url, "http://localhost").pathname !== screenDef.path) return json({});
    const next = responses[Math.min(n, responses.length - 1)];
    n += 1;
    return (next as () => Response)();
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
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/do not have access/i);
    expect(alert.textContent).toMatch(/caseload or provider entity/);
    expect(screen.queryByText(def.emptyText)).toBeNull();
    expect(screen.queryByText(/Retry/)).toBeNull();
  });

  it("shows a retryable error on 503 and recovers when the retry succeeds", async () => {
    mount(def, [
      () => json({ error: { code: "UNAVAILABLE", message: "down" } }, 503),
      () => json(def.emptyBody),
    ]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(def.failedTitle);
    expect(screen.queryByText(def.emptyText)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getAllByText(def.emptyText).length).toBeGreaterThan(0);
  });
});
