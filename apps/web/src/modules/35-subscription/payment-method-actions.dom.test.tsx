// apps/web/src/modules/35-subscription — #27: the payment-methods action controls must not be inert.
//
// The screen loaded its list over a real GET and rendered a full table, so it looked complete — but
// "Add card", "Set default" and "Detach" were all plain buttons with NO `onClick`. Clicking them did
// nothing: no request, no error, no feedback. A read-only screen wearing a read-write screen's
// affordances, on a billing surface where the consequence of "nothing happened" is a lapsed
// subscription.
//
// Nothing in the repo's gate set can see this. `ui:parity` proves a screen is registered with a
// resolvable permission, `docs:ui` proves the spec corpus is consistent, `frame:fidelity` tracks
// visual match — none of them inspects behaviour. So the regression net has to be a DOM test that
// CLICKS the control and asserts the request went out.
//
// Assertions are made on the recorded fetch calls (method + URL), not on a spy over the api client:
// a mocked client would still pass if the button were re-wired to a handler that never issues the
// request, which is the exact failure being fixed.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentMethods } from "./payment-methods";

const METHOD = {
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  kind: "card",
  brand: "Visa",
  last4: "4242",
  expiresAt: "2030-01-31T00:00:00.000Z",
  isDefault: false,
  isActive: true,
};

/** Every request the screen issued, in order: "METHOD /path". */
let calls: string[] = [];

// openapi-fetch calls `fetch(new Request(url, init))` — the method rides on the Request, NOT on a
// separate `init`, so reading `init.method` alone records every call as a GET.
function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  calls.push(`${method} ${new URL(url, "http://localhost").pathname}`);
  const body = method === "GET" ? JSON.stringify([METHOD]) : JSON.stringify({ ok: true });
  return Promise.resolve(
    new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  );
}

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <PaymentMethods />
      </ToastProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(stubFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("#27 — payment-method action controls are wired", () => {
  it("renders the loaded card, so the rest of the assertions are about a real row", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/Visa \.\.\.\.4242/)).toBeTruthy());
    expect(calls).toContain("GET /api/v1/payment_methods");
  });

  it("'Set default' issues PATCH …/set_default and reloads the list", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/Visa \.\.\.\.4242/)).toBeTruthy());
    calls = [];

    fireEvent.click(screen.getByRole("button", { name: /Set default/i }));

    await waitFor(() =>
      expect(calls).toContain(`PATCH /api/v1/payment_methods/${METHOD.id}/set_default`),
    );
    // The list must be re-read, or the table keeps showing the pre-change default.
    await waitFor(() => expect(calls).toContain("GET /api/v1/payment_methods"));
  });

  it("'Detach' CONFIRMS first and only then issues DELETE — it is irreversible here", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/Visa \.\.\.\.4242/)).toBeTruthy());
    calls = [];

    fireEvent.click(screen.getByRole("button", { name: /^Detach\b/i }));
    // The click alone must NOT delete anything — that is the safety property.
    expect(calls).toEqual([]);

    const confirm = await screen.findByRole("button", { name: /Detach card/i });
    fireEvent.click(confirm);

    await waitFor(() => expect(calls).toContain(`DELETE /api/v1/payment_methods/${METHOD.id}`));
  });

  it("cancelling the detach confirmation issues no request at all", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/Visa \.\.\.\.4242/)).toBeTruthy());
    calls = [];

    fireEvent.click(screen.getByRole("button", { name: /^Detach\b/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel/i }));

    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("'Add card' is DISABLED and says why, rather than being silently inert", async () => {
    // It cannot be wired: there is no Stripe SDK dependency and `setup_intent` answers a permanent
    // `{clientSecret: null, status: "pending"}` because the stripe-dispatcher worker is deferred.
    // A button that looks live but can never succeed is the defect this file exists to prevent, so
    // the blocked state has to be VISIBLE, not absent.
    mount();
    await waitFor(() => expect(screen.getByText(/Visa \.\.\.\.4242/)).toBeTruthy());
    const add = screen.getByRole("button", { name: /Add card/i }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title.length).toBeGreaterThan(0);
  });

  it("a failed action surfaces feedback and does not silently swallow the error", async () => {
    render(
      <ApiClientProvider
        client={createApiClient({
          baseUrl: "http://localhost",
          fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            const { method } = requestOf(input, init);
            if (method === "GET") return stubFetch(input, init);
            return Promise.resolve(
              new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "nope" } }), {
                status: 403,
                headers: { "content-type": "application/json" },
              }),
            );
          },
        })}
      >
        <ToastProvider>
          <PaymentMethods />
        </ToastProvider>
      </ApiClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Visa \.\.\.\.4242/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Set default/i }));

    // The user must be told. A 403 that produces no visible change is indistinguishable from the
    // dead-button behaviour this fix removes.
    await waitFor(() =>
      expect(screen.getByText(/Could not set that card as the default/i)).toBeTruthy(),
    );
    // ...and the table is still there: the failure must not blank the screen.
    expect(screen.getByText(/Visa \.\.\.\.4242/)).toBeTruthy();
  });
});
