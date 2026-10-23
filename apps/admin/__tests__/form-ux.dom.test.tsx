// #597 (browser audit F-042, F-043, F-044): console forms explain a refused submit, keep what was typed across the
// step-up round trip, and do not offer "Try again" for a record that is not there.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { TenantOverview } from "../src/modules/34-saas-platform/tenant-overview";
import { PlanEdit } from "../src/modules/35-subscription-billing/plan-edit";
import { PlansList } from "../src/modules/35-subscription-billing/plans-list";
import { Promos } from "../src/modules/35-subscription-billing/promos";
import { RefundApprove } from "../src/modules/35-subscription-billing/refund-approve";
import { RefundNew } from "../src/modules/35-subscription-billing/refund-new";
import { SubscriptionApplyPromo } from "../src/modules/35-subscription-billing/subscription-apply-promo";
import { SubscriptionDetail } from "../src/modules/35-subscription-billing/subscription-detail";
import { SubscriptionPause } from "../src/modules/35-subscription-billing/subscription-pause";

const SUB = "44444444-4444-4444-8444-444444444444";
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (code: string): unknown => ({
  error: { code, message: code, correlationId: "c" },
});

type Handler = (method: string, path: string) => Response;
let calls: { method: string; path: string }[] = [];

function mount(handler: Handler, Screen: ComponentType, entry: string, routePath = "*"): void {
  calls = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(req.url).pathname;
      calls.push({ method: req.method, path });
      return handler(req.method, path);
    },
  });
  render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path={routePath} element={<Screen />} />
            <Route path="/step-up" element={<div data-testid="step-up" />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("F-044 not-found states offer no Try again", () => {
  const notFound: Handler = () => json(404, envelope("NOT_FOUND"));
  const cases: [string, ComponentType, string, string, string][] = [
    [
      "subscription",
      SubscriptionDetail,
      `/admin/subscriptions/${SUB}`,
      "/admin/subscriptions/:id",
      "Subscription not found.",
    ],
    ["plan", PlanEdit, `/admin/plans/${SUB}/edit`, "/admin/plans/:id/edit", "Plan not found."],
    ["refund", RefundApprove, `/admin/refunds/${SUB}`, "/admin/refunds/:id", "Refund not found."],
  ];
  for (const [name, Screen, entry, route, message] of cases) {
    it(`${name}: says it is not found and has no retry`, async () => {
      mount(notFound, Screen, entry, route);
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
  }

  it("tenant: not found has no retry, a server error still does", async () => {
    mount(notFound, TenantOverview, "/tenants/cedar");
    expect(await screen.findByText("Tenant not found.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    cleanup();
    mount(() => json(500, envelope("INTERNAL_ERROR")), TenantOverview, "/tenants/cedar");
    expect(await screen.findByText("Could not load this tenant.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a server error on a subscription keeps its retry", async () => {
    mount(
      () => json(500, envelope("INTERNAL_ERROR")),
      SubscriptionDetail,
      `/admin/subscriptions/${SUB}`,
      "/admin/subscriptions/:id",
    );
    expect(await screen.findByText("Subscription unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("pause / apply promo load the subscription first", () => {
  const forms: [string, ComponentType, string, string, string][] = [
    [
      "pause",
      SubscriptionPause,
      `/admin/subscriptions/${SUB}/pause`,
      "/admin/subscriptions/:id/pause",
      "Pause subscription",
    ],
    [
      "apply promo",
      SubscriptionApplyPromo,
      `/admin/subscriptions/${SUB}/apply_promo`,
      "/admin/subscriptions/:id/apply_promo",
      "Apply promo",
    ],
  ];
  for (const [name, Screen, entry, route, button] of forms) {
    it(`${name}: no form for a subscription that does not exist`, async () => {
      mount(() => json(404, envelope("NOT_FOUND")), Screen, entry, route);
      expect(await screen.findByText("Subscription not found.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: button })).toBeNull();
      expect(calls.every((c) => c.method === "GET")).toBe(true);
    });
    it(`${name}: shows the form once the subscription is found`, async () => {
      mount(() => json(200, { id: SUB, organizationId: SUB }), Screen, entry, route);
      expect(await screen.findByRole("button", { name: button })).toBeTruthy();
    });
  }
});

describe("F-042 forms say why a submit was refused", () => {
  it("refund request: shows each missing field, posts nothing, focuses the first", async () => {
    mount(() => json(200, {}), RefundNew, "/admin/refunds/new");
    const submit = screen.getByRole("button", { name: "Submit request" });
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);
    expect(await screen.findByText("Enter the invoice id.")).toBeTruthy();
    expect(screen.getByText("Enter the refund amount in dollars.")).toBeTruthy();
    expect(screen.getByText(/at least 40 characters/)).toBeTruthy();
    expect(calls).toEqual([]);
    await waitFor(() => expect(document.activeElement?.id).toBe("invoice-id"));
  });

  it("promo: a percentage outside 1-100 is explained", async () => {
    mount(() => json(200, []), Promos, "/admin/promos");
    fireEvent.click(await screen.findByRole("button", { name: "New promo" }));
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "SPRING" } });
    fireEvent.change(screen.getByLabelText(/^Percent/), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Create promo" }));
    expect(await screen.findByText("Enter a whole percentage from 1 to 100.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("F-043 typed input survives the step-up round trip", () => {
  const stepUp: Handler = (method) =>
    method === "POST" ? json(403, envelope("STEP_UP_REQUIRED")) : json(200, []);

  it("new plan: stashed on Re-verify, drawer reopens with the values on return", async () => {
    mount(stepUp, PlansList, "/admin/plans");
    fireEvent.click(await screen.findByRole("button", { name: "New plan" }));
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "team-monthly" } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Team" } });
    fireEvent.change(screen.getByLabelText(/^Base price/), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    expect(await screen.findByTestId("step-up")).toBeTruthy();
    cleanup();
    mount(stepUp, PlansList, "/admin/plans");
    expect(((await screen.findByLabelText(/^Slug/)) as HTMLInputElement).value).toBe(
      "team-monthly",
    );
    expect((screen.getByLabelText(/^Base price/) as HTMLInputElement).value).toBe("12.50");
  });

  it("refund request: values restored after Re-verify", async () => {
    mount(
      (m) => (m === "POST" ? json(403, envelope("STEP_UP_REQUIRED")) : json(200, {})),
      RefundNew,
      "/admin/refunds/new",
    );
    fireEvent.change(screen.getByLabelText(/^Invoice id/), { target: { value: SUB } });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/^Reason detail/), {
      target: { value: "Customer was charged twice for the same October invoice." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    cleanup();
    mount(() => json(200, {}), RefundNew, "/admin/refunds/new");
    expect((screen.getByLabelText(/^Invoice id/) as HTMLInputElement).value).toBe(SUB);
    expect((screen.getByLabelText(/^Amount/) as HTMLInputElement).value).toBe("25");
  });
});
