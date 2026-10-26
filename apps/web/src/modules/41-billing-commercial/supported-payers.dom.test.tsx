// The supported-payers view (issue #726): plans with the payer name, filing indicator, route and enrollment, "not enrolled" as a
// first-class state, the plan drawer, and the error and empty states. Synthetic data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Call,
  ENTITY_ID,
  PAYER_ID,
  PLAN_ID,
  type Responder,
  entitiesRoute,
  mountScreen,
  payerNameRoute,
} from "./commercial-test-harness";
import { SupportedPayers } from "./supported-payers";

const plan = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: PLAN_ID,
  payerId: PAYER_ID,
  planName: "Synthetic PPO",
  claimFilingIndicator: "CI",
  authorizationRequirement: "required_at_admission",
  authorizationLeadDays: 3,
  eligibilityStalenessPolicy: "block",
  eligibilityMaxAgeDays: 30,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  payerStatus: "active",
  routes: [
    {
      clearinghouseKey: "stedi",
      clearinghousePayerId: "SYNTH01",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    },
  ],
  ...over,
});
const enrollment = (status: string): Record<string, unknown> => ({
  id: "77777777-7777-4777-8777-777777777777",
  providerEntityId: ENTITY_ID,
  payerId: PAYER_ID,
  clearinghouseKey: "stedi",
  status,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  evidenceRef: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function mount(
  plans: Responder,
  enrollments: Responder,
  calls: Call[] = [],
): ReturnType<typeof mountScreen> {
  return mountScreen({
    routes: {
      "GET /api/v1/provider-entities": entitiesRoute,
      "GET /api/v1/billing/commercial/payer-plans": plans,
      "GET /api/v1/billing/commercial/enrollments": enrollments,
      [`GET /api/v1/mdm/payer/${PAYER_ID}`]: payerNameRoute,
    },
    calls,
    element: <SupportedPayers />,
    routePath: "/commercial/billing/payers",
    entry: "/commercial/billing/payers",
  });
}

afterEach(cleanup);

describe("SupportedPayers", () => {
  it("lists the plan under the payer's name with filing indicator, route and enrollment", async () => {
    const calls: Call[] = [];
    mount(
      () => ({ body: { items: [plan()] } }),
      () => ({ body: { items: [enrollment("enrolled")] } }),
      calls,
    );
    await screen.findByText("Synthetic Health Plan");
    const row = screen.getByText("Synthetic Health Plan").closest("tr") as HTMLElement;
    expect(within(row).getByText("Synthetic PPO")).toBeTruthy();
    expect(within(row).getByText("CI · Commercial insurance")).toBeTruthy();
    expect(within(row).getByText("stedi: SYNTH01")).toBeTruthy();
    expect(within(row).getByText("Enrolled")).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith("/payer-plans"))?.query.get("providerEntityId")).toBe(
      ENTITY_ID,
    );
  });

  it("shows 'Not enrolled' when no enrollment exists, rather than a blank", async () => {
    mount(
      () => ({ body: { items: [plan()] } }),
      () => ({ body: { items: [] } }),
    );
    const row = (await screen.findByText("Synthetic PPO")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Not Enrolled")).toBeTruthy();
  });

  it("links a not-enrolled plan's drawer to the enrollments screen, and not an enrolled one's", async () => {
    mount(
      () => ({ body: { items: [plan()] } }),
      () => ({ body: { items: [] } }),
    );
    fireEvent.click((await screen.findByText("Synthetic PPO")).closest("tr") as HTMLElement);
    const link = await screen.findByRole("link", { name: "Manage enrollments" });
    expect(link.getAttribute("href")).toBe(
      `/commercial/billing/enrollments?entity=${encodeURIComponent(ENTITY_ID)}`,
    );
    cleanup();
    mount(
      () => ({ body: { items: [plan()] } }),
      () => ({ body: { items: [enrollment("enrolled")] } }),
    );
    fireEvent.click((await screen.findByText("Synthetic PPO")).closest("tr") as HTMLElement);
    await screen.findByText("Can we send?");
    expect(screen.queryByRole("link", { name: "Manage enrollments" })).toBeNull();
  });

  it("flags a plan with no clearinghouse route", async () => {
    mount(
      () => ({ body: { items: [plan({ routes: [] })] } }),
      () => ({ body: { items: [] } }),
    );
    const row = (await screen.findByText("Synthetic PPO")).closest("tr") as HTMLElement;
    expect(within(row).getByText("No route")).toBeTruthy();
  });

  it("opens a drawer with the plan rules on Enter and closes it again", async () => {
    mount(
      () => ({ body: { items: [plan({ payerStatus: "merged" })] } }),
      () => ({ body: { items: [enrollment("pending")] } }),
    );
    const row = (await screen.findByText("Synthetic PPO")).closest("tr") as HTMLElement;
    fireEvent.keyDown(row, { key: "Enter" });
    const drawer = await screen.findByRole("complementary", { name: /Synthetic PPO/ });
    expect(within(drawer).getByText("Required at admission")).toBeTruthy();
    expect(within(drawer).getByText("Merged")).toBeTruthy();
    expect(within(drawer).getByText(/Blocks when older than 30 days/)).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "Close plan details" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: /Synthetic PPO/ })).toBeNull(),
    );
  });

  it("falls back to a short payer id when the name cannot be read", async () => {
    mountScreen({
      routes: {
        "GET /api/v1/provider-entities": entitiesRoute,
        "GET /api/v1/billing/commercial/payer-plans": () => ({ body: { items: [plan()] } }),
        "GET /api/v1/billing/commercial/enrollments": () => ({ body: { items: [] } }),
      },
      calls: [],
      element: <SupportedPayers />,
      routePath: "/commercial/billing/payers",
      entry: "/commercial/billing/payers",
    });
    await screen.findByText(`Payer ${PAYER_ID.slice(0, 8)}`);
  });

  it("announces a load failure and retries", async () => {
    let attempt = 0; // call 1 is the default-entity probe, call 2 the page read
    mount(
      () => (++attempt === 2 ? { status: 500, body: {} } : { body: { items: [plan()] } }),
      () => ({ body: { items: [] } }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Supported payers unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Synthetic PPO");
  });

  it("explains an empty plan list", async () => {
    mount(
      () => ({ body: { items: [] } }),
      () => ({ body: { items: [] } }),
    );
    await screen.findByText("No commercial payer plans");
  });
});
