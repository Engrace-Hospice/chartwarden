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
  // A reply may be a function (called per request) so a test can reject a request.
  const get = vi.fn((path: string) => {
    const reply = replies[path];
    return typeof reply === "function" ? reply() : Promise.resolve(reply);
  });
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
    // The cause is an unconfigured platform catalog, not the account: say so and point at support.
    expect(screen.getByText(/plan catalog has not been set up yet/)).toBeTruthy();
    expect(screen.queryByText(/available for your account/)).toBeNull();
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

  it("shows a denied state, not 'Unavailable', when the plan catalog is 403", async () => {
    mount({ [PLANS]: failure(403), [SUB]: ok({ planSlug: "pro" }) });
    await screen.findByText("You do not have access");
    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows a retryable failure for the plan catalog and recovers", async () => {
    const replies: Record<string, unknown> = {
      [PLANS]: failure(500),
      [SUB]: ok({ planSlug: "pro" }),
    };
    mount(replies);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText("Unavailable")).toBeNull();
    replies[PLANS] = ok([PLAN]);
    fireEvent.click(retry);
    await screen.findByText("pro", { selector: "code" });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows a failed state, not a stuck spinner, when a request is rejected", async () => {
    mount({ [PLANS]: () => Promise.reject(new Error("network")), [SUB]: ok({ planSlug: "pro" }) });
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not throw on a 2xx subscription with an empty body", async () => {
    mount({ [PLANS]: ok([PLAN]), [SUB]: ok(undefined) });
    await screen.findByText("Pro");
    expect(screen.queryByText("Current")).toBeNull();
  });
});
