// M36 WP 6.2 (ADR-0092, PROPOSED) - the response analytics screen against a mocked network boundary: every S0 state (loading, flag off, no access,
// error with retry, insufficient data, offline), the KPI strip, the table twin, the suppressed-groups note, no person anywhere, keyboard and axe.
import type { ResponseAnalyticsReport } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseAnalytics } from "./response-analytics";

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
const ok = (data: unknown): Reply => ({ data, response: { status: 200 } });
const fail = (status: number): Reply => ({ error: {}, response: { status } });

const REPORT: ResponseAnalyticsReport = {
  status: "ok",
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-31T00:00:00.000Z",
  minCohort: 5,
  groupBy: "class",
  kpis: {
    requests: 21,
    acknowledged: 20,
    ackedBeforeDeadlineRate: 0.9,
    escalationRate: 0.05,
    medianAckSeconds: 60,
    handoffsOffered: 6,
    handoffsAccepted: 5,
    medianHandoffAcceptSeconds: 120,
  },
  cells: [
    {
      group: "urgent",
      requests: 21,
      acknowledged: 20,
      ackedBeforeDeadlineRate: 0.9,
      escalationRate: 0.05,
      medianAckSeconds: 60,
    },
  ],
  suppressedGroups: 2,
  breakdownWithheld: false,
};

function mount(replies: () => Reply) {
  const GET = vi.fn((_path: string, _init?: unknown): Promise<Reply> => Promise.resolve(replies()));
  const view = render(
    <ApiClientProvider client={{ GET } as unknown as ApiClient}>
      <main id="wx-main">
        <ResponseAnalytics />
      </main>
    </ApiClientProvider>,
  );
  return { GET, ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Response analytics screen", () => {
  it("shows a busy placeholder while loading", () => {
    const GET = vi.fn(() => new Promise<Reply>(() => {}));
    render(
      <ApiClientProvider client={{ GET } as unknown as ApiClient}>
        <ResponseAnalytics />
      </ApiClientProvider>,
    );
    expect(screen.getByText("Loading response analytics")).toBeTruthy();
  });

  it("says today is not included until the day ends", async () => {
    mount(() => ok(REPORT));
    expect(await screen.findByText(/Today is not included until the day ends/)).toBeTruthy();
  });

  it("shows the KPIs, the table twin, the suppressed-groups note and the provisional threshold", async () => {
    const { GET } = mount(() => ok(REPORT));
    expect(await screen.findByText("Median time to acknowledge")).toBeTruthy();
    expect(screen.getAllByText("60 s")).toHaveLength(2); // the KPI and the table twin
    expect(screen.getByText("2 min")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Response by group" });
    const row = within(table).getByRole("row", { name: /Urgent/ });
    expect(row.textContent).toContain("21");
    expect(
      screen.getByText("2 groups are not shown because too few people stand behind them."),
    ).toBeTruthy();
    expect(screen.getByText(/provisional until HR and compliance review/)).toBeTruthy();
    const [path] = GET.mock.calls[0] as [string];
    expect(path).toBe("/api/v1/messaging/analytics/response");
  });

  it("says the breakdown is withheld (and still shows the KPIs) when it cannot be shown without exposing a small residual", async () => {
    mount(() => ok({ ...REPORT, cells: [], breakdownWithheld: true }));
    expect(await screen.findByText("Median time to acknowledge")).toBeTruthy();
    expect(screen.getByText(/breakdown is not shown/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("withholds the handoff figure in words when the server sent none", async () => {
    mount(() =>
      ok({
        ...REPORT,
        kpis: {
          ...REPORT.kpis,
          handoffsOffered: null,
          handoffsAccepted: null,
          medianHandoffAcceptSeconds: null,
        },
      }),
    );
    expect(await screen.findByText("Withheld: too few people")).toBeTruthy();
  });

  it("says why there is nothing to show when too few people stand behind the report", async () => {
    mount(() => ok({ status: "insufficient_data", minCohort: 5 }));
    expect(await screen.findByText("Not enough data to show")).toBeTruthy();
    expect(screen.getByText(/at least 5 different people/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the not-turned-on panel for a 404 (flag off), with no controls", async () => {
    mount(() => fail(404));
    expect(
      await screen.findByText("This feature is not turned on for your organization."),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows no-access for 403 and the sign-in sentence for 401, naming nothing", async () => {
    mount(() => fail(403));
    expect(await screen.findByText("You no longer have access to this.")).toBeTruthy();
    cleanup();
    mount(() => fail(401));
    expect(await screen.findByText(/Sign in again/)).toBeTruthy();
  });

  it("shows an alert with Try again on a server error, and retries", async () => {
    let calls = 0;
    const { GET } = mount(() => (++calls === 1 ? fail(500) : ok(REPORT)));
    const message = await screen.findByText("Response analytics could not be loaded.");
    expect(screen.queryByRole("alert")).toBeNull(); // the polite live region announces it once
    expect(message.closest("[aria-live]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Loading response analytics")).toBeTruthy(); // retry shows feedback
    expect(await screen.findByText("Median time to acknowledge")).toBeTruthy();
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("re-reads with the chosen breakdown and range (keyboard-operable selects)", async () => {
    const { GET } = mount(() => ok(REPORT));
    await screen.findByText("Median time to acknowledge");
    fireEvent.change(screen.getByLabelText("Break down by"), { target: { value: "discipline" } });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    const init = GET.mock.calls[1]?.[1] as { params: { query: { groupBy: string } } };
    expect(init.params.query.groupBy).toBe("discipline");
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "90" } });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(3));
  });

  it("shows the offline banner when the browser is offline", async () => {
    const online = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    mount(() => ok(REPORT));
    expect(await screen.findByText("You are offline. This list may be out of date.")).toBeTruthy();
    online.mockRestore();
  });

  it("adds no second main landmark inside the shell's main", async () => {
    mount(() => ok(REPORT));
    await screen.findByText("Median time to acknowledge");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Response analytics" })).toBeTruthy();
  });

  it("has no serious or critical accessibility violations in the ready state", async () => {
    const { container } = mount(() => ok(REPORT));
    await screen.findByText("Median time to acknowledge");
    const result = await axe.run(container);
    expect(
      result.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical" || v.id.startsWith("landmark-"),
      ),
    ).toEqual([]);
  });
});
