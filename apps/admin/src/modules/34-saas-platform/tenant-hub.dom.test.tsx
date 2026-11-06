// @vitest-environment jsdom
// The tenant hub (the overview): where a tenant stands, and the one next thing to do. For an onboarding tenant that is "continue
// onboarding" (or, when the compliance officer has attested, "approve go-live"); the contract is a lazy card because each read of a
// tenant's pricing is audited; a DEK rotation says why. The tenant's slug comes from the route, not from the browser address.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantOverview } from "./tenant-overview";

const SLUG = "cedar-ridge";
const tenant = (over: Record<string, unknown> = {}) => ({
  id: "t-1",
  organizationId: "o-1",
  orgSlug: SLUG,
  legalBusinessName: "Cedar Ridge Hospice LLC",
  status: "onboarding",
  planLabel: "unassigned",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  onboardingProgress: {
    doneCount: 7,
    totalCount: 13,
    currentStepKey: "locations_seeded",
    goLiveState: "not_ready",
  },
  latestStatusEvent: null,
  keyRing: { currentDekVersion: "v1", dekLastRotatedAt: null, destroyedAt: null },
  onboarding: { totalTasks: 13, doneTasks: 7, currentStep: "locations_seeded" },
  baa: null,
  activeGrants: 0,
  activeSessions: 0,
  ...over,
});
const CONTRACT = {
  subscriptionId: "sub-1",
  plan: {
    id: "p-1",
    slug: "standard-bands-v2",
    name: "Standard census bands",
    version: 2,
    currencyCode: "USD",
  },
  billingServiceMode: "billing_software",
  billingBps: 100,
  pendingBillingServiceMode: null,
  contractStartOn: "2026-11-01",
  contractTermMonths: 12,
  contractEndsOn: "2027-10-31",
  perUserPriceCents: 4900,
  bands: [{ minAdc: 0, maxAdc: null, monthlyFeeCents: 49900 }],
  billingSoftwareBps: 100,
  managedBillingBps: 400,
  implementationFeeCents: 250000,
  minimumMonthlyCents: null,
  signedByMembershipId: "m-1",
  signedReason: "Order form countersigned",
  orderFormRef: null,
};
const SUB = "/api/v1/platform/tenants/{orgSlug}/subscription";
const OVERVIEW = "/api/v1/platform/tenants/{orgSlug}";
const DEK = "/api/v1/platform/tenants/{orgSlug}/dek-rotate";

function Where(): null {
  document.title = useLocation().pathname;
  return null;
}
function mount(
  over: Record<string, unknown> = {},
  extra: Record<string, (init: unknown) => unknown> = {},
) {
  // The browser address is NOT the route: the screen must read the slug from the router.
  window.history.pushState({}, "", "/somewhere/else/entirely");
  const handlers: Record<string, (init: unknown) => unknown> = {
    [OVERVIEW]: () => ({ data: tenant(over) }),
    [SUB]: () => ({ data: { contract: CONTRACT, statements: [] } }),
    ...extra,
  };
  const dispatch = vi.fn(
    async (path: string, init: unknown) => handlers[path]?.(init) ?? { data: {} },
  );
  const client = {
    GET: dispatch,
    POST: dispatch,
    PUT: dispatch,
    PATCH: dispatch,
    DELETE: dispatch,
  };
  render(
    <MemoryRouter initialEntries={[`/tenants/${SLUG}`]}>
      <ApiClientProvider client={client as unknown as ApiClient}>
        <ToastProvider>
          <Where />
          <Routes>
            <Route path="/tenants/:orgSlug" element={<TenantOverview />} />
            <Route path="/tenants/:orgSlug/onboarding" element={<p>wizard</p>} />
            <Route path="/tenants/:orgSlug/onboarding/:stepKey" element={<p>wizard step</p>} />
          </Routes>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return client;
}
beforeEach(() => window.sessionStorage.clear());

describe("TenantOverview: header", () => {
  it("names the tenant and its slug, and no longer shows the retired plan tier", async () => {
    mount();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Cedar Ridge Hospice LLC" }),
    ).toBeTruthy();
    expect(screen.queryByText(/unassigned/i)).toBeNull();
    expect(screen.queryByText(/enterprise|starter|standard$/i)).toBeNull();
  });
});

describe("TenantOverview: onboarding card", () => {
  it("shows how far the tenant is and continues the wizard", async () => {
    mount();
    expect(await screen.findByText("7 of 13 steps done")).toBeTruthy();
    expect(screen.getByText(/Next: Locations seeded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue onboarding" }));
    expect(await screen.findByText("wizard")).toBeTruthy();
    expect(document.title).toBe(`/tenants/${SLUG}/onboarding`);
  });

  it("calls out a go-live waiting for this operator's approval, and goes straight to it", async () => {
    mount({
      onboardingProgress: {
        doneCount: 13,
        totalCount: 13,
        currentStepKey: "go_live_checklist_complete",
        goLiveState: "awaiting_approval",
      },
    });
    expect(await screen.findByText(/Waiting for your approval/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review go-live" }));
    expect(await screen.findByText("wizard step")).toBeTruthy();
    expect(document.title).toBe(`/tenants/${SLUG}/onboarding/go_live_checklist_complete`);
  });

  it("falls back to the older counts when the progress is not there", async () => {
    mount({ onboardingProgress: null });
    expect(await screen.findByText("7 of 13 steps done")).toBeTruthy();
  });

  it("says a live tenant has finished onboarding", async () => {
    mount({
      status: "active",
      onboardingProgress: {
        doneCount: 13,
        totalCount: 13,
        currentStepKey: null,
        goLiveState: "live",
      },
    });
    expect(await screen.findByText(/Onboarding is complete/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue onboarding" })).toBeNull();
  });
});

describe("TenantOverview: lifecycle", () => {
  it("does not offer to activate an onboarding tenant: the dialog points at the wizard", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /transition status/i }));
    const dialog = await screen.findByRole("dialog", { name: "Transition status" });
    expect(within(dialog).queryByRole("button", { name: /activate tenant/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open onboarding" }));
    expect(await screen.findByText("wizard")).toBeTruthy();
  });
});

describe("TenantOverview: contract and billing", () => {
  it("reads the contract only when asked (each read of a tenant's pricing is audited)", async () => {
    const client = mount();
    await screen.findByRole("heading", { level: 1, name: "Cedar Ridge Hospice LLC" });
    expect(client.GET.mock.calls.filter((c) => c[0] === SUB)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show contract and billing" }));
    expect(await screen.findByText("Standard census bands")).toBeTruthy();
    expect(client.GET.mock.calls.filter((c) => c[0] === SUB)).toHaveLength(1);
  });

  it("says there is no contract yet", async () => {
    mount({}, { [SUB]: () => ({ data: { contract: null, statements: [] } }) });
    fireEvent.click(await screen.findByRole("button", { name: "Show contract and billing" }));
    expect(await screen.findByText(/No contract is signed yet/)).toBeTruthy();
  });

  it("shows a failed read with a retry", async () => {
    mount(
      {},
      {
        [SUB]: () => ({
          error: { error: { code: "INTERNAL_ERROR", message: "x" } },
          response: { status: 500 },
        }),
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Show contract and billing" }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("TenantOverview: key rotation", () => {
  it("asks why before it rotates, and records the operator's own reason (not a canned one)", async () => {
    const client = mount({}, { [DEK]: () => ({ data: { jobId: "j-1" } }) });
    fireEvent.click(await screen.findByRole("button", { name: "Rotate DEK" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Quarterly key rotation, ticket CHG-77" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(client.POST.mock.calls.some((c) => c[0] === DEK)).toBe(true));
    const call = client.POST.mock.calls.find((c) => c[0] === DEK) as unknown as [
      string,
      { body: unknown },
    ];
    expect(call[1].body).toEqual({ reason: "Quarterly key rotation, ticket CHG-77" });
    // one key per attempt: a retry after no answer must replay, not enqueue a second rotation job
    expect((call[1] as { headers?: Record<string, string> }).headers?.["Idempotency-Key"]).toMatch(
      /\S/,
    );
  });

  it("will not rotate on a reason that is too short", async () => {
    const client = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rotate DEK" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "now" } });
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toMatch(/at least 8/);
    expect(client.POST.mock.calls.some((c) => c[0] === DEK)).toBe(false);
  });
});
