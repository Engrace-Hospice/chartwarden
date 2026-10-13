// @vitest-environment jsdom
// After "Provision tenant" returns 202 the operator used to learn nothing: no progress, no failure, no retry — a
// failed `tenant.provision` job left the tenant in `provisioning` indefinitely. The card shows the job's state,
// polls while it is in flight, and offers a retry when it has failed.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { ProvisioningCard } from "./provisioning-card";

const status = (
  state: string,
  extra: Record<string, unknown> = {},
  tenantStatus = "provisioning",
) => ({
  data: {
    tenantAccountId: "t-1",
    orgSlug: "cedar-ridge",
    tenantStatus,
    job: { state, attemptsMade: 0, failedReason: null, ...extra },
  },
});

function mount(client: unknown, onChanged = vi.fn(), pollMs = 10_000): typeof onChanged {
  render(
    <ApiClientProvider client={client as ApiClient}>
      <ProvisioningCard orgSlug="cedar-ridge" onChanged={onChanged} pollMs={pollMs} />
    </ApiClientProvider>,
  );
  return onChanged;
}

describe("ProvisioningCard", () => {
  it.each([
    ["queued", /queued/i],
    ["running", /running/i],
  ])("shows a %s job as in progress", async (state, label) => {
    mount({ GET: vi.fn(async () => status(state)), POST: vi.fn() });

    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("polls while the job is in flight", async () => {
    const GET = vi.fn(async () => status("running"));
    mount({ GET, POST: vi.fn() }, vi.fn(), 20);

    await waitFor(() => expect(GET.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("shows why a failed job failed and offers a retry that re-polls", async () => {
    const GET = vi
      .fn()
      .mockResolvedValueOnce(status("failed", { failedReason: "gateway 503", attemptsMade: 8 }))
      .mockResolvedValue(status("queued"));
    const POST = vi.fn(async () => ({ data: { tenantAccountId: "t-1", state: "queued" } }));
    mount({ GET, POST });

    expect((await screen.findByRole("alert")).textContent).toMatch(/gateway 503/);
    fireEvent.click(screen.getByRole("button", { name: /retry provisioning/i }));

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/api/v1/platform/tenants/{orgSlug}/provision/retry", {
        params: { path: { orgSlug: "cedar-ridge" } },
      }),
    );
    expect(await screen.findByText(/queued/i)).toBeTruthy();
  });

  it("keeps the failure visible and says why when the retry is refused", async () => {
    const GET = vi.fn(async () => status("failed", { failedReason: "gateway 503" }));
    const POST = vi.fn(async () => ({
      error: { error: { message: "the provisioning job is 'running', not failed" } },
    }));
    mount({ GET, POST });

    fireEvent.click(await screen.findByRole("button", { name: /retry provisioning/i }));

    expect(await screen.findByText(/not failed/i)).toBeTruthy();
  });

  it("tells the parent when provisioning has finished so the overview refreshes", async () => {
    const onChanged = mount({
      GET: vi.fn(async () => status("completed", {}, "onboarding")),
      POST: vi.fn(),
    });

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("says a provisioning tenant with no job needs attention", async () => {
    mount({ GET: vi.fn(async () => status("missing")), POST: vi.fn() });

    expect((await screen.findByRole("alert")).textContent).toMatch(/no provisioning job/i);
  });

  it("a failed status read is reported, not shown as a job state, and can be retried", async () => {
    const GET = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(status("running"));
    mount({ GET, POST: vi.fn() });

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not load/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText(/provisioning is running/i)).toBeTruthy();
  });
});
