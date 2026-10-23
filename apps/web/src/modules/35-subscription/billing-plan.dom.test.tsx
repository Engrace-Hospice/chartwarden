// F-024 (#591) - the plan picker says so when the current-plan read is refused or fails (jsdom).
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BillingPlan } from "./billing-plan";

const PLANS = "/api/v1/plans";
const SUB = "/api/v1/subscription";
const PLAN = {
  slug: "pro",
  name: "Pro",
  description: null,
  tier: "pro",
  cadence: "monthly",
  basePriceCents: 1000,
  currencyCode: "USD",
  trialPeriodDays: 0,
  meters: [],
};
const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } });
const failure = (status: number) => ({
  data: undefined,
  error: { title: "boom" },
  response: { status },
});

function mount(replies: Record<string, unknown>) {
  const get = vi.fn((path: string) => Promise.resolve(replies[path]));
  render(
    <ApiClientProvider client={{ GET: get } as unknown as ApiClient}>
      <MemoryRouter>
        <BillingPlan />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return get;
}

describe("Billing plan read states", () => {
  it("shows a spinner while loading", () => {
    mount({ [PLANS]: ok([PLAN]), [SUB]: ok({ planSlug: "pro" }) });
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows the Current chip and no note when both reads succeed", async () => {
    mount({ [PLANS]: ok([PLAN]), [SUB]: ok({ planSlug: "pro" }) });
    await screen.findByText("pro", { selector: "code" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the genuine empty copy when the catalog is empty", async () => {
    mount({ [PLANS]: ok([]), [SUB]: ok({ planSlug: "pro" }) });
    await screen.findByText("No plans");
  });

  it("explains a 403 on the current plan, without retry or permission codes", async () => {
    mount({ [PLANS]: ok([PLAN]), [SUB]: failure(403) });
    await screen.findByText(/do not have permission to view your current plan/);
    expect(screen.queryByText("Current")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("explains a 503 on the current plan and retries", async () => {
    const replies: Record<string, unknown> = { [PLANS]: ok([PLAN]), [SUB]: failure(503) };
    mount(replies);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText(/current plan could not be loaded/)).toBeTruthy();
    replies[SUB] = ok({ planSlug: "pro" });
    fireEvent.click(retry);
    await screen.findByText("pro", { selector: "code" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
