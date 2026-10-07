// GAP-079 — the M26 screens used to be GET-only. This pins the write half: settlement propose + finalize (with
// the attestation minimum and the step-up hand-off), period close / reopen, PS&R variance resolve, and
// threshold-event acknowledge each send the right request and re-read; a STEP_UP_REQUIRED refusal goes to
// `/step-up?returnTo=`; any other refusal stays an inline error.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { CapEvents } from "./cap-events";
import { CapPeriods } from "./cap-periods";
import { CapPsrWorkbench } from "./cap-psr-workbench";
import { CapSettlement } from "./cap-settlement";

const PERIOD_ID = "11111111-1111-4111-8111-111111111111";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";
const LINE_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";

const SETTLEMENT = {
  status: "proposed",
  paidTotalCents: 100000,
  beneficiaryCount: 3,
  aggregateCapAmountCents: 90000,
  aggregateOverageCents: 10000,
  inpatientTotalDays: 10,
  inpatientOverageDays: 1,
  inpatientOverageCents: 500,
  finalizedAt: null,
};

interface World {
  periods: Array<Record<string, unknown>>;
  settlement: typeof SETTLEMENT | null;
  refusal: { status: number; body: unknown } | null;
  writes: Array<{ method: string; path: string; body: unknown }>;
}
let world: World;

const period = (status: string) => ({
  id: PERIOD_ID,
  capYear: "FY2026",
  ccn: "123456",
  startDate: "2025-11-01",
  endDate: "2026-10-31",
  status,
  methodology: "streamlined",
  graceWindowDays: 30,
  aggregateCapAmountCents: 90000,
});

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = req ? req.url : String(input);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (method !== "GET") {
    let body: unknown = null;
    try {
      body = req ? await req.clone().json() : init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    world.writes.push({ method, path, body });
    if (world.refusal) return json(world.refusal.status, world.refusal.body);
    return json(200, {});
  }
  if (path === "/api/v1/cap/periods") return json(200, world.periods);
  if (path === `/api/v1/cap/settlements/${PERIOD_ID}`)
    return world.settlement ? json(200, world.settlement) : json(404, { title: "none" });
  if (path === "/api/v1/cap/threshold-events")
    return json(200, [
      {
        id: EVENT_ID,
        scope: "agency_aggregate",
        patientId: null,
        priorBand: "green",
        currentBand: "amber",
        raisedAt: "2026-09-01T00:00:00.000Z",
        acknowledgedAt: null,
        resolvedAt: null,
      },
    ]);
  if (path === `/api/v1/cap/psr-imports/${IMPORT_ID}`)
    return json(200, {
      id: IMPORT_ID,
      capPeriodId: PERIOD_ID,
      macRegion: "ngs",
      psrPeriodFrom: "2026-01-01",
      psrPeriodTo: "2026-03-31",
      parseStatus: "parsed",
      parseError: null,
      beneficiaryCountPsr: 3,
      paidTotalCentsPsr: 1000,
      importedAt: "2026-04-01T00:00:00.000Z",
    });
  if (path === `/api/v1/cap/psr-imports/${IMPORT_ID}/reconciliation`)
    return json(200, [
      {
        id: LINE_ID,
        scope: "patient_aggregate",
        patientId: "55555555-5555-4555-8555-555555555555",
        m26AccrualCents: 1000,
        psrAmountCents: 1200,
        varianceCents: 200,
        varianceReason: null,
        status: "open",
      },
    ]);
  return json(404, { title: "unexpected" });
}

function Where(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

function mount(element: JSX.Element) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u",
          organizationId: "o",
          membershipId: "m",
          roles: ["billing_manager"],
          permissions: [],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={["/cap/screen"]}>
            <Routes>
              <Route path="/cap/screen" element={element} />
              <Route path="/step-up" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  world = { periods: [], settlement: null, refusal: null, writes: [] };
});
afterEach(cleanup);

describe("M26 settlement actions (GAP-079)", () => {
  it("proposes a settlement for a period in settlement", async () => {
    world.periods = [period("in_settlement")];
    mount(<CapSettlement />);
    fireEvent.click(await screen.findByRole("button", { name: "Propose settlement" }));
    fireEvent.click(screen.getByRole("button", { name: "Propose" }));
    await waitFor(() =>
      expect(world.writes).toEqual([
        { method: "POST", path: `/api/v1/cap/settlements/${PERIOD_ID}/propose`, body: null },
      ]),
    );
  });

  it("finalizes only with an attestation of at least 20 characters", async () => {
    world.periods = [period("in_settlement")];
    world.settlement = SETTLEMENT;
    mount(<CapSettlement />);
    fireEvent.click(await screen.findByRole("button", { name: "Finalize settlement" }));
    const submit = screen.getByRole("button", { name: "Finalize" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Attestation", { exact: false }), {
      target: { value: "too short" },
    });
    expect(submit.disabled).toBe(true);
    const attestation = "I attest this cap settlement is accurate.";
    fireEvent.change(screen.getByLabelText("Attestation", { exact: false }), {
      target: { value: attestation },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(world.writes).toEqual([
        {
          method: "PATCH",
          path: `/api/v1/cap/settlements/${PERIOD_ID}/finalize`,
          body: { attestation },
        },
      ]),
    );
  });

  it("goes to /step-up with returnTo when the server demands a fresh step-up", async () => {
    world.periods = [period("in_settlement")];
    world.settlement = SETTLEMENT;
    world.refusal = { status: 403, body: { code: "STEP_UP_REQUIRED", title: "Step-up required" } };
    mount(<CapSettlement />);
    fireEvent.click(await screen.findByRole("button", { name: "Finalize settlement" }));
    fireEvent.change(screen.getByLabelText("Attestation", { exact: false }), {
      target: { value: "I attest this cap settlement is accurate." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(
        `/step-up?returnTo=${encodeURIComponent("/cap/screen")}`,
      ),
    );
  });

  it("shows any other refusal in place without redirecting", async () => {
    world.periods = [period("in_settlement")];
    world.refusal = { status: 409, body: { title: "A final settlement already exists" } };
    mount(<CapSettlement />);
    fireEvent.click(await screen.findByRole("button", { name: "Propose settlement" }));
    fireEvent.click(screen.getByRole("button", { name: "Propose" }));
    await waitFor(() => expect(screen.getByText("A final settlement already exists")).toBeTruthy());
    expect(screen.queryByTestId("where")).toBeNull();
  });

  it("offers no settlement actions on a settled period", async () => {
    world.periods = [period("settled")];
    world.settlement = { ...SETTLEMENT, status: "final" };
    mount(<CapSettlement />);
    await screen.findByText("Settlement Worksheet");
    expect(screen.queryByRole("button", { name: "Propose settlement" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Finalize settlement" })).toBeNull();
  });
});

describe("M26 period lifecycle actions (GAP-079)", () => {
  it("closes an open cap year", async () => {
    world.periods = [period("open")];
    mount(<CapPeriods />);
    fireEvent.click(await screen.findByRole("button", { name: "Close year" }));
    fireEvent.click(screen.getByRole("button", { name: "Close cap year" }));
    await waitFor(() =>
      expect(world.writes).toEqual([
        { method: "PATCH", path: `/api/v1/cap/periods/${PERIOD_ID}/close`, body: null },
      ]),
    );
  });

  it("reopens a settled period with a reason", async () => {
    world.periods = [period("settled")];
    mount(<CapPeriods />);
    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));
    fireEvent.change(screen.getByLabelText("Reason", { exact: false }), {
      target: { value: "PS&R variance found after settlement" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Reopen" }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(world.writes).toEqual([
        {
          method: "PATCH",
          path: `/api/v1/cap/periods/${PERIOD_ID}/reopen`,
          body: { reason: "PS&R variance found after settlement" },
        },
      ]),
    );
  });
});

describe("M26 threshold events + PS&R actions (GAP-079)", () => {
  it("acknowledges an unacknowledged threshold event", async () => {
    mount(<CapEvents />);
    fireEvent.click(await screen.findByRole("button", { name: "Acknowledge" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Acknowledge" }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(world.writes).toEqual([
        {
          method: "PATCH",
          path: `/api/v1/cap/threshold-events/${EVENT_ID}/acknowledge`,
          body: {},
        },
      ]),
    );
  });

  it("resolves a PS&R variance line with a reason and notes", async () => {
    mount(<CapPsrWorkbench />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: IMPORT_ID } });
    fireEvent.click(screen.getByRole("button", { name: /load/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    fireEvent.change(screen.getByLabelText("Variance reason"), { target: { value: "timing" } });
    const notes = "Billed in March, reported by the MAC in April.";
    fireEvent.change(screen.getByLabelText("Resolution notes", { exact: false }), {
      target: { value: notes },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Resolve" }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(world.writes).toEqual([
        {
          method: "PATCH",
          path: `/api/v1/cap/psr-imports/${IMPORT_ID}/reconciliation/${LINE_ID}/resolve`,
          body: { varianceReason: "timing", resolutionNotes: notes },
        },
      ]),
    );
  });
});
