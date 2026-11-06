// @vitest-environment jsdom
// The tenant list shows where each tenant is in onboarding (the retired plan tier is gone: the plan is a contract signed at step 2),
// and a tenant waiting for this operator's approval says so. The drawer's primary action is the next thing to do.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TenantInventory } from "./tenant-inventory";

const row = (slug: string, status: string, progress: Record<string, unknown> | null) => ({
  id: `id-${slug}`,
  organizationId: `org-${slug}`,
  orgSlug: slug,
  legalBusinessName: `${slug} Hospice`,
  status,
  planLabel: "unassigned",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  onboardingProgress: progress,
});
const ROWS = [
  row("cedar", "onboarding", {
    doneCount: 7,
    totalCount: 13,
    currentStepKey: "locations_seeded",
    goLiveState: "not_ready",
  }),
  row("birch", "onboarding", {
    doneCount: 13,
    totalCount: 13,
    currentStepKey: "go_live_checklist_complete",
    goLiveState: "awaiting_approval",
  }),
  row("oak", "active", {
    doneCount: 13,
    totalCount: 13,
    currentStepKey: null,
    goLiveState: "live",
  }),
  row("fir", "provisioning", {
    doneCount: 0,
    totalCount: 13,
    currentStepKey: "account_created",
    goLiveState: "closed",
  }),
  row("elm", "suspended", null),
];

function Where(): null {
  document.title = useLocation().pathname;
  return null;
}
function mount(url = "/tenants") {
  const GET = vi.fn(async () => ({ data: { items: ROWS, nextCursor: null, hasMore: false } }));
  render(
    <MemoryRouter initialEntries={[url]}>
      <ApiClientProvider client={{ GET } as unknown as ApiClient}>
        <ToastProvider>
          <Where />
          <Routes>
            <Route path="/tenants" element={<TenantInventory />} />
            <Route path="/tenants/:orgSlug" element={<p>hub</p>} />
            <Route path="/tenants/:orgSlug/onboarding" element={<p>wizard</p>} />
            <Route path="/tenants/:orgSlug/onboarding/:stepKey" element={<p>wizard step</p>} />
          </Routes>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return GET;
}
// A name can appear in the attention strip as well as in its row: the row is the one inside a table.
const rowOf = (name: string): HTMLElement =>
  screen
    .getAllByText(`${name} Hospice`)
    .map((el) => el.closest("tr"))
    .find((tr): tr is HTMLTableRowElement => tr !== null) as HTMLElement;

describe("TenantInventory: onboarding progress", () => {
  it("has an Onboarding column and no Plan column", async () => {
    mount();
    const table = await screen.findByRole("table", { name: "Tenants" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toContain("Onboarding");
    expect(headers).not.toContain("Plan");
  });

  it("shows how far an onboarding tenant is and what is next", async () => {
    mount();
    await screen.findByText("cedar Hospice");
    expect(within(rowOf("cedar")).getByText("7 of 13 steps")).toBeTruthy();
    expect(within(rowOf("cedar")).getByText("Next: Locations seeded")).toBeTruthy();
  });

  it("flags a go-live waiting for approval", async () => {
    mount();
    await screen.findAllByText("birch Hospice");
    expect(within(rowOf("birch")).getByText("Awaiting your approval")).toBeTruthy();
  });

  it("says a live tenant is live, a provisioning one is being set up, and shows nothing for the rest", async () => {
    mount();
    await screen.findByText("oak Hospice");
    expect(within(rowOf("oak")).getByText("Live")).toBeTruthy();
    expect(within(rowOf("fir")).getByText("Setting up the tenant")).toBeTruthy();
    expect(within(rowOf("elm")).queryByText(/steps/)).toBeNull();
  });

  it("lists the tenants waiting for this operator's approval above the table, each a link to its go-live step", async () => {
    mount();
    const strip = await screen.findByRole("region", { name: "Needs your attention" });
    expect(within(strip).getByText(/1 tenant is waiting for your go-live approval/)).toBeTruthy();
    fireEvent.click(within(strip).getByRole("button", { name: "Review go-live: birch Hospice" }));
    expect(await screen.findByText("wizard step")).toBeTruthy();
    expect(document.title).toBe("/tenants/birch/onboarding/go_live_checklist_complete");
  });

  it("the drawer of an onboarding tenant continues its onboarding", async () => {
    mount("/tenants?tenant=cedar");
    const drawer = await screen.findByRole("complementary", { name: "Tenant" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Continue onboarding" }));
    expect(await screen.findByText("wizard")).toBeTruthy();
    expect(document.title).toBe("/tenants/cedar/onboarding");
  });

  it("the drawer of a tenant waiting for approval goes straight to the go-live step", async () => {
    mount("/tenants?tenant=birch");
    const drawer = await screen.findByRole("complementary", { name: "Tenant" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Review go-live" }));
    expect(await screen.findByText("wizard step")).toBeTruthy();
    expect(document.title).toBe("/tenants/birch/onboarding/go_live_checklist_complete");
  });

  it("a live tenant's drawer opens the tenant, not the wizard", async () => {
    mount("/tenants?tenant=oak");
    const drawer = await screen.findByRole("complementary", { name: "Tenant" });
    expect(within(drawer).queryByRole("button", { name: "Continue onboarding" })).toBeNull();
    fireEvent.click(within(drawer).getByRole("button", { name: "Open tenant" }));
    expect(await screen.findByText("hub")).toBeTruthy();
  });
});
