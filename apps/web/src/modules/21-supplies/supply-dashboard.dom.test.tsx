// F-022 (#591) - the supply dashboard never renders a denied or failed read as zero/empty (jsdom).
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SupplyTeamDashboard } from "./supply-dashboard";

const REQUESTS = "/api/v1/supplies/supply-requests";
const RETURNS = "/api/v1/supplies/comfort-kit-returns";
const PAR = "/api/v1/supplies/par-stock";
const DISPATCHES = "/api/v1/supplies/comfort-kit-dispatches";

const ok = (data: unknown[]) => ({
  data: { data, has_more: false },
  error: undefined,
  response: { status: 200 },
});
const failure = (status: number, error: unknown = { title: "boom" }) => ({
  data: undefined,
  error,
  response: { status },
});
const EMPTY = ok([]);
const REQUEST_ROW = {
  supplyRequestId: "11111111-1111-1111-1111-111111111111",
  kind: "dme",
  status: "requested",
  patientId: "22222222-2222-2222-2222-222222222222",
  assignedVendorId: null,
  trackingNumber: null,
  carrier: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  hospiceCoverage: null,
};

function mount(replies: Record<string, unknown>) {
  // A reply may be a function (called per request) so a test can reject or answer a retry differently.
  const get = vi.fn((path: string) => {
    const reply = replies[path];
    return typeof reply === "function" ? reply() : Promise.resolve(reply);
  });
  const api = { GET: get } as unknown as ApiClient;
  render(
    <ApiClientProvider client={api}>
      <MemoryRouter>
        <SupplyTeamDashboard />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return get;
}
const all = (over: Record<string, unknown>) => ({
  [REQUESTS]: EMPTY,
  [RETURNS]: EMPTY,
  [PAR]: EMPTY,
  [DISPATCHES]: EMPTY,
  ...over,
});
const tile = (label: string) => screen.getByText(label).parentElement as HTMLElement;

describe("Supply team dashboard read states", () => {
  it("shows a spinner while loading", () => {
    mount(all({}));
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows genuine empties and zero counts when every read succeeds", async () => {
    mount(all({}));
    await screen.findByText(/Nothing needs supply-team action/);
    expect(screen.getByText(/at or above its reorder point/)).toBeTruthy();
    expect(within(tile("Returns overdue")).getByText("0")).toBeTruthy();
  });

  it("renders rows when reads succeed", async () => {
    mount(all({ [REQUESTS]: ok([REQUEST_ROW]) }));
    await screen.findByText("Age (days)");
    expect(within(tile("Awaiting vendor")).getByText("1")).toBeTruthy();
  });

  it("shows denied panels with em-dash tiles and no raw permission codes on 403", async () => {
    mount(all({ [PAR]: failure(403), [RETURNS]: failure(403), [DISPATCHES]: failure(403) }));
    await screen.findByText(/Nothing needs supply-team action/);
    // Denied is a static fact (polite status, not an alert); the dispatch denial shows once, the
    // discrepancy card only points at it.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(3);
    expect(screen.getByText(/See the "Comfort kits in the field" panel/)).toBeTruthy();
    expect(screen.queryByText(/par_stock\.read|comfort_kit\.|\.read`/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    for (const label of [
      "Returns overdue",
      "Discrepancy reconciliations",
      "Shelf critical / empty",
    ]) {
      expect(within(tile(label)).getByText("—")).toBeTruthy();
    }
    expect(within(tile("Awaiting vendor")).getByText("0")).toBeTruthy();
  });

  it("shows a failed panel with retry on 503 and recovers, busy in between, keeping focus", async () => {
    let release: (v: unknown) => void = () => {};
    let calls = 0;
    const get = mount(
      all({
        [PAR]: () => {
          calls += 1;
          if (calls === 1) return Promise.resolve(failure(503));
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      }),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(within(tile("Shelf critical / empty")).getByText("—")).toBeTruthy();
    expect(screen.queryByText(/at or above its reorder point/)).toBeNull();
    retry.focus();
    fireEvent.click(retry);
    // Reloading: the layout stays mounted (no spinner swap) and is marked busy; the failure is still shown.
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
    // No Retry is offered for a read that is already being retried; a refreshing cue shows instead.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByText("Refreshing…")).toBeTruthy();
    await act(async () => release(EMPTY));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(get.mock.calls.filter(([p]) => p === PAR)).toHaveLength(2);
    expect(within(tile("Shelf critical / empty")).getByText("0")).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    // The Retry button is gone; focus moved to the page region instead of falling to <body>.
    expect(document.activeElement).toBe(document.querySelector(".wx-kit-column"));
    expect(screen.queryByText("Refreshing…")).toBeNull();
  });

  it("shows a failed panel (not a stuck spinner) when a request is rejected", async () => {
    mount(all({ [DISPATCHES]: () => Promise.reject(new Error("network")) }));
    await screen.findByText(/The dispatch list could not be loaded/);
    expect(screen.queryByRole("status")).toBeNull();
    expect(within(tile("Discrepancy reconciliations")).getByText("—")).toBeTruthy();
    // One failure notice, not a duplicate in the discrepancy card.
    expect(screen.getAllByText(/The dispatch list could not be loaded/)).toHaveLength(1);
  });

  it("does not claim an empty action queue when the request read fails", async () => {
    mount(all({ [REQUESTS]: failure(500) }));
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText(/Nothing needs supply-team action/)).toBeNull();
    expect(within(tile("Awaiting vendor")).getByText("—")).toBeTruthy();
  });
});
