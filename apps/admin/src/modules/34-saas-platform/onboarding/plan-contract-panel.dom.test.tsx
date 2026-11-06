// @vitest-environment jsdom
// Step 2, Plan & contract: the operator picks a published census-banded plan, previews what the tenant would pay, and signs it. Signing
// is what settles the step (the server attests it through the wizard), so there is no separate "mark done". The contract read is
// audited per read, so it is made only when this step is open and can be acted on.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PlanContractPanel, formatCents } from "./plan-contract-panel";
import {
  ORG_SLUG,
  ok,
  panelCtx,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";

const PLANS = "/api/v1/platform/pricing/plans";
const PREVIEW = "/api/v1/platform/pricing/preview";
const SUB = "/api/v1/platform/tenants/{orgSlug}/subscription";
const MODE = "/api/v1/platform/tenants/{orgSlug}/subscription/billing-service-mode";

const PLAN = {
  id: "11111111-1111-4111-8111-111111111111",
  familySlug: "standard-bands",
  version: 2,
  slug: "standard-bands-v2",
  name: "Standard census bands",
  description: null,
  status: "published",
  offered: true,
  currencyCode: "USD",
  perUserPriceCents: 4900,
  bands: [{ minAdc: 0, maxAdc: 9, monthlyFeeCents: 49900 }],
  billingSoftwareBps: 100,
  managedBillingBps: 400,
  contractTermMonths: 12,
  implementationFeeCents: 250000,
  minimumMonthlyCents: null,
  supersedesPlanId: null,
  publishedAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const CONTRACT = {
  subscriptionId: "sub-1",
  plan: { id: PLAN.id, slug: PLAN.slug, name: PLAN.name, version: 2, currencyCode: "USD" },
  billingServiceMode: "billing_software",
  billingBps: 100,
  pendingBillingServiceMode: null,
  contractStartOn: "2026-11-01",
  contractTermMonths: 12,
  contractEndsOn: "2027-10-31",
  perUserPriceCents: 4900,
  bands: PLAN.bands,
  billingSoftwareBps: 100,
  managedBillingBps: 400,
  implementationFeeCents: 250000,
  minimumMonthlyCents: null,
  signedByMembershipId: "m-1",
  signedReason: "Order form countersigned",
  orderFormRef: "OF-2026-114",
};
const PREVIEW_RESULT = {
  plan: {
    id: PLAN.id,
    slug: PLAN.slug,
    name: PLAN.name,
    version: 2,
    status: "published",
    currencyCode: "USD",
  },
  inputs: {
    staffCount: 12,
    averageDailyCensus: 14,
    expectedNetCollectionsCents: 5000000,
    billingServiceMode: "billing_software",
  },
  platformFee: {
    perUserSubtotalCents: 58800,
    bandFeeCents: 49900,
    bandMinAdc: 10,
    bandMaxAdc: 16,
    feeCents: 58800,
    basis: "per_user",
  },
  billing: { mode: "billing_software", bps: 100, feeCents: 50000 },
  minimumAdjustmentCents: 0,
  monthlyCents: 108800,
  implementationFeeCents: 250000,
  firstMonthCents: 358800,
  firstMonthDaysLive: null,
  firstMonthDaysInPeriod: null,
  contractTermMonths: 12,
};
const view = (over = {}, stepOver = {}) =>
  wizardView([wizardStep("plan_contract", 1, { title: "Plan & contract", ...stepOver })], over);
function mount(handlers: Parameters<typeof stubClient>[0], v = view()) {
  const client = stubClient(handlers);
  const ctx = panelCtx(v, "plan_contract");
  renderAt("/x", [{ path: "/x", element: <PlanContractPanel ctx={ctx} /> }], client);
  return { client, ctx };
}
const NO_CONTRACT = { contract: null, statements: [] };
beforeEach(() => window.sessionStorage.clear());

describe("formatCents", () => {
  it("shows integer cents as money in the plan's currency", () => {
    expect(formatCents(108800, "USD")).toBe("$1,088.00");
    expect(formatCents(0, "USD")).toBe("$0.00");
  });
});

describe("PlanContractPanel", () => {
  it("is an honest empty state when no plan is published", async () => {
    mount({ GET: { [PLANS]: () => ok([]), [SUB]: () => ok(NO_CONTRACT) } });
    expect(await screen.findByText(/No published plan to sign/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign contract" })).toBeNull();
  });

  it("shows the signed contract, and the plan it is on", async () => {
    mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok({ contract: CONTRACT, statements: [] }) },
    });
    expect(await screen.findByText("Standard census bands")).toBeTruthy();
    expect(screen.getByText(/Order form countersigned/)).toBeTruthy();
    expect(screen.getByText("OF-2026-114")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign contract" })).toBeNull();
  });

  it("previews the price for the entered inputs without writing", async () => {
    const { client } = mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: { [PREVIEW]: () => ok(PREVIEW_RESULT) },
    });
    await screen.findByLabelText("Plan");
    fireEvent.change(screen.getByLabelText("Staff accounts"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Average daily census"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText(/^Expected net collections/), {
      target: { value: "50000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    expect(await screen.findByText("$1,088.00")).toBeTruthy();
    const [path, init] = client.POST.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe(PREVIEW);
    expect(init.body).toEqual({
      planId: PLAN.id,
      staffCount: 12,
      averageDailyCensus: 14,
      expectedNetCollectionsCents: 5000000,
      billingServiceMode: "none",
    });
    expect(client.POST).toHaveBeenCalledTimes(1);
  });

  it("a blank staff count or census is not zero: it asks for them, and prices nothing", async () => {
    const { client } = mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: { [PREVIEW]: () => ok(PREVIEW_RESULT) },
    });
    await screen.findByLabelText("Plan");
    fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    expect(screen.getByText(/Enter the staff accounts/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Staff accounts"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    expect(screen.getByText(/Enter the average daily census/)).toBeTruthy();
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("billing through ChartWarden needs the expected collections; a tenant billing outside need not give any", async () => {
    const { client } = mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: { [PREVIEW]: () => ok(PREVIEW_RESULT) },
    });
    await screen.findByLabelText("Plan");
    fireEvent.change(screen.getByLabelText("Staff accounts"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Average daily census"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Billing service"), {
      target: { value: "billing_software" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    expect(screen.getByText(/Enter the expected net collections/)).toBeTruthy();
    expect(client.POST).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Billing service"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
  });

  it("signs the plan for this tenant behind a reason and an Idempotency-Key, then reloads the wizard", async () => {
    const { client, ctx } = mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: {
        [SUB]: () =>
          ok({ contract: CONTRACT, resumed: false, planContractStep: { status: "settled" } }, 201),
      },
    });
    await screen.findByLabelText("Plan");
    fireEvent.change(screen.getByLabelText("Billing service"), {
      target: { value: "billing_software" },
    });
    fireEvent.change(screen.getByLabelText("Order form reference (optional)"), {
      target: { value: "OF-2026-114" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign contract" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Order form countersigned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [
      string,
      { params: { path: unknown; header: Record<string, string> }; body: Record<string, unknown> },
    ];
    expect(path).toBe(SUB);
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG });
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.body).toEqual({
      planSlug: PLAN.slug,
      billingServiceMode: "billing_software",
      orderFormRef: "OF-2026-114",
      reason: "Order form countersigned",
    });
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  it("says when the contract is saved but the step waits on an earlier one", async () => {
    mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: {
        [SUB]: () =>
          ok(
            {
              contract: CONTRACT,
              resumed: false,
              planContractStep: { status: "pending", reason: "the tenant is not onboarding yet" },
            },
            201,
          ),
      },
    });
    await screen.findByLabelText("Plan");
    fireEvent.click(screen.getByRole("button", { name: "Sign contract" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Order form countersigned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    expect(await screen.findByText(/Contract saved/)).toBeTruthy();
    expect(screen.getByText(/the tenant is not onboarding yet/)).toBeTruthy();
  });

  it("explains an earlier step that must be finished before the plan can be signed", async () => {
    mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: {
        [SUB]: () =>
          refused(409, "ONBOARDING_STEP_OUT_OF_ORDER", "x", [
            {
              field: "templateKey",
              code: "account_created",
              message: "Organisation must be done first",
            },
          ]),
      },
    });
    await screen.findByLabelText("Plan");
    fireEvent.click(screen.getByRole("button", { name: "Sign contract" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Order form countersigned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/earlier step is not finished/i)).toBeTruthy();
  });

  it("changes the billing service of a signed contract behind a reason", async () => {
    const { client } = mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok({ contract: CONTRACT, statements: [] }) },
      PUT: { [MODE]: () => ok(CONTRACT) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Change billing service" }));
    fireEvent.change(screen.getByLabelText("New billing service"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Tenant bills outside ChartWarden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    const [path, init] = client.PUT.mock.calls[0] as [
      string,
      { params: { header: Record<string, string> }; body: Record<string, unknown> },
    ];
    expect(path).toBe(MODE);
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.body).toEqual({
      billingServiceMode: "none",
      reason: "Tenant bills outside ChartWarden",
    });
  });

  it("makes no contract read while an earlier step is still open (each read is audited)", async () => {
    const steps = [
      wizardStep("account_created", 1, { title: "Organisation" }),
      wizardStep("plan_contract", 2, {
        title: "Plan & contract",
        locked: true,
        lockedBy: "account_created",
      }),
    ];
    const client = stubClient({ GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) } });
    renderAt(
      "/x",
      [
        {
          path: "/x",
          element: <PlanContractPanel ctx={panelCtx(wizardView(steps), "plan_contract")} />,
        },
      ],
      client,
    );
    expect(await screen.findByText(/Finish Organisation first/)).toBeTruthy();
    expect(client.GET.mock.calls.filter((c) => c[0] === SUB)).toHaveLength(0);
  });
});
