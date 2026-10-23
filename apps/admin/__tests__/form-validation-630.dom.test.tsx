// #630 (follow-up to #597): console forms keep Submit enabled and say what is missing inline, instead of a disabled
// button with no message. Each case clicks Submit on an empty form and asserts the message, focus on the first invalid
// control, and that nothing was sent.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { KeyRings } from "../src/modules/34-saas-platform/key-rings";
import { OnboardingTemplates } from "../src/modules/34-saas-platform/onboarding-templates";
import { Signups } from "../src/modules/34-saas-platform/signups";
import { PlanEdit } from "../src/modules/35-subscription-billing/plan-edit";
import { RefundApprove } from "../src/modules/35-subscription-billing/refund-approve";
import { SubscriptionApplyPromo } from "../src/modules/35-subscription-billing/subscription-apply-promo";
import { Usage } from "../src/modules/35-subscription-billing/usage";
import { ChannelMembers } from "../src/modules/36-messaging/channel-members";
import { DeliveryEndpoints } from "../src/modules/36-messaging/settings/delivery-endpoints";
import { Login } from "../src/shell/login";

const ID = "44444444-4444-4444-8444-444444444444";
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (method: string, path: string) => Response;
let calls: { method: string; path: string }[] = [];
const writes = (): number => calls.filter((c) => c.method !== "GET").length;

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
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
}

const focusedId = (): string | null => (document.activeElement as HTMLElement | null)?.id ?? null;

afterEach(cleanup);

describe("#630 submit stays enabled and explains what is missing", () => {
  it("sign in: both fields named, focus on the first", async () => {
    mount(() => json(200, {}), Login, "/login");
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);
    expect(await screen.findByText("Enter your email address.")).toBeTruthy();
    expect(screen.getByText("Enter your password.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^Email/)));
  });

  it("tenant usage: an empty organization id is explained and not navigated", async () => {
    mount(() => json(200, {}), Usage, "/admin/usage");
    const view = screen.getByRole("button", { name: "View" });
    expect(view.hasAttribute("disabled")).toBe(false);
    fireEvent.click(view);
    expect(await screen.findByText("Enter an organization id.")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText(/^Organization id/)),
    );
    expect(calls).toEqual([]);
  });

  it("key rings: an empty slug is explained and nothing is fetched", async () => {
    mount(() => json(200, {}), KeyRings, "/admin/key-rings");
    const load = screen.getByRole("button", { name: "Load" });
    expect(load.hasAttribute("disabled")).toBe(false);
    fireEvent.click(load);
    expect(await screen.findByText("Enter the tenant's org slug.")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText(/^Tenant org slug/)),
    );
    expect(calls).toEqual([]);
  });

  it("apply promo: an empty code is explained and nothing is posted", async () => {
    mount(
      () => json(200, { id: ID, organizationId: ID }),
      SubscriptionApplyPromo,
      `/admin/subscriptions/${ID}/apply_promo`,
      "/admin/subscriptions/:id/apply_promo",
    );
    const apply = await screen.findByRole("button", { name: "Apply promo" });
    expect(apply.hasAttribute("disabled")).toBe(false);
    fireEvent.click(apply);
    expect(await screen.findByText("Enter the promo code to apply.")).toBeTruthy();
    await waitFor(() => expect(focusedId()).toBe("promo-code"));
    expect(writes()).toBe(0);
  });

  it("delivery endpoints: an empty address is explained; an empty code is explained per row", async () => {
    mount(
      (method) =>
        method === "POST"
          ? json(200, { endpointId: "e1", channel: "email", verificationStatus: "pending" })
          : json(200, {}),
      DeliveryEndpoints,
      "/settings/endpoints",
    );
    const add = screen.getByRole("button", { name: "Add endpoint" });
    expect(add.hasAttribute("disabled")).toBe(false);
    fireEvent.click(add);
    expect(await screen.findByText("Enter the address or device token to register.")).toBeTruthy();
    expect(writes()).toBe(0);

    fireEvent.change(screen.getByLabelText(/^Address or device token/), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    const verify = await screen.findByRole("button", { name: "Verify me@example.com" });
    expect(verify.hasAttribute("disabled")).toBe(false);
    const before = writes();
    fireEvent.click(verify);
    expect(await screen.findByText("Enter the verification code that was sent.")).toBeTruthy();
    expect(writes()).toBe(before);
  });

  it("channel members: an empty user id is explained and not posted", async () => {
    mount(
      (method) => (method === "GET" ? json(200, { members: [] }) : json(204, null)),
      ChannelMembers,
      `/m/${ID}`,
      "/m/:id",
    );
    const add = await screen.findByRole("button", { name: "Add member" });
    expect(add.hasAttribute("disabled")).toBe(false);
    fireEvent.click(add);
    expect(await screen.findByText("Enter the user id to add.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^User ID/)));
    expect(writes()).toBe(0);
  });

  it("plan editor: an empty meter event type is explained and not posted", async () => {
    mount(
      (method) =>
        method === "GET"
          ? json(200, {
              id: ID,
              slug: "starter",
              name: "Starter",
              tier: "standard",
              cadence: "monthly",
              basePriceCents: 1000,
              trialPeriodDays: 0,
              stripeProductId: null,
              stripePriceId: null,
              currencyCode: "USD",
              isActive: false,
              meters: [],
            })
          : json(200, {}),
      PlanEdit,
      `/admin/plans/${ID}/edit`,
      "/admin/plans/:id/edit",
    );
    const add = await screen.findByRole("button", { name: "Add meter" });
    expect(add.hasAttribute("disabled")).toBe(false);
    fireEvent.click(add);
    expect(await screen.findByText("Enter the event type to meter.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^Event type/)));
    expect(writes()).toBe(0);
  });

  it("refund approval: Deny without a reason is explained and not posted", async () => {
    mount(
      (method) =>
        method === "GET"
          ? json(200, {
              id: ID,
              organizationId: ID,
              organizationName: "Cedar Hospice",
              status: "requested",
              kind: "partial",
              reasonCode: "duplicate_charge",
              requestedAt: "2026-10-01T00:00:00Z",
              requestedByMembershipId: ID,
              amountCents: 2500,
              currencyCode: "USD",
            })
          : json(200, {}),
      RefundApprove,
      `/admin/refunds/${ID}`,
      "/admin/refunds/:id",
    );
    const deny = await screen.findByRole("button", { name: "Deny refund" });
    expect(deny.hasAttribute("disabled")).toBe(false);
    fireEvent.click(deny);
    expect(await screen.findByText("Say why this refund is being denied.")).toBeTruthy();
    await waitFor(() => expect(focusedId()).toBe("deny-reason"));
    expect(writes()).toBe(0);
  });

  it("signup triage: Qualify without an admin name is explained and not posted", async () => {
    const intent = {
      id: "intent-1",
      contactEmail: "a@cedar.example",
      legalBusinessName: "Cedar Ridge",
      intendedFirstAdminEmail: "b@cedar.example",
      intentStatus: "new",
      source: "self_serve_form",
      rejectionReason: null,
      receivedAt: "2026-01-01T00:00:00.000Z",
      processedAt: null,
      tenantAccountId: null,
    };
    mount(
      () => json(200, { items: [intent], nextCursor: null, hasMore: false }),
      Signups,
      "/signups?intent=intent-1",
    );
    const qualify = await screen.findByRole("button", { name: "Qualify" });
    expect(qualify.hasAttribute("disabled")).toBe(false);
    fireEvent.click(qualify);
    expect(await screen.findByText("Enter the first admin's full name.")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText(/^First admin full name/)),
    );
    expect(writes()).toBe(0);
  });

  it("onboarding template: Add with nothing filled names each field and posts nothing", async () => {
    mount(
      () => json(200, { items: [], nextCursor: null, hasMore: false }),
      OnboardingTemplates,
      "/onboarding/templates",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add template" }));
    const save = await screen.findAllByRole("button", { name: "Add template" });
    fireEvent.click(save[save.length - 1] as HTMLElement);
    expect(await screen.findByText("Enter a template key, e.g. baa_signed.")).toBeTruthy();
    expect(screen.getByText("Enter the step title.")).toBeTruthy();
    expect(screen.getByText("Enter the step order.")).toBeTruthy();
    expect(writes()).toBe(0);
  });
});
