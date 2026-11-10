import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — openapi-fetch RETHROWS a network failure (the kit's client has no onError), so
// a gated write that was only guarded for error RESPONSES stranded its busy lock when the operator went offline: both buttons
// stayed disabled behind a spinner and nothing said why. Every gated write must release its lock and say the server was not reached.
// Around that: the retry after "could not reach the server" keeps its Idempotency-Key (the first request may have landed), a non-ok
// response with an EMPTY body (a gateway 502) is a failure and not a success, and a reload that fails after a landed write says so.
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

interface WriteCall {
  readonly path: string;
  readonly key: string | null;
}
/** What a write attempt answers: the Nth POST (1-based) may throw (offline) or return a Response. */
type Writer = (attempt: number) => Response;
const offline: Writer = () => {
  throw new TypeError("Failed to fetch");
};
/** An empty-body 502, as a gateway answers: openapi-fetch returns `error: undefined` for it. */
const gateway502 = (): Response =>
  new Response(null, { status: 502, headers: { "content-length": "0" } });

/** Reads answer from `reads`; writes answer from `write` (default: they fail the way an offline fetch does, a rejection). */
function mount(
  path: string,
  reads: () => Response,
  write: Writer = offline,
): { writes: WriteCall[] } {
  const writes: WriteCall[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.method === "GET") return reads();
    writes.push({ path: new URL(req.url).pathname, key: req.headers.get("Idempotency-Key") });
    return write(writes.length);
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
            <Route path="/admin/refunds" element={<p>refunds queue</p>} />
            <Route path="/admin/subscriptions/:id" element={<p>subscription page</p>} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
  return { writes };
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

/** Press `name` once it is idle (a previous attempt has settled). */
async function press(name: RegExp | string): Promise<void> {
  await waitFor(() => expect(idle(button(name))).toBe(true));
  fireEvent.click(button(name));
}
const type = (label: RegExp | string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const fillRefund = (amount = "25.00"): void => {
  type(/Invoice/, INVOICE);
  type(/Amount/, amount);
  type(/Reason detail/, "Customer asked for a partial refund, TICKET-9, see the thread.");
};
const sentKeys = (writes: WriteCall[]): Array<string | null> => writes.map((w) => w.key);
/** The first attempt drops (no answer), later ones are answered `answer`. */
const dropThen =
  (answer: () => Response): Writer =>
  (attempt) =>
    attempt === 1 ? offline(attempt) : answer();
const accepted = (): Response => json({ id: "r1" }, 201);

describe("a retry after 'could not reach the server' keeps the Idempotency-Key", () => {
  it("refund approval: the same decision replays on the same key", async () => {
    const { writes } = mount(
      `/admin/refunds/${REFUND}/approve`,
      () => json(refund),
      dropThen(accepted),
    );
    await screen.findByRole("heading", { name: "Review refund" });
    await press(/Approve refund/);
    await screen.findByText(UNREACHABLE);
    await press(/Approve refund/);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]?.key).toBeTruthy();
    expect(writes[1]?.key).toBe(writes[0]?.key);
  });

  it("refund denial: the same reason replays on the same key, a changed reason is a new intent", async () => {
    const { writes } = mount(`/admin/refunds/${REFUND}/approve`, () => json(refund), offline);
    await screen.findByRole("heading", { name: "Review refund" });
    type(/Deny reason/, "Duplicate of #4");
    await press(/Deny refund/);
    await screen.findByText(UNREACHABLE);
    await press(/Deny refund/);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).toBe(writes[0]?.key);
    type(/Deny reason/, "Duplicate of #5");
    await press(/Deny refund/);
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
  });

  it("refund request: a retry of the same request cannot file a second one, a changed request gets a new key", async () => {
    const { writes } = mount("/admin/refunds/new", () => json({}), offline);
    fillRefund();
    await press(/Submit request/);
    await screen.findByText(UNREACHABLE);
    await press(/Submit request/);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).toBe(writes[0]?.key);
    fillRefund("30.00");
    await press(/Submit request/);
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
  });

  it("an answer (here a refusal) renews the key: the next attempt is a new intent", async () => {
    const refusal = (): Response =>
      json({ error: { code: "FORBIDDEN", message: "no", correlationId: "c" } }, 403);
    const { writes } = mount(`/admin/refunds/${REFUND}/approve`, () => json(refund), refusal);
    await screen.findByRole("heading", { name: "Review refund" });
    await press(/Approve refund/);
    await screen.findByText("Could not approve the refund.");
    await press(/Approve refund/);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).not.toBe(writes[0]?.key);
  });

  it("pause: same request, same key; a changed until-date, a new one", async () => {
    const { writes } = mount(
      `/admin/subscriptions/${SUB}/pause`,
      () => json({ id: SUB, organizationId: SUB }),
      offline,
    );
    await screen.findByRole("button", { name: "Pause subscription" });
    await press("Pause subscription");
    await screen.findByText(UNREACHABLE);
    await press("Pause subscription");
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).toBe(writes[0]?.key);
    type(/Paused until/, "2027-01-15");
    await press("Pause subscription");
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
  });

  it("apply promo: same code, same key; another code, a new one", async () => {
    const { writes } = mount(
      `/admin/subscriptions/${SUB}/apply_promo`,
      () => json({ id: SUB, organizationId: SUB }),
      offline,
    );
    await screen.findByLabelText(/Promo code/);
    type(/Promo code/, "LAUNCH25");
    await press("Apply promo");
    await screen.findByText(UNREACHABLE);
    await press("Apply promo");
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).toBe(writes[0]?.key);
    type(/Promo code/, "SPRING10");
    await press("Apply promo");
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
  });

  it("add-ons: a grant and a cancel each replay on their own key", async () => {
    const grant = mount(`/admin/subscriptions/${SUB}/addons`, () => json([]), offline);
    await screen.findByText("No add-ons on this subscription.");
    type(/Reason/, "signed order form");
    await press("Grant add-on");
    await screen.findByText(UNREACHABLE);
    await press("Grant add-on");
    await waitFor(() => expect(grant.writes).toHaveLength(2));
    expect(grant.writes[1]?.key).toBe(grant.writes[0]?.key);
    cleanup();

    const cancel = mount(`/admin/subscriptions/${SUB}/addons`, () => json([liveAddon]), offline);
    await screen.findByRole("button", { name: "Cancel add-on" });
    await press("Cancel add-on");
    await screen.findByText(UNREACHABLE);
    await press("Cancel add-on");
    await waitFor(() => expect(cancel.writes).toHaveLength(2));
    expect(cancel.writes[1]?.key).toBe(cancel.writes[0]?.key);
  });

  it("plan editor: a meter and an activation each replay on their own key", async () => {
    const { writes } = mount(`/admin/plans/${SUB}/edit`, () => json(plan), offline);
    await screen.findByRole("button", { name: /Activate/ });
    type(/Event type/, "claims");
    await press("Add meter");
    await screen.findByText(UNREACHABLE);
    await press("Add meter");
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.key).toBe(writes[0]?.key);
    await press(/Activate/);
    await waitFor(() => expect(writes).toHaveLength(3));
    await press(/Activate/);
    await waitFor(() => expect(writes).toHaveLength(4));
    expect(writes[3]?.key).toBe(writes[2]?.key);
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
    expect(new Set(sentKeys(writes).filter(Boolean)).size).toBe(2);
  });
});

describe("a non-ok response with an EMPTY body is a failure, not a success", () => {
  const FAILED_STILL_HERE = "refunds queue";

  it("refund approval stays on the page and says it failed", async () => {
    mount(`/admin/refunds/${REFUND}/approve`, () => json(refund), gateway502);
    await screen.findByRole("heading", { name: "Review refund" });
    await press(/Approve refund/);
    expect(await screen.findByText("Could not approve the refund.")).toBeTruthy();
    expect(screen.queryByText(FAILED_STILL_HERE)).toBeNull();
    expect(screen.queryByText(/queued for execution/)).toBeNull();
    await waitFor(() => expect(idle(button(/Approve refund/))).toBe(true));
  });

  it("refund denial stays on the page and says it failed", async () => {
    mount(`/admin/refunds/${REFUND}/approve`, () => json(refund), gateway502);
    await screen.findByRole("heading", { name: "Review refund" });
    type(/Deny reason/, "Duplicate of #4");
    await press(/Deny refund/);
    expect(await screen.findByText("Could not deny the refund.")).toBeTruthy();
    expect(screen.queryByText(FAILED_STILL_HERE)).toBeNull();
  });

  it("refund request does not toast success or redirect", async () => {
    mount("/admin/refunds/new", () => json({}), gateway502);
    fillRefund();
    await press(/Submit request/);
    expect(await screen.findByText(/Could not create the refund request/)).toBeTruthy();
    expect(screen.queryByText(FAILED_STILL_HERE)).toBeNull();
    expect(screen.queryByText(/awaiting a distinct approver/)).toBeNull();
  });

  it("pause and apply promo stay on their forms", async () => {
    mount(
      `/admin/subscriptions/${SUB}/pause`,
      () => json({ id: SUB, organizationId: SUB }),
      gateway502,
    );
    await screen.findByRole("button", { name: "Pause subscription" });
    await press("Pause subscription");
    expect(await screen.findByText("Could not pause the subscription.")).toBeTruthy();
    expect(screen.queryByText("subscription page")).toBeNull();
    cleanup();

    mount(
      `/admin/subscriptions/${SUB}/apply_promo`,
      () => json({ id: SUB, organizationId: SUB }),
      gateway502,
    );
    await screen.findByLabelText(/Promo code/);
    type(/Promo code/, "LAUNCH25");
    await press("Apply promo");
    expect(await screen.findByText(/That promo could not be applied/)).toBeTruthy();
    expect(screen.queryByText("subscription page")).toBeNull();
  });

  it("add-ons and the plan editor do not report success", async () => {
    mount(`/admin/subscriptions/${SUB}/addons`, () => json([]), gateway502);
    await screen.findByText("No add-ons on this subscription.");
    type(/Reason/, "signed order form");
    await press("Grant add-on");
    expect(await screen.findByText("Could not add the claims-billing add-on.")).toBeTruthy();
    expect(screen.queryByText("Add-on granted.")).toBeNull();
    cleanup();

    mount(`/admin/plans/${SUB}/edit`, () => json(plan), gateway502);
    await press(/Activate/);
    expect(await screen.findByText("Could not activate this plan.")).toBeTruthy();
    expect(screen.queryByText(/Plan activated/)).toBeNull();
  });
});

describe("a write that landed whose reload then fails", () => {
  it("plan editor: the page keeps the plan, says the change was saved, clears the lock, and offers a reload", async () => {
    let readsFail = false;
    mount(
      `/admin/plans/${SUB}/edit`,
      () => {
        if (readsFail) throw new TypeError("Failed to fetch");
        return json(plan);
      },
      () => {
        readsFail = true; // the network drops right after the write lands
        return json({}, 200);
      },
    );
    await screen.findByRole("button", { name: /Activate/ });
    await press(/Activate/);
    // The success is not hidden, and the bare "Loading plan…" frame never replaces the page.
    expect(await screen.findByText(/Plan activated/)).toBeTruthy();
    expect(await screen.findByText(/saved, but the plan could not be reloaded/)).toBeTruthy();
    expect(screen.queryByText("Loading plan…")).toBeNull();
    expect(screen.getByRole("heading", { name: /Edit — Starter/ })).toBeTruthy();
    await waitFor(() => expect(idle(button(/Activate/))).toBe(true)); // not an endless spinner

    readsFail = false;
    fireEvent.click(button("Reload plan"));
    await waitFor(() => expect(screen.queryByText(/could not be reloaded/)).toBeNull());
    expect(screen.queryByRole("button", { name: "Reload plan" })).toBeNull();
  });
});
