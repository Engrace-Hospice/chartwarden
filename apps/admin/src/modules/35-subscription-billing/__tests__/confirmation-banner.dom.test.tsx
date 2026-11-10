import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — the only confirmation of a money write used to be a toast that is gone after five
// seconds. The message now also rides the navigation state, and the page the operator lands on keeps showing it (not as a live
// region: the toast already announced it) until they move on.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefundApprove } from "../refund-approve";
import { RefundsQueue } from "../refunds-queue";
import { SubscriptionDetail } from "../subscription-detail";
import { SubscriptionPause } from "../subscription-pause";

const SUB = "44444444-4444-4444-8444-444444444444";
const REFUND = "55555555-5555-4555-8555-555555555555";
const TOAST_MS = 5000;
const SETTLE_MS = 1;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const requestedRefund = {
  id: REFUND,
  organizationId: SUB,
  organizationName: "Cedar Ridge",
  amountCents: 2500,
  kind: "partial",
  reasonCode: "duplicate",
  status: "requested",
  requestedAt: "2026-01-01T00:00:00.000Z",
  requestedByMembershipId: "member-1",
};
const subscription = {
  id: SUB,
  organizationId: SUB,
  organizationName: "Cedar Ridge",
  planName: "Pro Monthly",
  planTier: "professional",
  status: "active",
  dunningStage: "none",
  defaultPaymentMethodLast4: "4242",
};

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  if (req.method === "POST") return json({ id: "r1" }, 200);
  const path = new URL(req.url).pathname;
  if (path === `/api/admin/refunds/${REFUND}`) return json(requestedRefund);
  if (path === "/api/admin/refunds") return json({ items: [], nextCursor: null, hasMore: false });
  if (path === `/api/admin/subscriptions/${SUB}`) return json(subscription);
  if (path.startsWith("/api/admin/usage/")) return json({ meters: [], claimsBillingAddon: null });
  if (path.endsWith("/addons")) return json([]);
  return json({});
}

/** What a reload or Back to this entry would restore: the current location, with its history state. */
function HistoryEntry(): JSX.Element {
  const { pathname, search, state } = useLocation();
  return <output data-testid="entry">{JSON.stringify({ pathname, search, state })}</output>;
}
const entryNow = (): { pathname: string; search: string; state: unknown } =>
  JSON.parse(screen.getByTestId("entry").textContent ?? "{}");

function mount(entry: string | { pathname: string; search?: string; state?: unknown }): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/admin/refunds/:id/approve" element={<RefundApprove />} />
            <Route path="/admin/refunds" element={<RefundsQueue />} />
            <Route path="/admin/subscriptions/:id/pause" element={<SubscriptionPause />} />
            <Route path="/admin/subscriptions/:id" element={<SubscriptionDetail />} />
          </Routes>
          <HistoryEntry />
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
}

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the confirmation of a finished write", () => {
  it("refund approval: stays on the refund queue after its toast is gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount(`/admin/refunds/${REFUND}/approve`);
    await advance(SETTLE_MS);
    fireEvent.click(screen.getByRole("button", { name: /Approve refund/ }));
    await advance(SETTLE_MS);
    const message = "Refund approved — queued for execution.";
    expect(screen.getByRole("heading", { name: "Refunds" })).toBeTruthy();
    // The toast and the page's own record.
    expect(screen.getAllByText(message)).toHaveLength(2);

    await advance(TOAST_MS + SETTLE_MS);
    const record = screen.getByText(message);
    expect(record).toBeTruthy();
    // Not announced a second time: the toast did that.
    expect(record.closest("[role='status'], [role='alert'], output")).toBeNull();
  });

  it("subscription pause: stays on the subscription after its toast is gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount(`/admin/subscriptions/${SUB}/pause`);
    await advance(SETTLE_MS);
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    await advance(SETTLE_MS);
    await advance(TOAST_MS + SETTLE_MS);
    expect(screen.getByRole("heading", { level: 1, name: "Cedar Ridge" })).toBeTruthy();
    expect(screen.getByText("Subscription paused.")).toBeTruthy();
  });

  it("shows nothing when the page is opened directly", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount("/admin/refunds");
    await advance(SETTLE_MS);
    expect(screen.getByRole("heading", { name: "Refunds" })).toBeTruthy();
    expect(screen.queryByText(/queued for execution/)).toBeNull();
  });

  it("ignores navigation state that is not a message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount({ pathname: "/admin/refunds", state: { confirmation: { not: "text" } } });
    await advance(SETTLE_MS);
    expect(screen.getByRole("heading", { name: "Refunds" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("[object Object]");
  });

  it("is consumed once: after it shows, a reload or Back to the entry no longer brings it back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const message = "Refund approved — queued for execution.";
    mount({
      pathname: "/admin/refunds",
      search: "?filter=x",
      state: { confirmation: message },
    });
    await advance(SETTLE_MS);
    // Shown now, and it stays for as long as the operator stays.
    expect(screen.getByText(message)).toBeTruthy();
    await advance(TOAST_MS + SETTLE_MS);
    expect(screen.getByText(message)).toBeTruthy();
    // But the history entry no longer carries it (same path and search, state cleared).
    const entry = entryNow();
    expect(entry).toEqual({ pathname: "/admin/refunds", search: "?filter=x", state: null });

    // A reload (or Back/Forward to this entry) restores that entry: nothing to show.
    cleanup();
    mount(entry);
    await advance(SETTLE_MS);
    expect(screen.getByRole("heading", { name: "Refunds" })).toBeTruthy();
    expect(screen.queryByText(message)).toBeNull();
  });
});
