// Billing Home's "Needs attention" strip: a count per source, the most urgent items, and links into the Work Queue
// pre-filtered. A source that failed or was refused is never reported as 0, and "Nothing is at risk" appears only when
// every source answered whole.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingNeedsAttention } from "../billing-home-attention";
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
const noe = (over: Record<string, unknown> = {}) => ({
  noeId: "n1",
  state: "draft",
  patientId: "p1",
  windowTargetAt: inDays(1),
  windowBreachedAt: null,
  ...over,
});
const claim = (over: Record<string, unknown> = {}) => ({
  claimId: "c1",
  patientId: "p1",
  state: "ready",
  tob: "811",
  serviceFrom: "2026-10-01",
  serviceTo: "2026-10-31",
  claimControlNumber: "CCN-1",
  ...over,
});

interface Setup {
  claims?: unknown[];
  noe?: unknown[] | "error";
  claimsHasMore?: boolean;
}

function Where(): null {
  const l = useLocation();
  document.body.dataset.where = l.pathname + l.search;
  return null;
}

function setup(o: Setup = {}, ui = <BillingNeedsAttention />, at = "/billing") {
  const get = vi.fn(async (path: string, args?: { params?: { query?: { state?: string } } }) => {
    if (path === "/api/v1/billing/claims") {
      const state = args?.params?.query?.state;
      return page(
        (o.claims ?? []).filter((c) => (c as { state: string }).state === state),
        o.claimsHasMore,
      );
    }
    if (path === "/api/v1/noe-records") return o.noe === "error" ? fail(500) : page(o.noe ?? []);
    if (path === "/api/v1/notr-records" || path === "/api/v1/billing/dde-items") return page([]);
    if (path === "/api/v1/patients/{id}") return ok({ firstName: "Samuel", lastName: "Okonkwo" });
    return fail(404);
  });
  render(
    <ApiClientProvider client={{ GET: get, POST: vi.fn() } as unknown as ApiClient}>
      <MemoryRouter initialEntries={[at]}>
        <Where />
        {ui}
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const cardOf = (label: string) => screen.getByText(label).closest(".wx-kpi-card") as HTMLElement;

describe("BillingNeedsAttention", () => {
  it("counts each source on its own card and lists the most urgent item with its next step", async () => {
    setup({ claims: [claim(), claim({ claimId: "c2", state: "denied" })], noe: [noe()] });
    await screen.findByText("Okonkwo, Samuel");
    expect(within(cardOf("Claims")).getByText("2")).toBeTruthy();
    expect(within(cardOf("Denied claims")).getByText("1")).toBeTruthy();
    expect(within(cardOf("NOE")).getByText("1")).toBeTruthy();
    expect(within(cardOf("NOE")).getByText("1 at risk or overdue")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review and submit" }).getAttribute("href")).toBe(
      "/billing/noe/n1",
    );
  });

  it("shows a dash, not 0, for a source that failed, and does not claim nothing is at risk", async () => {
    setup({ noe: "error" });
    await screen.findByRole("alert");
    expect(within(cardOf("NOE")).getByText("—")).toBeTruthy();
    expect(screen.queryByText("Nothing is at risk or overdue.")).toBeNull();
  });

  it("says nothing is at risk only once every source answered whole", async () => {
    setup({ claims: [claim()] });
    await screen.findByText("Nothing is at risk or overdue.");
  });

  it("does not say it when a source has more pages than were loaded", async () => {
    setup({ claimsHasMore: true });
    await waitFor(() => expect(within(cardOf("Claims")).getByText("0+")).toBeTruthy());
    expect(screen.queryByText("Nothing is at risk or overdue.")).toBeNull();
  });

  it("opens the Work Queue already filtered to the card's source", async () => {
    setup({ noe: [noe()] });
    await screen.findByText("Okonkwo, Samuel");
    fireEvent.click(cardOf("NOE"));
    expect(document.body.dataset.where).toBe("/billing/queue?type=noe&urgent=1");
  });
});

describe("BillingNeedsAttention refused and failed sources", () => {
  it("shows a dash and no access note for a refused source, and does not claim nothing is at risk", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/api/v1/noe-records" ? fail(403) : page([]),
    );
    render(
      <ApiClientProvider client={{ GET: get, POST: vi.fn() } as unknown as ApiClient}>
        <MemoryRouter>
          <BillingNeedsAttention />
        </MemoryRouter>
      </ApiClientProvider>,
    );
    await screen.findByText(/do not have access to NOE notices/);
    expect(within(cardOf("NOE")).getByText("—")).toBeTruthy();
    expect(within(cardOf("NOE")).getByText("No access")).toBeTruthy();
    expect(screen.queryByText("Nothing is at risk or overdue.")).toBeNull();
  });

  it("shows dashes on both claim cards when claims cannot be read", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/api/v1/billing/claims" ? fail(500) : page([]),
    );
    render(
      <ApiClientProvider client={{ GET: get, POST: vi.fn() } as unknown as ApiClient}>
        <MemoryRouter>
          <BillingNeedsAttention />
        </MemoryRouter>
      </ApiClientProvider>,
    );
    await screen.findByRole("alert");
    expect(within(cardOf("Claims")).getByText("—")).toBeTruthy();
    expect(within(cardOf("Denied claims")).getByText("—")).toBeTruthy();
    expect(within(cardOf("Denied claims")).getByText("Not available")).toBeTruthy();
  });

  it("shows no count and no empty message while a source is still loading", () => {
    const get = vi.fn(() => new Promise(() => {}));
    render(
      <ApiClientProvider client={{ GET: get, POST: vi.fn() } as unknown as ApiClient}>
        <MemoryRouter>
          <BillingNeedsAttention />
        </MemoryRouter>
      </ApiClientProvider>,
    );
    expect(within(cardOf("Claims")).getByText("—")).toBeTruthy();
    expect(screen.queryByText("Nothing is at risk or overdue.")).toBeNull();
  });
});

describe("Work Queue opened from Billing Home", () => {
  it("follows the URL when it changes while mounted, and writes filter changes back to it", async () => {
    function Jump(): JSX.Element {
      const nav = useNavigate();
      return (
        <button type="button" onClick={() => nav("/billing/queue")}>
          jump
        </button>
      );
    }
    setup(
      { claims: [claim()], noe: [noe()] },
      <>
        <Jump />
        <BillingWorkQueue />
      </>,
      "/billing/queue?type=noe&urgent=1",
    );
    await screen.findByText("Okonkwo, Samuel");
    fireEvent.click(screen.getByText("jump"));
    await waitFor(() =>
      expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("all"),
    );
    expect((screen.getByLabelText("At risk or overdue only") as HTMLInputElement).checked).toBe(
      false,
    );
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "claim" } });
    expect(document.body.dataset.where).toBe("/billing/queue?type=claim");
  });

  it("starts on the type and urgency in the URL, and ignores an unknown type", async () => {
    setup(
      { claims: [claim()], noe: [noe()] },
      <BillingWorkQueue />,
      "/billing/queue?type=noe&urgent=1",
    );
    await screen.findByText("Okonkwo, Samuel");
    expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("noe");
    expect((screen.getByLabelText("At risk or overdue only") as HTMLInputElement).checked).toBe(
      true,
    );
    cleanup();
    setup({ claims: [claim()] }, <BillingWorkQueue />, "/billing/queue?type=bogus");
    await screen.findByText("Okonkwo, Samuel");
    expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("all");
  });
});
