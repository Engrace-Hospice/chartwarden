// apps/web/src/modules/25-remittance — milestone 5 TPE program tracker. Asserts on RECORDED FETCH CALLS (method, path,
// If-Match, body) like the other M25 write tests, so a control wired to a handler that never fires still fails. The
// server owns every rule and its refusal is shown verbatim; a 409 reloads the panel; a missing threshold is said, never
// assumed; risk and claim-count labels say they are advisory.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { TpeTracker } from "./tpe-tracker";

const PROGRAM = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ROUND1 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ROUND2 = "cccccccc-3333-4333-8333-cccccccccccc";
const PE = "dddddddd-4444-4444-8444-dddddddddddd";
const CLAIM = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const ADR = "ffffffff-6666-4666-8666-ffffffffffff";

type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let programs: unknown[] = [];
let refusal: { status: number; body: unknown } | null = null;
let detailGets = 0;
let thresholdPct: number | null = null;
let rounds: unknown[] = [];

const threshold = () => ({
  pct: thresholdPct,
  source: thresholdPct === null ? "none" : "org_rule",
  verified: false,
});
const summary = (over: Record<string, unknown> = {}) => ({
  id: PROGRAM,
  providerEntityId: PE,
  macName: "CGS",
  openedOn: "2026-01-10",
  state: "active",
  outcomeOn: null,
  reliefUntil: null,
  referralKinds: [],
  version: 3,
  maxRounds: 3,
  roundsRecorded: 1,
  currentRound: 1,
  latestRound: {
    roundNumber: 1,
    resultsOn: "2026-03-01",
    macErrorRatePct: 30,
    macResult: "non_compliant",
  },
  threshold: threshold(),
  aboveThreshold: thresholdPct === null ? null : 30 > thresholdPct,
  claimCountRate: null,
  nextRoundEarliest: "2026-04-20",
  risk: "elevated",
  ...over,
});
const round1 = (over: Record<string, unknown> = {}) => ({
  id: ROUND1,
  roundNumber: 1,
  noticeOn: "2026-02-01",
  resultsOn: "2026-03-01",
  macErrorRatePct: 30,
  macResult: "non_compliant",
  threshold: threshold(),
  educationOn: "2026-03-06",
  educationNote: null,
  claims: [{ id: "c1", claimId: CLAIM, adrCaseId: ADR, adrState: "received", result: "error" }],
  claimCountRate: { reviewed: 1, errors: 1, pct: 100 },
  warnings: ["1 claims sampled; a TPE round usually samples 20 to 40."],
  version: 5,
  ...over,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = req ? req.url : String(input);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    calls.push({
      method,
      path,
      ifMatch: req?.headers.get("if-match") ?? null,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    if (refusal) return json(refusal.status, refusal.body);
    if (path.endsWith("/rounds"))
      return json(201, { id: ROUND2, version: 1, roundNumber: 2, warnings: ["Under 45 days."] });
    return json(200, { id: PROGRAM, version: 4 });
  }
  if (path === "/api/v1/tpe-programs") return json(200, { items: programs });
  if (path === `/api/v1/tpe-programs/${PROGRAM}`) {
    detailGets += 1;
    return json(200, { ...(programs[0] as object), rounds });
  }
  if (path === "/api/v1/tpe-rules") return json(200, { items: [] });
  return json(200, {});
}

const SESSION = {
  roles: ["billing_specialist"],
  permissions: [],
  isAdmin: false,
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "ffffffff-7777-4777-8777-ffffffffffff",
};

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <TpeTracker />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

async function openProgram(): Promise<void> {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open CGS TPE program" }));
  await screen.findByText("Round 1");
}

beforeEach(() => {
  calls = [];
  refusal = null;
  detailGets = 0;
  thresholdPct = null;
  programs = [summary()];
  rounds = [round1()];
  window.sessionStorage.clear();
});
afterEach(() => cleanup());

describe("M25 TPE tracker list", () => {
  it("shows an empty state that explains how to start", async () => {
    programs = [];
    mount();
    expect(await screen.findByText("No TPE programs")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open a program" }).length).toBeGreaterThan(0);
  });

  it("says No threshold confirmed instead of assuming one, and counts it in the KPI strip", async () => {
    mount();
    expect(await screen.findByText("No threshold confirmed")).toBeTruthy();
    expect(screen.getByText("No Threshold")).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByText("2026-04-20")).toBeTruthy();
  });

  it("shows the MAC rate against the recorded threshold and labels the risk advisory", async () => {
    thresholdPct = 20;
    programs = [summary()];
    mount();
    expect(await screen.findByText(/threshold 20% \(unverified\)/)).toBeTruthy();
    expect(screen.getByText(/^30%/)).toBeTruthy();
    expect(screen.getByText("Referral risk (advisory)")).toBeTruthy();
    expect(screen.getByText("Elevated")).toBeTruthy();
  });

  it("shows the relief and referral outcomes in the risk column", async () => {
    programs = [
      summary({ state: "compliant", risk: "relief", outcomeOn: "2026-05-01" }),
      summary({
        id: "99999999-9999-4999-8999-999999999999",
        macName: "NGS",
        state: "referred",
        risk: "referred",
      }),
    ];
    mount();
    expect(await screen.findByText("Relief")).toBeTruthy();
    expect(screen.getAllByText("Referred").length).toBeGreaterThan(1);
  });

  it("shows the server's message when the list cannot be read", async () => {
    refusal = null;
    const failing = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = typeof input === "object" && "url" in input ? (input as Request) : null;
      if (
        new URL(req ? req.url : String(input), "http://localhost").pathname ===
        "/api/v1/tpe-programs"
      )
        return json(403, { error: { code: "FORBIDDEN", message: "requires permission tpe.read" } });
      return stubFetch(input, init);
    };
    render(
      <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: failing })}>
        <SessionProvider session={SESSION}>
          <ToastProvider>
            <MemoryRouter>
              <TpeTracker />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    expect((await screen.findAllByText("requires permission tpe.read")).length).toBeGreaterThan(0);
  });
});

describe("M25 TPE program panel", () => {
  it("shows the round, the letter's values, warnings, the ADR link and an advisory claim count", async () => {
    await openProgram();
    expect(
      screen.getAllByText(/No threshold confirmed — enter it from your MAC's TPE letter/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/2026-03-01 · 30% · Non Compliant/)).toBeTruthy();
    expect(screen.getByText(/Warning: 1 claims sampled/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View in ADR Requests" }).getAttribute("href")).toBe(
      "/remittance/adrs",
    );
    expect(screen.getByText(/This is a claim count, not the MAC's calculation/)).toBeTruthy();
    expect(
      screen.getByText(/advisory label from the MAC's results so far, not a CMS determination/),
    ).toBeTruthy();
  });

  it("starts the next round with the program's version and shows the interval warning", async () => {
    await openProgram();
    fireEvent.click(screen.getByRole("button", { name: "Start round 2" }));
    fireEvent.change(await screen.findByLabelText("Date on the MAC's notice for this round"), {
      target: { value: "2026-03-20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start round" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "POST",
          path: `/api/v1/tpe-programs/${PROGRAM}/rounds`,
          ifMatch: "3",
          body: { noticeOn: "2026-03-20" },
        },
      ]),
    );
    expect(await screen.findByText(/Round 2 started\. Warning: Under 45 days\./)).toBeTruthy();
  });

  it("records the letter's results with the round's version", async () => {
    rounds = [round1({ resultsOn: null, macErrorRatePct: null, macResult: null, threshold: null })];
    await openProgram();
    fireEvent.click(screen.getByRole("button", { name: "Record results" }));
    fireEvent.change(await screen.findByLabelText("Date on the MAC's results letter"), {
      target: { value: "2026-03-01" },
    });
    fireEvent.change(screen.getByLabelText("Error rate stated in the letter (%)"), {
      target: { value: "27.5" },
    });
    fireEvent.change(screen.getByLabelText("Result stated in the letter"), {
      target: { value: "non_compliant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save results" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "PUT",
          path: `/api/v1/tpe-rounds/${ROUND1}/results`,
          ifMatch: "5",
          body: { resultsOn: "2026-03-01", macErrorRatePct: 27.5, macResult: "non_compliant" },
        },
      ]),
    );
  });

  it("blocks a results save until the result and the date are chosen", async () => {
    rounds = [round1({ resultsOn: null, macErrorRatePct: null, macResult: null, threshold: null })];
    await openProgram();
    fireEvent.click(screen.getByRole("button", { name: "Record results" }));
    const save = (await screen.findByRole("button", { name: "Save results" })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(calls).toEqual([]);
  });

  it("adds a sampled claim linked to an ADR", async () => {
    await openProgram();
    fireEvent.click(screen.getByRole("button", { name: "Add sampled claim" }));
    fireEvent.change(await screen.findByLabelText("Claim ID"), { target: { value: CLAIM } });
    fireEvent.change(screen.getByLabelText("ADR ID (optional)"), { target: { value: ADR } });
    fireEvent.change(screen.getByLabelText("Result"), { target: { value: "error" } });
    fireEvent.click(screen.getByRole("button", { name: "Save claim" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "PUT",
          path: `/api/v1/tpe-rounds/${ROUND1}/claims/${CLAIM}`,
          ifMatch: "5",
          body: { result: "error", adrCaseId: ADR },
        },
      ]),
    );
  });

  it("shows a refusal verbatim and keeps the form open on a 422", async () => {
    refusal = {
      status: 422,
      body: {
        error: {
          code: "RESULTS_BEFORE_NOTICE",
          message: "the results letter cannot be dated before the round notice",
        },
      },
    };
    await openProgram();
    fireEvent.click(screen.getByRole("button", { name: "Edit results" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save results" }));
    expect(
      await screen.findByText("the results letter cannot be dated before the round notice"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save results" })).toBeTruthy();
  });

  it("reloads the panel on a 409 and shows the server's message", async () => {
    refusal = {
      status: 409,
      body: {
        error: {
          code: "VERSION_CONFLICT",
          message: "the resource was modified by another writer; re-read and retry",
        },
      },
    };
    await openProgram();
    const before = detailGets;
    fireEvent.click(screen.getByRole("button", { name: "Education" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save education" }));
    expect(await screen.findByText(/modified by another writer/)).toBeTruthy();
    await waitFor(() => expect(detailGets).toBeGreaterThan(before));
    expect(screen.queryByRole("button", { name: "Save education" })).toBeNull();
  });

  it("requires a referral type for a referral, suggests relief one year on, and sends typed values", async () => {
    await openProgram();
    fireEvent.click(screen.getByRole("button", { name: "Record outcome" }));
    fireEvent.change(await screen.findByLabelText("Date on the MAC / CMS letter"), {
      target: { value: "2026-05-01" },
    });
    expect((screen.getByLabelText("Relief runs until") as HTMLInputElement).value).toBe(
      "2027-05-01",
    );
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "referred" } });
    const dialog = within(screen.getByRole("dialog"));
    expect(
      (dialog.getByRole("button", { name: "Record outcome" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(dialog.getByLabelText("Rac"));
    fireEvent.click(dialog.getByRole("button", { name: "Record outcome" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "POST",
          path: `/api/v1/tpe-programs/${PROGRAM}/outcome`,
          ifMatch: "3",
          body: { kind: "referred", outcomeOn: "2026-05-01", referralKinds: ["rac"] },
        },
      ]),
    );
  });

  it("freezes a closed program: no write controls", async () => {
    programs = [summary({ state: "closed" })];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open CGS TPE program" }));
    expect(await screen.findByText(/This program is closed and can no longer change/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record outcome" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add sampled claim" })).toBeNull();
  });

  it("confirms before closing a program", async () => {
    await openProgram();
    fireEvent.click(screen.getByRole("button", { name: "Close program" }));
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));
    await waitFor(() =>
      expect(calls).toEqual([
        { method: "POST", path: `/api/v1/tpe-programs/${PROGRAM}/close`, ifMatch: "3", body: {} },
      ]),
    );
  });
});

describe("M25 TPE thresholds form", () => {
  it("says none are built in and saves the typed number with its source", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Exit thresholds" }));
    expect(await screen.findByText(/No thresholds yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("MAC"), { target: { value: "CGS" } });
    fireEvent.change(screen.getByLabelText("Exit error rate (%)"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("Source (MAC letter, web page)"), {
      target: { value: "TPE letter 2026-02" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save threshold" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: "PUT",
          path: "/api/v1/tpe-rules",
          ifMatch: null,
          body: { macName: "CGS", exitErrorRatePct: 15, sourceNote: "TPE letter 2026-02" },
        },
      ]),
    );
  });
});
