// @vitest-environment jsdom
// The overview's "Transition status" and "Open onboarding" buttons rendered with no handler: suspend / resume /
// activate and the platform onboarding view were unreachable from the console.
import { fireEvent, render, screen } from "@testing-library/react";
import { ApiClientProvider, ToastProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TenantOverview } from "./tenant-overview";

const TENANT = {
  id: "t-1",
  organizationId: "o-1",
  orgSlug: "cedar-ridge",
  legalBusinessName: "Cedar Ridge Hospice LLC",
  status: "onboarding",
  planLabel: "Enterprise",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  latestStatusEvent: null,
  keyRing: { currentDekVersion: "v1", dekLastRotatedAt: null, destroyedAt: null },
  onboarding: { totalTasks: 11, doneTasks: 3, currentStep: "ccn_registered" },
  baa: null,
  activeGrants: 0,
  activeSessions: 0,
};

function Where(): null {
  const { pathname } = useLocation();
  document.title = pathname;
  return null;
}

function mount(): void {
  window.history.pushState({}, "", "/tenants/cedar-ridge");
  const client = { GET: vi.fn(async () => ({ data: TENANT })), POST: vi.fn() };
  render(
    <MemoryRouter initialEntries={["/tenants/cedar-ridge"]}>
      <ApiClientProvider client={client as unknown as ApiClient}>
        <ToastProvider>
          <Where />
          <Routes>
            <Route path="/tenants/:orgSlug" element={<TenantOverview />} />
            <Route path="/tenants/:orgSlug/onboarding" element={<p>onboarding screen</p>} />
          </Routes>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("TenantOverview lifecycle actions", () => {
  it("Transition status opens the dialog for the tenant's current status", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /transition status/i }));

    expect(await screen.findByRole("button", { name: /activate tenant/i })).toBeTruthy();
  });

  it("Open onboarding goes to the tenant's onboarding screen", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /open onboarding/i }));

    expect(await screen.findByText("onboarding screen")).toBeTruthy();
    expect(document.title).toBe("/tenants/cedar-ridge/onboarding");
  });
});
