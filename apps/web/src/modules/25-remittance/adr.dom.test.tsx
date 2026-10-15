// apps/web/src/modules/25-remittance — milestone 2a ADR screen. Asserts on RECORDED FETCH CALLS (method, path,
// If-Match, body) like the other M25 write tests, so a control wired to a handler that never fires still fails.
// The server derives the due date and owns every refusal: the panel shows its message verbatim.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AdrWorklist } from "./adr-worklist";

const ADR = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CLAIM = "dddddddd-4444-4444-8444-dddddddddddd";

type Call = { method: string; path: string; ifMatch: string | null; body: Record<string, unknown> };
let calls: Call[] = [];
let refusal: { status: number; body: unknown } | null = null;
let adrState = "received";

const summary = () => ({
  id: ADR,
  claimId: CLAIM,
  denialCaseId: null,
  macName: "CGS",
  reviewType: "adr",
  state: adrState,
  adrReference: null,
  requestedOn: "2026-01-28",
  windowDays: 45,
  windowSource: "platform_default",
  windowVerified: false,
  responseDueAt: "2099-03-13T04:59:59.999Z",
  version: 4,
});
const detail = () => ({
  ...summary(),
  packet: {
    documents: [],
    checklist: [],
    sentToReviewByMembershipId: null,
    reviewedByMembershipId: null,
    reviewedAt: null,
    filing: null,
  },
  calendarDueDay: "2026-03-14",
  dueDay: "2026-03-13",
  events: [{ id: "e1", eventKind: "received", occurredAt: "2026-02-01T00:00:00.000Z" }],
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
    return json(method === "POST" && path === "/api/v1/adrs" ? 201 : 200, { id: ADR, version: 5 });
  }
  if (path === "/api/v1/adrs") return json(200, { items: [summary()] });
  if (path === `/api/v1/adrs/${ADR}`) return json(200, detail());
  if (path === "/api/v1/mac-rules") return json(200, { items: [] });
  return json(200, {});
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "ffffffff-6666-4666-8666-ffffffffffff",
  roles: ["billing_specialist"],
  permissions: [],
  isAdmin: false,
};

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <AdrWorklist />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  refusal = null;
  adrState = "received";
});
afterEach(() => cleanup());

describe("M25 ADR worklist", () => {
  it("lists an ADR and flags a window that came from an unconfirmed rule", async () => {
    mount();
    expect(await screen.findByText("CGS")).toBeTruthy();
    expect(screen.getByText(/· unverified window/)).toBeTruthy();
  });

  it("explains how the due date was reached, including the business-day roll-back", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open ADR from CGS" }));
    expect(await screen.findByText(/is 2026-03-14, a weekend or federal holiday/)).toBeTruthy();
    expect(screen.getByText(/previous business day, 2026-03-13/)).toBeTruthy();
    expect(screen.getByText(/platform default window was used/)).toBeTruthy();
  });

  it("moves the case with the version the server returned as If-Match", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open ADR from CGS" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start assembling" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/adrs/${ADR}/transition`,
      ifMatch: "4",
      body: { to: "in_assembly" },
    });
  });

  it("offers no move that files to the MAC; filing is recorded from the packet section", async () => {
    adrState = "in_review";
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open ADR from CGS" }));
    await screen.findByRole("button", { name: "Record MAC denial" });
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
  });

  it("shows a server refusal verbatim", async () => {
    refusal = {
      status: 409,
      body: { error: { code: "VERSION_CONFLICT", message: "the resource was modified elsewhere" } },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open ADR from CGS" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start assembling" }));
    expect(await screen.findByText("the resource was modified elsewhere")).toBeTruthy();
  });
});

describe("M25 MAC response windows", () => {
  it("loads the rules once and saves one with the typed window", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "MAC response windows" }));
    expect(await screen.findByText(/No rules yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("MAC"), { target: { value: "CGS" } });
    fireEvent.change(screen.getByLabelText("Response window (days)"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/v1/mac-rules",
      body: { macName: "CGS", reviewType: "adr", responseDays: 30 },
    });
  });
});

describe("M25 ADR worklist states", () => {
  it("says the filter excludes everything, not that no ADR exists", async () => {
    mount();
    await screen.findByText("CGS");
    fireEvent.change(screen.getByLabelText("Filter by state"), { target: { value: "closed" } });
    expect(await screen.findByText("No ADRs in this state")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all states" }));
    expect(await screen.findByText("CGS")).toBeTruthy();
  });
});

describe("M25 log an ADR", () => {
  it("keeps Log ADR disabled until the claim, MAC and letter date are valid, then posts them", async () => {
    mount();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Log an ADR" }))[0] as HTMLElement,
    );
    const submit = (): HTMLButtonElement => screen.getByRole("button", { name: "Log ADR" });
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Claim ID"), { target: { value: CLAIM } });
    fireEvent.change(screen.getByLabelText("MAC"), { target: { value: "CGS" } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Date on the ADR letter"), {
      target: { value: "2026-01-28" },
    });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/adrs",
      body: { claimId: CLAIM, macName: "CGS", reviewType: "adr", requestedOn: "2026-01-28" },
    });
  });
});
