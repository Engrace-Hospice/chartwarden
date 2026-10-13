// @vitest-environment jsdom
// The overview's "Open onboarding" button went nowhere, and GET /platform/tenants/{slug}/onboarding plus
// POST .../onboarding/{taskId}/skip had no consumer, so platform ops could not see which step blocked a tenant
// from activating, nor skip one. This screen lists the tasks in canonical order and skips with a rationale.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TenantOnboarding } from "./tenant-onboarding";

const task = (over: Record<string, unknown>) => ({
  id: "task-1",
  templateKey: "account_created",
  status: "done",
  isCanonical: true,
  canonicalOrder: 1,
  dueAt: null,
  startedAt: null,
  completedAt: null,
  blockerReason: null,
  skipRationale: null,
  ...over,
});

const ONBOARDING = {
  tenantAccountId: "t-1",
  orgSlug: "cedar-ridge",
  tenantStatus: "onboarding",
  currentStep: "ccn_registered",
  tasks: [
    task({ id: "task-2", templateKey: "ccn_registered", status: "pending", canonicalOrder: 2 }),
    task({}),
    task({
      id: "task-3",
      templateKey: "xero_connected",
      status: "blocked",
      canonicalOrder: 3,
      blockerReason: "Awaiting Xero consent",
    }),
  ],
};

function renderScreen(client: unknown): void {
  render(
    <MemoryRouter initialEntries={["/tenants/cedar-ridge/onboarding"]}>
      <ApiClientProvider client={client as ApiClient}>
        <Routes>
          <Route path="/tenants/:orgSlug/onboarding" element={<TenantOnboarding />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("TenantOnboarding", () => {
  it("lists the tasks in canonical order with their status and blocker", async () => {
    const GET = vi.fn(async () => ({ data: ONBOARDING }));
    renderScreen({ GET, POST: vi.fn() });

    const rows = await screen.findAllByRole("row");
    const body = rows.slice(1).map((r) => r.textContent ?? "");
    expect(body[0]).toMatch(/account_created/);
    expect(body[1]).toMatch(/ccn_registered/);
    expect(body[2]).toMatch(/Awaiting Xero consent/);
    expect(GET).toHaveBeenCalledWith("/api/v1/platform/tenants/{orgSlug}/onboarding", {
      params: { path: { orgSlug: "cedar-ridge" } },
    });
  });

  it("skips an unsettled task with a recorded rationale and reloads", async () => {
    const GET = vi.fn(async () => ({ data: ONBOARDING }));
    const POST = vi.fn(async () => ({ data: task({ id: "task-2", status: "skipped" }) }));
    renderScreen({ GET, POST });

    const row = (await screen.findByText("ccn_registered")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /skip/i }));
    fireEvent.change(screen.getByLabelText(/rationale/i), {
      target: { value: "Provider has no CCN yet" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm skip/i }));

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith(
        "/api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/skip",
        {
          params: { path: { orgSlug: "cedar-ridge", taskId: "task-2" } },
          body: { skipRationale: "Provider has no CCN yet" },
        },
      ),
    );
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });

  it("refuses a too-short rationale without sending a request", async () => {
    const POST = vi.fn();
    renderScreen({ GET: vi.fn(async () => ({ data: ONBOARDING })), POST });

    const row = (await screen.findByText("ccn_registered")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /skip/i }));
    fireEvent.change(screen.getByLabelText(/rationale/i), { target: { value: "no" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm skip/i }));

    expect(screen.getByRole("alert").textContent).toMatch(/at least 8/i);
    expect(POST).not.toHaveBeenCalled();
  });

  it("offers no skip on a settled task", async () => {
    renderScreen({ GET: vi.fn(async () => ({ data: ONBOARDING })), POST: vi.fn() });

    const row = (await screen.findByText("account_created")).closest("tr") as HTMLElement;

    expect(within(row).queryByRole("button", { name: /skip/i })).toBeNull();
  });

  it("a failed load says so and offers a retry, not a 'not found'", async () => {
    const GET = vi.fn().mockRejectedValueOnce(new Error("offline"));
    GET.mockResolvedValueOnce({ data: ONBOARDING });
    renderScreen({ GET, POST: vi.fn() });

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not load/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText("account_created")).toBeTruthy();
  });
});
