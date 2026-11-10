import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — openapi-fetch RETHROWS a network failure (the kit's client has no onError), so
// a gated write that was only guarded for error RESPONSES stranded its busy lock when the operator went offline: both buttons
// stayed disabled behind a spinner and nothing said why. Every gated write must release its lock and say the server was not reached.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { PlanEdit } from "../plan-edit";
import { RefundApprove } from "../refund-approve";
import { RefundNew } from "../refund-new";
import { AddonsPanel } from "../subscription-addons";
import { SubscriptionApplyPromo } from "../subscription-apply-promo";
import { SubscriptionPause } from "../subscription-pause";

const SUB = "44444444-4444-4444-8444-444444444444";
const INVOICE = "3f2b8c1e-1111-4111-8111-111111111111";
const REFUND = "55555555-5555-4555-8555-555555555555";
const UNREACHABLE = /Could not reach the server/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const refund = {
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
const plan = {
  id: SUB,
  slug: "starter-monthly",
  name: "Starter",
  tier: "starter",
  cadence: "monthly",
  basePriceCents: 4900,
  currencyCode: "USD",
  trialPeriodDays: 0,
  isActive: false,
  stripePriceId: null,
  stripeProductId: null,
  meters: [],
};
const liveAddon = {
  id: "66666666-6666-4666-8666-666666666666",
  organizationId: SUB,
  subscriptionId: SUB,
  addonId: "77777777-7777-4777-8777-777777777777",
  addonSlug: "claims_billing",
  addonName: "Claims billing",
  status: "active",
  live: true,
  trialEndsAt: null,
  startedAt: "2026-11-01T00:00:00.000Z",
  endsAt: null,
  canceledAt: null,
  grantedByMembershipId: null,
  grantReason: "signed order form",
};

/** Reads answer from `reads`; every write fails the way an offline fetch does (a rejection, no response). */
function mount(path: string, reads: () => Response): void {
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.method === "GET") return reads();
    throw new TypeError("Failed to fetch");
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/admin/refunds/new" element={<RefundNew />} />
            <Route path="/admin/refunds/:id/approve" element={<RefundApprove />} />
            <Route path="/admin/subscriptions/:id/pause" element={<SubscriptionPause />} />
            <Route
              path="/admin/subscriptions/:id/apply_promo"
              element={<SubscriptionApplyPromo />}
            />
            <Route
              path="/admin/subscriptions/:id/addons"
              element={<AddonsPanel subscriptionId={SUB} usage={null} />}
            />
            <Route path="/admin/plans/:id/edit" element={<PlanEdit />} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
}

const button = (name: RegExp | string): HTMLButtonElement =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
const idle = (b: HTMLButtonElement): boolean => !b.disabled && b.getAttribute("aria-busy") === null;

afterEach(cleanup);

describe("a gated write whose request never gets an answer", () => {
  it("refund approval releases both buttons and says the server was not reached", async () => {
    mount(`/admin/refunds/${REFUND}/approve`, () => json(refund));
    await screen.findByRole("heading", { name: "Review refund" });
    fireEvent.click(button(/Approve refund/));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(idle(button(/Approve refund/))).toBe(true));
    expect(idle(button(/Deny refund/))).toBe(true);
  });

  it("refund denial releases both buttons and says the server was not reached", async () => {
    mount(`/admin/refunds/${REFUND}/approve`, () => json(refund));
    await screen.findByRole("heading", { name: "Review refund" });
    fireEvent.change(screen.getByLabelText(/Deny reason/), {
      target: { value: "Duplicate of #4" },
    });
    fireEvent.click(button(/Deny refund/));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(idle(button(/Deny refund/))).toBe(true));
    expect(idle(button(/Approve refund/))).toBe(true);
    expect((screen.getByLabelText(/Deny reason/) as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it("refund request keeps the typed form usable", async () => {
    mount("/admin/refunds/new", () => json({}));
    for (const [label, value] of [
      [/Invoice/, INVOICE],
      [/Amount/, "25.00"],
      [/Reason detail/, "Customer asked for a partial refund, TICKET-9, see the thread."],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(button(/Submit request/));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(idle(button(/Submit request/))).toBe(true));
    expect((screen.getByLabelText(/Invoice/) as HTMLInputElement).value).toBe(INVOICE);
  });

  it("pause releases the submit button", async () => {
    mount(`/admin/subscriptions/${SUB}/pause`, () => json({ id: SUB, organizationId: SUB }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause subscription" }));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(idle(button("Pause subscription"))).toBe(true));
  });

  it("apply promo releases the submit button and keeps the code", async () => {
    mount(`/admin/subscriptions/${SUB}/apply_promo`, () => json({ id: SUB, organizationId: SUB }));
    fireEvent.change(await screen.findByLabelText(/Promo code/), { target: { value: "LAUNCH25" } });
    fireEvent.click(button("Apply promo"));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(idle(button("Apply promo"))).toBe(true));
    expect((screen.getByLabelText(/Promo code/) as HTMLInputElement).value).toBe("LAUNCH25");
  });

  it("granting an add-on releases the lock", async () => {
    mount(`/admin/subscriptions/${SUB}/addons`, () => json([]));
    await screen.findByText("No add-ons on this subscription.");
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "signed order form" } });
    fireEvent.click(button("Grant add-on"));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(idle(button("Grant add-on"))).toBe(true));
  });

  it("cancelling an add-on releases the lock", async () => {
    mount(`/admin/subscriptions/${SUB}/addons`, () => json([liveAddon]));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel add-on" }));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(idle(button("Cancel add-on"))).toBe(true));
  });

  it("plan editor: activating and adding a meter both release the lock", async () => {
    mount(`/admin/plans/${SUB}/edit`, () => json(plan));
    fireEvent.click(await screen.findByRole("button", { name: /Activate/ }));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(idle(button(/Activate/))).toBe(true));
    fireEvent.change(screen.getByLabelText(/Event type/), { target: { value: "claims" } });
    fireEvent.click(button("Add meter"));
    await waitFor(() => expect(idle(button("Add meter"))).toBe(true));
    expect((screen.getByLabelText(/Event type/) as HTMLInputElement).value).toBe("claims");
  });
});
