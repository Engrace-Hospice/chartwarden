// @vitest-environment jsdom
// Step 2, Plan and contract: read only. The tenant sees what ChartWarden set up and is told to ask ChartWarden to change it.
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlanContractPanel, formatCents } from "./plan-contract-panel";
import {
  COMPLIANCE_OFFICER,
  ORG_ADMIN,
  ok,
  panelProps,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";

const PATH = "/api/v1/subscription/pricing";
const view = wizardView([wizardStep("plan_contract", 1)]);
const CONTRACT = {
  subscriptionId: "s-1",
  plan: { id: "p-1", slug: "census", name: "Census plan", version: 1, currencyCode: "USD" },
  billingServiceMode: "billing_software",
  billingBps: 250,
  pendingBillingServiceMode: null,
  contractStartOn: "2026-11-01",
  contractEndsOn: "2027-11-01",
  contractTermMonths: 12,
  perUserPriceCents: 12_500,
  bands: [
    { minAdc: 0, maxAdc: 25, monthlyFeeCents: 100_000 },
    { minAdc: 26, maxAdc: null, monthlyFeeCents: 250_000 },
  ],
  billingSoftwareBps: 250,
  managedBillingBps: 600,
  implementationFeeCents: 500_000,
  minimumMonthlyCents: null,
};

function mount(client: ReturnType<typeof stubClient>, session = ORG_ADMIN) {
  renderAt(
    "/x",
    [
      {
        path: "/x",
        element: <PlanContractPanel {...panelProps(view, "plan_contract", session)} />,
      },
    ],
    client,
    session,
  );
}

describe("PlanContractPanel", () => {
  it("shows the plan, terms and bands and says to ask ChartWarden to change it", async () => {
    mount(stubClient({ GET: { [PATH]: () => ok({ contract: CONTRACT, latestStatement: null }) } }));
    expect(await screen.findByText("Census plan")).toBeTruthy();
    expect(screen.getByText("Billing software (2.5% of collections)")).toBeTruthy();
    expect(screen.getByText("26 or more patients")).toBeTruthy();
    expect(screen.getByText("$125.00")).toBeTruthy();
    expect(screen.getByText(/to change your plan or contract, ask chartwarden/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign|change|save/i })).toBeNull();
  });

  it("says ChartWarden has not set the plan up yet when there is no contract", async () => {
    mount(stubClient({ GET: { [PATH]: () => ok({ contract: null, latestStatement: null }) } }));
    expect(await screen.findByText(/has not set up your plan yet/i)).toBeTruthy();
  });

  it("reports a failed read with a retry that reads again", async () => {
    let calls = 0;
    const client = stubClient({
      GET: {
        [PATH]: () => {
          calls += 1;
          return calls === 1
            ? refused(500, "BOOM")
            : ok({ contract: CONTRACT, latestStatement: null });
        },
      },
    });
    mount(client);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not load your plan/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("Census plan")).toBeTruthy();
  });

  it("does not read the plan for a role without the pricing key, and says so", () => {
    const client = stubClient({});
    mount(client, COMPLIANCE_OFFICER);
    expect(screen.getByText(/your role cannot see the plan and contract/i)).toBeTruthy();
    expect(client.GET).not.toHaveBeenCalled();
  });

  it("formats money in the plan's currency", () => {
    expect(formatCents(12_345, "USD")).toBe("$123.45");
  });
});
