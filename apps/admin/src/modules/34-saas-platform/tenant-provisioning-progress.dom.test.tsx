// @vitest-environment jsdom
// A tenant in `provisioning` used to stay stale in the list until a manual reload, and its overview said nothing
// about the job. The list refreshes itself while any tenant is provisioning, and the overview shows the
// provisioning card (job state + retry) for a provisioning tenant only.
import { render, screen } from "@testing-library/react";
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantInventory } from "./tenant-inventory";
import { TenantOverview } from "./tenant-overview";

const summary = (status: string) => ({
  id: "t-1",
  organizationId: "o-1",
  orgSlug: "cedar-ridge",
  legalBusinessName: "Cedar Ridge Hospice LLC",
  status,
  planLabel: "standard",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const overview = (status: string) => ({
  ...summary(status),
  latestStatusEvent: null,
  keyRing: null,
  onboarding: { totalTasks: 0, doneTasks: 0, currentStep: null },
  baa: null,
  activeGrants: 0,
  activeSessions: 0,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("tenant list polling", () => {
  it("refreshes while a tenant is provisioning and stops once none is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const page = (status: string) => ({
      data: { items: [summary(status)], nextCursor: null, hasMore: false },
    });
    const GET = vi
      .fn()
      .mockResolvedValueOnce(page("provisioning"))
      .mockResolvedValue(page("onboarding"));
    render(
      <MemoryRouter initialEntries={["/tenants"]}>
        <ApiClientProvider client={{ GET } as unknown as ApiClient}>
          <TenantInventory />
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Cedar Ridge Hospice LLC");
    await vi.advanceTimersByTimeAsync(5500);
    const afterRefresh = GET.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(afterRefresh).toBe(2);
    expect(GET.mock.calls.length).toBe(afterRefresh);
  });
});

describe("tenant overview provisioning card", () => {
  function mount(status: string) {
    const GET = vi.fn(async (path: string) =>
      path.endsWith("/provision-status")
        ? {
            data: {
              tenantAccountId: "t-1",
              orgSlug: "cedar-ridge",
              tenantStatus: status,
              job: { state: "running", attemptsMade: 1, failedReason: null },
            },
          }
        : { data: overview(status) },
    );
    window.history.pushState({}, "", "/tenants/cedar-ridge");
    render(
      <MemoryRouter initialEntries={["/tenants/cedar-ridge"]}>
        <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
          <ToastProvider>
            <Routes>
              <Route path="/tenants/:orgSlug" element={<TenantOverview />} />
            </Routes>
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
  }

  it("shows the job state for a provisioning tenant", async () => {
    mount("provisioning");

    expect(await screen.findByText(/provisioning is running/i)).toBeTruthy();
  });

  it("shows no provisioning card once the tenant is past provisioning", async () => {
    mount("onboarding");

    await screen.findByText("Cedar Ridge Hospice LLC");
    expect(screen.queryByText(/provisioning is/i)).toBeNull();
  });
});
