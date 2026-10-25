// apps/web/src/modules/25-remittance — milestone 9a-2, the Medical Review Report. The properties that matter: the page says
// plainly that no target or benchmark is set; every tile shows a figure and the change against the previous period (a
// missing side reads as "no previous period", never as zero); an empty period shows dashes and "no data in this period";
// a TPE threshold appears only as the organization's own recorded value; no target/benchmark/score wording exists; the
// uncovered-reason list links into playbook authoring; a refused read shows the server's message with a Retry.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    openedDollars: { value: "166.00", previous: "0.00", change: "166.00" },
    macReasonAsTyped: { code: "56900", figure: fig(1, 0) },
    byReason: { rows: [{ codeKind: "carc", code: "50", count: 2, dollars: "150.00" }], omitted: 0 },
    byMonth: [{ month: "2026-05", count: 5, dollars: "166.00" }],
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
    denialsSeen: 5,
    denialsWithoutPlaybook: 2,
    reasonsSeen: 4,
    reasonsWithoutPlaybook: 2,
    withoutPlaybook: {
      rows: [{ codeKind: "rarc", code: "N1", count: 2, dollars: "10.00" }],
      omitted: 0,
    },
  },
  ...over,
});

let calls: string[] = [];
let gate: Promise<void> | null = null;
let failAfter = Number.POSITIVE_INFINITY;
let status = 200;
let body: unknown = report();

const json = (s: number, b: unknown) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = new URL(req ? req.url : String(input), "http://localhost");
  calls.push(`${url.pathname}?${url.searchParams.toString()}`);
  if (gate) await gate;
  gate = null;
  if (failAfter < calls.length)
    return json(500, { error: { code: "X", message: "report unavailable" } });
  if (status !== 200) return json(status, { error: { code: "X", message: "report refused" } });
  const asked = { from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "" };
  const base = body as { window: Record<string, unknown> };
  return json(200, { ...base, window: { ...base.window, ...asked } });
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
  gate = null;
  failAfter = Number.POSITIVE_INFINITY;
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
      screen.getByText(/2 of 5 denials opened in this period have no matching published playbook/),
    ).toBeTruthy();
    expect(screen.getByText(/2 of 4 reasons have at least one such denial/)).toBeTruthy();
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

  const choosePeriod = async (
    user: ReturnType<typeof userEvent.setup>,
    from: string,
    to: string,
  ) => {
    // Date inputs take a whole value at once; the click is a real user click.
    fireEvent.change(screen.getByLabelText("From"), { target: { value: from } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: to } });
    await user.click(screen.getByRole("button", { name: "Show period" }));
  };

  it("asks for the chosen period", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText(REPORT_NOTE);
    await choosePeriod(user, "2026-01-01", "2026-01-31");
    await waitFor(() =>
      expect(calls.at(-1)).toBe("/api/v1/medical-review/report?from=2026-01-01&to=2026-01-31"),
    );
    expect(await screen.findByText(/30 days, compared with/)).toBeTruthy();
  });

  it("never shows the earlier period's figures under a new From/To while the new one loads", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText(REPORT_NOTE);
    expect(screen.getByRole("table", { name: "ADR figures" })).toBeTruthy();
    let release: () => void = () => {};
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await choosePeriod(user, "2026-01-01", "2026-01-31");
    expect(await screen.findByText(/Showing the earlier period .* is loading/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "ADR figures" })).toBeNull();
    expect(screen.getByText("ADRs received").closest("div")?.textContent).toContain("—");
    release();
    expect(await screen.findByRole("table", { name: "ADR figures" })).toBeTruthy();
    expect(screen.queryByText(/Showing the earlier period/)).toBeNull();
  });

  it("keeps the figures and offers Retry when a refresh of the same period fails", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText(REPORT_NOTE);
    failAfter = calls.length;
    await user.click(screen.getByRole("button", { name: "Show period" }));
    expect(await screen.findByText("report unavailable")).toBeTruthy();
    expect(screen.getByRole("table", { name: "ADR figures" })).toBeTruthy();
    failAfter = Number.POSITIVE_INFINITY;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("report unavailable")).toBeNull());
  });

  it("says plainly that a new period could not be loaded, and labels the earlier figures with their own period", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText(REPORT_NOTE);
    failAfter = calls.length;
    await choosePeriod(user, "2026-01-01", "2026-01-31");
    expect(await screen.findByText("report unavailable")).toBeTruthy();
    expect(screen.getByText(/Showing the earlier period .* could not be loaded/)).toBeTruthy();
  });

  it("uses section headings that name their regions", async () => {
    mount();
    await screen.findByText(REPORT_NOTE);
    const region = screen.getByRole("region", { name: "ADR requests" });
    expect(region.querySelector("h2")?.textContent).toBe("ADR requests");
  });

  it("shows the server's refusal with a Retry", async () => {
    status = 422;
    mount();
    expect(await screen.findByText("report refused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("writes exact money from the server's strings", async () => {
    mount();
    expect(await screen.findByText(/Opened 5 \(\$166\.00\)/)).toBeTruthy();
  });
});
