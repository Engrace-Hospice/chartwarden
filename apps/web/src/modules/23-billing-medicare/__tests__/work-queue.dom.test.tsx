// The Billing work queue screen: one list over claims, NOE/NOTR notices and DDE items, each source read on its own.
// What it must never do: report a failed or paged source as a clean zero, list a notice and its DDE item twice, or
// open a write path of its own (every action is a link into the screen that already owns it).
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DdeItem } from "../dde-queue-model";
import { BillingWorkQueue } from "../work-queue";

afterEach(cleanup);

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const fail = (status: number) => ({
  data: undefined,
  error: { error: { code: "X", message: "x" } },
  response: new Response(null, { status }),
});
const page = (items: unknown[], hasMore = false) => ok({ items, hasMore, nextCursor: null });

const NAMES: Record<string, { firstName: string; lastName: string }> = {
  p1: { firstName: "Samuel", lastName: "Okonkwo" },
  p2: { firstName: "Walter", lastName: "Fairbanks" },
  p3: { firstName: "Eleanor", lastName: "Whitfield" },
};

function dde(over: Partial<DdeItem> = {}): DdeItem {
  return {
    ddeWorkItemId: "d1",
    patientId: "p1",
    providerEntityId: "e1",
    itemType: "noe",
    subjectKind: "noe_record",
    subjectId: "n1",
    state: "queued",
    attemptNumber: 1,
    assigneeMembershipId: null,
    priority: 0,
    source: "manual",
    deadlineAt: inDays(1),
    deadlineStatus: "at_risk",
    submittedAt: null,
    macAcceptedOn: null,
    dcn: null,
    rtpReasonCode: null,
    outcomeCode: null,
    notes: null,
    allowedActions: [],
    version: 1,
    createdAt: inDays(-1),
    ...over,
  };
}
const claim = (over: Record<string, unknown> = {}) => ({
  claimId: "c1",
  patientId: "p3",
  state: "ready",
  tob: "811",
  serviceFrom: "2026-10-01",
  serviceTo: "2026-10-31",
  claimControlNumber: "CCN-1",
  ...over,
});
const noe = (over: Record<string, unknown> = {}) => ({
  noeId: "n1",
  state: "draft",
  patientId: "p1",
  windowTargetAt: inDays(1),
  windowBreachedAt: null,
  ...over,
});

interface Setup {
  claims?: unknown[];
  noe?: unknown[] | "error" | "denied";
  notr?: unknown[] | "error" | "denied";
  dde?: unknown[] | "error";
  ddeHasMore?: boolean;
}

function setup(o: Setup = {}) {
  const get = vi.fn(async (path: string, args?: { params?: { query?: { state?: string } } }) => {
    if (path === "/api/v1/billing/claims") {
      const state = args?.params?.query?.state;
      return page((o.claims ?? []).filter((c) => (c as { state: string }).state === state));
    }
    if (path === "/api/v1/noe-records")
      return o.noe === "error" ? fail(500) : o.noe === "denied" ? fail(403) : page(o.noe ?? []);
    if (path === "/api/v1/billing/claim-validation-summary")
      return ok({
        totalClaims: 0,
        neverValidated: 0,
        byOutcome: {
          all_pass: 0,
          failures_present: 0,
          overrides_required: 0,
          ready_for_submission: 0,
        },
        oldestLatestRunAt: null,
      });
    if (path === "/api/v1/notr-records")
      return o.notr === "error" ? fail(500) : o.notr === "denied" ? fail(403) : page(o.notr ?? []);
    if (path === "/api/v1/billing/dde-items")
      return o.dde === "error" ? fail(500) : page(o.dde ?? [], o.ddeHasMore);
    if (path === "/api/v1/patients/{id}") {
      const id = (args as unknown as { params: { path: { id: string } } }).params.path.id;
      return ok(NAMES[id] ?? {});
    }
    return fail(404);
  });
  const api = { GET: get, POST: vi.fn() } as unknown as ApiClient;
  render(
    <ApiClientProvider client={api}>
      <MemoryRouter>
        <BillingWorkQueue />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return { get, api };
}

// A source's KPI card; the label text also appears in the Type filter, so find the one inside a card.
const card = (label: string) =>
  screen
    .getAllByText(label)
    .map((el) => el.closest(".wx-kpi-card"))
    .find(Boolean);

describe("BillingWorkQueue rows", () => {
  it("lists work from every source, the most urgent first, with names and the next step", async () => {
    setup({
      claims: [claim()],
      noe: [noe({ noeId: "late", patientId: "p2", windowTargetAt: inDays(-2) })],
      dde: [],
    });
    await screen.findByText("Fairbanks, Walter");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Fairbanks, Walter")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Overdue")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Whitfield, Eleanor")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Submit the claim" }).getAttribute("href")).toBe(
      "/billing/claims/c1",
    );
  });

  it("shows a notice and the DDE item that files it as one row, going to the DDE item", async () => {
    setup({ noe: [noe()], dde: [dde()] });
    await screen.findByText("Okonkwo, Samuel");
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "Claim it and key it in DDE" }).getAttribute("href"),
    ).toBe("/billing/dde?item=d1");
  });

  it("says who filed it only after a submission is recorded", async () => {
    setup({
      dde: [
        dde({ ddeWorkItemId: "q", subjectId: "s1", patientId: "p1" }),
        dde({
          ddeWorkItemId: "m",
          subjectId: "s2",
          patientId: "p2",
          state: "submitted",
          submissionMode: "manual",
        }),
        dde({
          ddeWorkItemId: "v",
          subjectId: "s3",
          patientId: "p3",
          state: "submitted",
          submissionMode: "provider",
        }),
      ],
    });
    await screen.findByText("Whitfield, Eleanor");
    expect(screen.getAllByText("Keyed by hand")).toHaveLength(1);
    expect(screen.getAllByText("Via provider")).toHaveLength(1);
  });

  it("opens a side panel with links into the screens that own the work", async () => {
    setup({ noe: [noe()], dde: [dde()] });
    const name = await screen.findByText("Okonkwo, Samuel");
    fireEvent.click(name.closest("tr") as HTMLElement);
    const panel = within(await screen.findByRole("complementary"));
    expect(panel.getByRole("link", { name: "Open the DDE item" }).getAttribute("href")).toBe(
      "/billing/dde?item=d1",
    );
    expect(panel.getByRole("link", { name: "Open the notice" }).getAttribute("href")).toBe(
      "/billing/noe/n1",
    );
  });

  it("filters by type and by urgency", async () => {
    setup({
      claims: [claim()],
      noe: [noe({ windowTargetAt: inDays(1) }), noe({ noeId: "n2", windowTargetAt: inDays(20) })],
    });
    await screen.findByText("Whitfield, Eleanor");
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "noe" } });
    expect(screen.queryByText("Whitfield, Eleanor")).toBeNull();
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("At risk or overdue only"));
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
  });
});

describe("BillingWorkQueue sources", () => {
  it("says so when a source failed, keeps the others, and never shows its count as 0", async () => {
    const { get } = setup({ claims: [claim()], noe: "error" });
    await screen.findByText("Whitfield, Eleanor");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "NOE notices could not be loaded",
    );
    expect(card("NOE")?.textContent).toContain("—");
    expect(card("NOE")?.textContent).not.toMatch(/\b0\b/);
    const before = get.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  });

  it("says so when a source is refused, rather than showing it empty", async () => {
    setup({ claims: [claim()], notr: "denied" });
    await screen.findByText("Whitfield, Eleanor");
    expect((await screen.findByRole("status")).textContent).toContain(
      "You do not have access to NOTR notices",
    );
    expect(card("NOTR")?.textContent).toContain("—");
  });

  it("counts a source that has more pages as N+", async () => {
    setup({ dde: [dde(), dde({ ddeWorkItemId: "d2", subjectId: "n2" })], ddeHasMore: true });
    await screen.findAllByText("Okonkwo, Samuel");
    expect(card("DDE items")?.textContent).toContain("2+");
  });

  it("says nothing needs attention only when every source answered and is empty", async () => {
    setup();
    expect(await screen.findByText("Nothing needs attention")).toBeTruthy();
    expect(card("Claims")?.textContent).toContain("0");
  });

  it("does not say nothing needs attention while a source is down", async () => {
    setup({ dde: "error" });
    await screen.findByRole("alert");
    expect(screen.queryByText("Nothing needs attention")).toBeNull();
  });
});
