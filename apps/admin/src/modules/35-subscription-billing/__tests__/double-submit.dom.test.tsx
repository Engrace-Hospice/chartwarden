import { ApiClientProvider, createApiClient, discardStepUpDrafts } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — a gated write that has succeeded must not be sendable again. The
// screens navigate away on a short delay; until then Enter (an implicit form submit) used to POST a second time under a
// fresh Idempotency-Key. Now a submit while the first is in flight, and any submit after it succeeded, sends nothing.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { RefundNew } from "../refund-new";
import { SubscriptionApplyPromo } from "../subscription-apply-promo";
import { SubscriptionPause } from "../subscription-pause";

const SUB = "44444444-4444-4444-8444-444444444444";
const INVOICE = "3f2b8c1e-1111-4111-8111-111111111111";
const SETTLE_MS = 60;

interface Posted {
  path: string;
  idempotencyKey: string | null;
}
let posted: Posted[] = [];
let reply: () => Response = () => json({ id: "r1" }, 201);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  if (req.method === "GET") return json({ id: SUB, organizationId: SUB });
  posted = [
    ...posted,
    { path: new URL(req.url).pathname, idempotencyKey: req.headers.get("Idempotency-Key") },
  ];
  return reply();
}

function mount(path: string): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/refunds/new" element={<RefundNew />} />
          <Route path="/admin/subscriptions/:id/pause" element={<SubscriptionPause />} />
          <Route path="/admin/subscriptions/:id/apply_promo" element={<SubscriptionApplyPromo />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const form = (): HTMLFormElement => {
  const found = document.querySelector("form");
  if (!found) throw new Error("no form rendered");
  return found;
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

afterEach(() => {
  cleanup();
  posted = [];
  reply = () => json({ id: "r1" }, 201);
  discardStepUpDrafts();
  window.sessionStorage.clear();
});

describe("refund request submit", () => {
  const fillRefund = (): void => {
    const set = (label: RegExp, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };
    set(/Invoice/, INVOICE);
    set(/Amount/, "25.00");
    set(/Reason detail/, "Customer asked for a partial refund, TICKET-9, see the thread.");
  };

  it("sends exactly one POST when submitted twice in a row, and none after it succeeded", async () => {
    mount("/admin/refunds/new");
    fillRefund();
    fireEvent.submit(form());
    fireEvent.submit(form());
    await screen.findByText(/Refund request created/);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.idempotencyKey).toBeTruthy();

    fireEvent.submit(form());
    await settle();
    expect(posted).toHaveLength(1);
    expect(
      (screen.getByRole("button", { name: /Submit request/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("pause subscription submit", () => {
  it("sends exactly one POST when submitted twice in a row, and none after it succeeded", async () => {
    mount(`/admin/subscriptions/${SUB}/pause`);
    await screen.findByRole("button", { name: "Pause subscription" });
    fireEvent.submit(form());
    fireEvent.submit(form());
    await screen.findByText("Subscription paused.");
    expect(posted).toHaveLength(1);

    fireEvent.submit(form());
    await settle();
    expect(posted).toHaveLength(1);
    expect(
      (screen.getByRole("button", { name: /Pause subscription/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("leaves the form usable after a refusal, so the operator can retry", async () => {
    reply = () =>
      json({ error: { code: "FORBIDDEN", message: "refused", correlationId: "c" } }, 403);
    mount(`/admin/subscriptions/${SUB}/pause`);
    await screen.findByRole("button", { name: "Pause subscription" });
    fireEvent.submit(form());
    await screen.findByText("Could not pause the subscription.");
    fireEvent.submit(form());
    await waitFor(() => expect(posted).toHaveLength(2));
  });
});

describe("apply promo submit", () => {
  it("sends exactly one POST when submitted twice in a row, and none after it succeeded", async () => {
    mount(`/admin/subscriptions/${SUB}/apply_promo`);
    fireEvent.change(await screen.findByLabelText("Promo code"), { target: { value: "LAUNCH25" } });
    fireEvent.submit(form());
    fireEvent.submit(form());
    await screen.findByText(/applied\./);
    expect(posted).toHaveLength(1);

    fireEvent.submit(form());
    await settle();
    expect(posted).toHaveLength(1);
  });
});
