// The Medicaid work queue and the Billing Home strip: claims that need a person plus the validation worklist. What they
// must never do: report a failed, refused or paged source as a clean zero, list a claim twice, invent a deadline, or open
// a write path of their own (every action is a link into the claim screen that owns it).
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MedicaidNeedsAttention } from "../medicaid-home-attention";
import { MedicaidWorkQueue } from "../medicaid-work-queue";

afterEach(cleanup);

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

const claim = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  patientId: "p1",
  state: "DENIED",
  tob: "811",
  serviceFrom: "2026-10-01",
  serviceTo: "2026-10-31",
  medicaidClaimControlNumber: "MCN-1",
  updatedAt: "2026-10-10T00:00:00Z",
  ...over,
});
const blockedClaim = (over: Record<string, unknown> = {}) => ({
  claimId: "c2",
  patientId: "p1",
  state: "FAILED_VALIDATION",
  medicaidClaimControlNumber: "MCN-2",
  updatedAt: "2026-10-11T00:00:00Z",
  ...over,
});

interface Setup {
  claims?: unknown[];
  claimsResult?: "error" | "denied";
  claimsHasMore?: boolean;
  blocked?: unknown[];
  blockedResult?: "error" | "denied";
}

function Where(): null {
  const l = useLocation();
  document.body.dataset.where = l.pathname + l.search;
  return null;
}

function setup(
  o: Setup = {},
  ui: JSX.Element = <MedicaidNeedsAttention />,
  at = "/medicaid/billing/ar-dashboard",
) {
  const get = vi.fn(async (path: string, args?: { params?: { query?: { state?: string } } }) => {
    if (path === "/api/v1/medicaid-claims") {
      if (o.claimsResult) return fail(o.claimsResult === "denied" ? 403 : 500);
      const state = args?.params?.query?.state;
      return page(
        (o.claims ?? []).filter((c) => (c as { state: string }).state === state),
        o.claimsHasMore,
      );
    }
    if (path === "/api/v1/medicaid-validation-worklist") {
      if (o.blockedResult) return fail(o.blockedResult === "denied" ? 403 : 500);
      return ok({
        groups: [{ ruleKey: "r1", claims: o.blocked ?? [] }],
        blockedClaimCount: (o.blocked ?? []).length,
        unattributedClaimCount: 0,
        truncated: false,
      });
    }
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

const cardOf = (label: string) =>
  screen
    .getAllByText(label)
    .map((el) => el.closest(".wx-kpi-card"))
    .find(Boolean) as HTMLElement;

describe("MedicaidNeedsAttention", () => {
  it("counts each source on its own card and lists the most stuck claim with its next step", async () => {
    setup({ claims: [claim()], blocked: [blockedClaim()] });
    await waitFor(() => expect(within(cardOf("Needing action")).getByText("2")).toBeTruthy());
    expect(within(cardOf("Blocked by validation")).getByText("1")).toBeTruthy();
    expect(within(cardOf("Denied claims")).getByText("1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Fix the blocking rules" }).getAttribute("href")).toBe(
      "/medicaid/billing/claims/c2/validation",
    );
  });

  it("shows a dash, not 0, for a source that failed, and does not say nothing is stuck", async () => {
    setup({ blockedResult: "error" });
    await screen.findByRole("alert");
    expect(within(cardOf("Blocked by validation")).getByText("—")).toBeTruthy();
    expect(screen.queryByText("Nothing is stuck.")).toBeNull();
  });

  it("shows a dash and 'No access' for a refused source", async () => {
    setup({ claimsResult: "denied" });
    await screen.findByText(/do not have access to Medicaid claims/);
    expect(within(cardOf("Denied claims")).getByText("—")).toBeTruthy();
    expect(within(cardOf("Denied claims")).getByText("No access")).toBeTruthy();
    expect(screen.queryByText("Nothing is stuck.")).toBeNull();
  });

  it("says nothing is stuck only once every source answered whole", async () => {
    setup({ claims: [claim({ state: "READY" })] });
    await screen.findByText("Nothing is stuck.");
  });

  it("does not say it when a source has more pages than were loaded", async () => {
    setup({ claimsHasMore: true });
    await waitFor(() => expect(within(cardOf("Needing action")).getByText("0+")).toBeTruthy());
    expect(screen.queryByText("Nothing is stuck.")).toBeNull();
  });

  it("shows no count and no empty message while a source is still loading", () => {
    render(
      <ApiClientProvider
        client={{ GET: vi.fn(() => new Promise(() => {})), POST: vi.fn() } as unknown as ApiClient}
      >
        <MemoryRouter>
          <MedicaidNeedsAttention />
        </MemoryRouter>
      </ApiClientProvider>,
    );
    expect(within(cardOf("Needing action")).getByText("—")).toBeTruthy();
    expect(screen.queryByText("Nothing is stuck.")).toBeNull();
  });

  it("opens the Work Queue filtered to the card's source", async () => {
    setup({ blocked: [blockedClaim()] });
    await waitFor(() =>
      expect(within(cardOf("Blocked by validation")).getByText("1")).toBeTruthy(),
    );
    fireEvent.click(cardOf("Blocked by validation"));
    expect(document.body.dataset.where).toBe("/medicaid/billing/queue?type=blocked");
  });
});

describe("MedicaidWorkQueue", () => {
  it("lists a claim that is in both sources once, ranked stuck first, with no deadline wording", async () => {
    setup(
      {
        claims: [claim(), claim({ id: "c2", state: "FAILED_VALIDATION" })],
        blocked: [blockedClaim()],
      },
      <MedicaidWorkQueue />,
      "/medicaid/billing/queue",
    );
    await screen.findAllByText("Okonkwo, Samuel");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Fix the validation failures")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Review the denial")).toBeTruthy();
    expect(within(screen.getByRole("table")).queryByText(/overdue|at risk/i)).toBeNull();
  });

  it("starts on the filters in the URL and ignores an unknown type", async () => {
    setup(
      { claims: [claim(), claim({ id: "r", state: "READY" })], blocked: [blockedClaim()] },
      <MedicaidWorkQueue />,
      "/medicaid/billing/queue?type=denied&urgent=1",
    );
    await screen.findAllByText("Okonkwo, Samuel");
    expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("denied");
    expect((screen.getByLabelText("Stuck claims only") as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
    cleanup();
    setup({ claims: [claim()] }, <MedicaidWorkQueue />, "/medicaid/billing/queue?type=bogus");
    await screen.findAllByText("Okonkwo, Samuel");
    expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("all");
  });

  it("follows the URL when it changes while mounted, and writes filter changes back to it", async () => {
    function Jump(): JSX.Element {
      const nav = useNavigate();
      return (
        <button type="button" onClick={() => nav("/medicaid/billing/queue")}>
          jump
        </button>
      );
    }
    setup(
      { claims: [claim()] },
      <>
        <Jump />
        <MedicaidWorkQueue />
      </>,
      "/medicaid/billing/queue?type=blocked&urgent=1",
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("blocked"),
    );
    fireEvent.click(screen.getByText("jump"));
    await waitFor(() =>
      expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("all"),
    );
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "denied" } });
    expect(document.body.dataset.where).toBe("/medicaid/billing/queue?type=denied");
  });

  it("names a failed source with a retry instead of an empty queue", async () => {
    setup({ claimsResult: "error" }, <MedicaidWorkQueue />, "/medicaid/billing/queue");
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Nothing needs attention")).toBeNull();
  });
});
