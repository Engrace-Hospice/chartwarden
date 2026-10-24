// apps/web/src/modules/25-remittance — milestone 9a-2, the Medical Review Report. The properties that matter: the page says
// plainly that no target or benchmark is set; every tile shows a figure and the change against the previous period (a
// missing side reads as "no previous period", never as zero); an empty period shows dashes and "no data in this period";
// a TPE threshold appears only as the organization's own recorded value; no target/benchmark/score wording exists; the
// uncovered-reason list links into playbook authoring; a refused read shows the server's message with a Retry.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MedicalReviewReportScreen, REPORT_NOTE } from "./medical-review-report";

const fig = (value: number | null, previous: number | null) => ({
  value,
  previous,
  change: value === null || previous === null ? null : value - previous,
});

const report = (over: Record<string, unknown> = {}) => ({
  window: {
    from: "2026-05-01",
    to: "2026-05-30",
    days: 30,
    previous: { from: "2026-04-01", to: "2026-04-30" },
  },
  generatedAt: "2026-06-01T00:00:00.000Z",
  adrs: {
    received: fig(4, 1),
    filed: fig(2, 1),
    filedOnOrBeforeDue: fig(1, 1),
    filedAfterDue: fig(1, 0),
    onOrBeforeDueShareOfFiled: fig(0.5, 1),
    withRecordedProof: fig(1, 0),
    medianDaysToFile: fig(9, 8),
    deniedNoResponse: fig(1, 0),
    dueDatesFromUnverifiedWindows: fig(3, 0),
    byMac: [
      { macName: "MAC-A", received: 2, filed: 2, filedOnOrBeforeDue: 1, deniedNoResponse: 0 },
    ],
  },
  denials: {
    opened: fig(5, null),
    openedDollars: fig(166, null),
    macReasonAsTyped: { code: "56900", figure: fig(1, 0) },
    byReason: { rows: [{ codeKind: "carc", code: "50", count: 2, dollars: 150 }], omitted: 0 },
    byMonth: [{ month: "2026-05", count: 5, dollars: 166 }],
    closureOutcomes: [{ outcome: "written_off", count: 1 }],
  },
  appeals: {
    filed: fig(3, 2),
    decided: fig(3, 1),
    filedByTier: [
      { tier: "alj", filed: 1, filedOnOrBeforeDeadline: 1, deadlineWindowUnconfirmed: true },
    ],
    decidedByOutcome: [
      { outcome: "favorable", count: 1 },
      { outcome: "partial", count: 1 },
      { outcome: "unfavorable", count: 1 },
    ],
    favorableShareOfDecided: 1 / 3,
    openByTier: [{ tier: "alj", count: 1 }],
  },
  reopenings: { opened: fig(2, 1), decidedByOutcome: [{ outcome: "granted", count: 1 }] },
  tpe: {
    available: true,
    truncated: false,
    byState: [{ state: "active", count: 2 }],
    active: [
      {
        macName: "MAC-A",
        currentRound: 1,
        latestMacErrorRatePct: 12,
        thresholdPct: 8,
        thresholdVerified: true,
        aboveThreshold: true,
      },
      {
        macName: "MAC-B",
        currentRound: null,
        latestMacErrorRatePct: null,
        thresholdPct: null,
        thresholdVerified: false,
        aboveThreshold: null,
      },
    ],
  },
  audits: { open: 3, openWithNoRecordedDeadline: 1 },
  playbookCoverage: {
    reasonsSeen: 4,
    reasonsWithoutPlaybook: 2,
    withoutPlaybook: {
      rows: [{ codeKind: "rarc", code: "N1", count: 1, dollars: 10 }],
      omitted: 0,
    },
  },
  ...over,
});

let calls: string[] = [];
let status = 200;
let body: unknown = report();

const json = (s: number, b: unknown) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = new URL(req ? req.url : String(input), "http://localhost");
  calls.push(`${url.pathname}?${url.searchParams.toString()}`);
  return status === 200
    ? json(200, body)
    : json(status, { error: { code: "X", message: "report refused" } });
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter>
        <MedicalReviewReportScreen />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  status = 200;
  body = report();
});
afterEach(() => cleanup());

describe("M25 Medical Review Report", () => {
  it("states that no targets or benchmarks are set, and shows each tile with its change against the previous period", async () => {
    mount();
    expect(await screen.findByText(REPORT_NOTE)).toBeTruthy();
    expect(screen.getByText("vs previous period: 1 (+3)")).toBeTruthy();
    expect(screen.getByText("vs previous period: 100% (-50 pts)")).toBeTruthy();
    // A period with no previous data is a missing comparison, not a zero.
    expect(screen.getByText("no previous period to compare")).toBeTruthy();
    expect(calls[0]).toMatch(
      /^\/api\/v1\/medical-review\/report\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("shows deadline figures against the case, with the unverified-window count and the ADR no-response apart from the typed code", async () => {
    mount();
    expect(
      await screen.findByText(
        /3 of the ADRs received this period have a due date from a response window nobody has verified/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Filed on or before the due date on the case")).toBeTruthy();
    expect(screen.getByText(/MAC reason field says 56900, as typed: 1/)).toBeTruthy();
    expect(screen.getByText(/counted apart from ADRs denied for no response/)).toBeTruthy();
    expect(screen.getByText("window not SME-confirmed")).toBeTruthy();
  });

  it("lists partial and unfavorable decisions separately and labels the favorable share", async () => {
    mount();
    const table = await screen.findByRole("table", { name: "Appeals decided by outcome" });
    expect(table.textContent).toMatch(/Favorable.*Partial.*Unfavorable/);
    expect(screen.getByText(/Favorable decisions as a share of decided appeals: 33%/)).toBeTruthy();
  });

  it("shows a TPE threshold only where the organization recorded one", async () => {
    mount();
    const tpe = await screen.findByRole("table", { name: "Active TPE programs" });
    expect(tpe.textContent).toContain("8%");
    expect(tpe.textContent).toContain("No threshold confirmed");
  });

  it("links uncovered reasons into playbook authoring", async () => {
    mount();
    const link = await screen.findByRole("link", { name: "Write one" });
    expect(link.getAttribute("href")).toBe("/remittance/playbooks?new=1&kind=rarc&code=N1");
    expect(
      screen.getByText(/2 of 4 denial reasons seen in this period have no published playbook/),
    ).toBeTruthy();
  });

  it("never uses target, benchmark, score or compliance wording", async () => {
    mount();
    await screen.findByText(REPORT_NOTE);
    // Apart from the one line that says none are set, no such wording exists on the page.
    const text = (document.body.textContent ?? "").replace(REPORT_NOTE, "");
    expect(text).not.toMatch(/target|benchmark|score|compliant|on track|goal met|passing|failing/i);
  });

  it("shows dashes and 'no data in this period' for an empty period", async () => {
    body = report({
      adrs: {
        ...report().adrs,
        received: fig(0, null),
        onOrBeforeDueShareOfFiled: fig(null, null),
        medianDaysToFile: fig(null, null),
        byMac: [],
      },
      denials: {
        ...report().denials,
        byReason: { rows: [], omitted: 0 },
        byMonth: [],
        closureOutcomes: [],
      },
    });
    mount();
    expect(await screen.findByText("no data in this period")).toBeTruthy();
    expect(screen.getByText("No denials opened in this period.")).toBeTruthy();
  });

  it("asks for the chosen period", async () => {
    mount();
    await screen.findByText(REPORT_NOTE);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Show period" }));
    await waitFor(() =>
      expect(calls.at(-1)).toBe("/api/v1/medical-review/report?from=2026-01-01&to=2026-01-31"),
    );
  });

  it("shows the server's refusal with a Retry", async () => {
    status = 422;
    mount();
    expect(await screen.findByText("report refused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
