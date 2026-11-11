// @vitest-environment jsdom
// Step 2, Plan & contract: the operator picks a published census-banded plan, previews what the tenant would pay, and signs it. Signing
// is what settles the step (the server attests it through the wizard), so there is no separate "mark done". The contract read is
// audited per read, so it is made only when this step is open and can be acted on.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PlanContractPanel, formatCents } from "./plan-contract-panel";
import {
  ONBOARDING_OPERATOR,
  ORG_SLUG,
  RETURNED_FROM_STEP_UP,
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
const PLAN_READER = {
  userId: "u1",
  organizationId: "o1",
  permissions: ["plan.admin.read", "subscription.pricing_read_platform"],
};
const chooseService = (value: string) =>
  fireEvent.change(screen.getByLabelText("Billing service"), { target: { value } });
function mount(
  handlers: Parameters<typeof stubClient>[0],
  v = view(),
  session?: Parameters<typeof renderAt>[3],
  at: Parameters<typeof renderAt>[0] = "/x",
) {
  const client = stubClient(handlers);
  const ctx = panelCtx(v, "plan_contract");
  renderAt(at, [{ path: "/x", element: <PlanContractPanel ctx={ctx} /> }], client, session);
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
  it("is an honest empty state when no plan is published, linking to price plans for an operator who can read them", async () => {
    mount({ GET: { [PLANS]: () => ok([]), [SUB]: () => ok(NO_CONTRACT) } }, view(), PLAN_READER);
    expect(await screen.findByText(/No published plan to sign/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign contract" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Create or publish a price plan" }).getAttribute("href"),
    ).toBe("/admin/pricing-plans");
  });

  it("says when the plan or contract cannot be loaded and offers Try again, which reads only what failed (each contract read is audited)", async () => {
    let planReads = 0;
    const { client } = mount({
      GET: {
        [PLANS]: () => {
          planReads += 1;
          return planReads === 1 ? refused(503, "UNAVAILABLE", "down") : ok([]);
        },
        [SUB]: () => ok(NO_CONTRACT),
      },
    });
    expect(await screen.findByText(/Could not load the plan and contract/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No published plan to sign/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(planReads).toBe(2);
    expect(client.GET.mock.calls.filter((c) => c[0] === SUB)).toHaveLength(1);
  });

  it("without plan.admin.read the empty state says who publishes plans, with no link to a refusal", async () => {
    mount({ GET: { [PLANS]: () => ok([]), [SUB]: () => ok(NO_CONTRACT) } });
    expect(await screen.findByText(/A billing admin publishes plans/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create or publish a price plan" })).toBeNull();
  });

  it("shows the signed contract, and the plan it is on", async () => {
    const { client } = mount({
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
    chooseService("none");
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
    // a price for other inputs is not this price: changing staff, census or collections clears it
    for (const [label, value] of [
      ["Staff accounts", "13"],
      ["Average daily census", "15"],
      [/^Expected net collections/, "60000"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
      expect(await screen.findByText("$1,088.00")).toBeTruthy();
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      expect(screen.queryByText("$1,088.00")).toBeNull();
    }
  });

  it("every Preview click carries its own Idempotency-Key: a preview prices the plan as it is now, never a replay", async () => {
    const { client } = mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: { [PREVIEW]: () => ok(PREVIEW_RESULT) },
    });
    await screen.findByLabelText("Plan");
    chooseService("none");
    fireEvent.change(screen.getByLabelText("Staff accounts"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Average daily census"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText(/^Expected net collections/), {
      target: { value: "50000" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    expect(await screen.findByText("$1,088.00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));

    const keyOf = (call: unknown[]): string | undefined =>
      (call[1] as { headers?: Record<string, string> }).headers?.["Idempotency-Key"];
    const [first, second] = client.POST.mock.calls as unknown as unknown[][];
    expect(keyOf(first ?? [])).toBeTruthy();
    expect(keyOf(second ?? [])).toBeTruthy();
    expect(keyOf(second ?? [])).not.toBe(keyOf(first ?? []));
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

  it("staff, census and collections parse as plain digits: 1.005, 1e3 and 0x1f price nothing", async () => {
    const { client } = mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: { [PREVIEW]: () => ok(PREVIEW_RESULT) },
    });
    await screen.findByLabelText("Plan");
    const set = (label: string | RegExp, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };
    const preview = (): void => {
      fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    };
    chooseService("none");
    set("Average daily census", "14");
    for (const staff of ["1e1", "0x1f"]) {
      set("Staff accounts", staff);
      preview();
      expect(screen.getByText(/Enter the staff accounts/)).toBeTruthy();
    }
    set("Staff accounts", "12");
    set("Average daily census", "1e3");
    preview();
    expect(screen.getByText(/Enter the average daily census/)).toBeTruthy();
    set("Average daily census", "14");
    for (const collections of ["1.005", "1e3", "0x1f"]) {
      set(/^Expected net collections/, collections);
      preview();
      expect(screen.getByText(/as dollars, with up to two decimals/)).toBeTruthy();
    }
    expect(client.POST).not.toHaveBeenCalled();
    set(/^Expected net collections/, "0.29");
    preview();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [, init] = client.POST.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(init.body.expectedNetCollectionsCents).toBe(29); // 0.29 * 100 is 28.999… as a float
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
    chooseService("none");
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
    chooseService("none");
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

describe("PlanContractPanel: reading is not writing", () => {
  const sessionWith = (...permissions: string[]) => ({ ...ONBOARDING_OPERATOR, permissions });
  const mountAs = (session: ReturnType<typeof sessionWith>) => {
    const client = stubClient({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok({ contract: CONTRACT, statements: [] }) },
    });
    const ctx = panelCtx(view(), "plan_contract", undefined, session);
    renderAt("/x", [{ path: "/x", element: <PlanContractPanel ctx={ctx} /> }], client, session);
    return client;
  };

  it("an operator who may read the contract but not sign it sees it, with the frame saying they cannot edit", async () => {
    mountAs(sessionWith("subscription.pricing_read_platform", "onboarding.manage_platform"));
    expect(await screen.findByText("Standard census bands")).toBeTruthy();
    expect(screen.getByText(/You can view this step/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change billing service" })).toBeNull();
  });

  it("an operator who may not read contracts is told so and no contract read is made", async () => {
    const client = mountAs(sessionWith("subscription.onboard_platform"));
    expect(await screen.findByText(/Your role cannot read this tenant's contract/)).toBeTruthy();
    expect(client.GET.mock.calls.filter((c) => c[0] === SUB)).toHaveLength(0);
  });
});

describe("PlanContractPanel: the billing service is a choice", () => {
  const fillInputs = () => {
    fireEvent.change(screen.getByLabelText("Staff accounts"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Average daily census"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText(/^Expected net collections/), {
      target: { value: "50000" },
    });
  };

  it("starts empty: signing or previewing without a choice asks for one and sends nothing", async () => {
    const { client } = mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: { [PREVIEW]: () => ok(PREVIEW_RESULT) },
    });
    await screen.findByLabelText("Plan");
    expect((screen.getByLabelText("Billing service") as HTMLSelectElement).value).toBe("");
    fillInputs();
    fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    expect(screen.getByText("Choose the billing service.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign contract" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("a price that arrives after the inputs were edited is not shown as the price of the new inputs", async () => {
    let release: (reply: ReturnType<typeof ok>) => void = () => undefined;
    const { client } = mount({
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: {
        [PREVIEW]: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    await screen.findByLabelText("Plan");
    chooseService("none");
    fillInputs();
    fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Staff accounts"), { target: { value: "13" } });
    release(ok(PREVIEW_RESULT));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Preview price" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText("$1,088.00")).toBeNull();
    // asking again for the inputs as they are now shows that price
    fireEvent.click(screen.getByRole("button", { name: "Preview price" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    release(ok(PREVIEW_RESULT));
    expect(await screen.findByText("$1,088.00")).toBeTruthy();
  });
});

describe("PlanContractPanel: a Re-verify keeps what was typed", () => {
  it("brings back the plan form and the sign prompt with the reason that was typed, from memory only", async () => {
    const typed = "Order form countersigned, CHG-4411";
    const handlers = {
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok(NO_CONTRACT) },
      POST: { [SUB]: () => refused(403, "STEP_UP_REQUIRED", "x") },
    };
    mount(handlers);
    await screen.findByLabelText("Plan");
    chooseService("billing_software");
    fireEvent.change(screen.getByLabelText("Staff accounts"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Order form reference (optional)"), {
      target: { value: "OF-2026-114" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign contract" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: typed } });
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(typed);
    cleanup();

    mount(handlers, view(), undefined, RETURNED_FROM_STEP_UP);
    expect(((await screen.findByLabelText(/^Reason/)) as HTMLTextAreaElement).value).toBe(typed);
    expect((screen.getByLabelText("Billing service") as HTMLSelectElement).value).toBe(
      "billing_software",
    );
    expect((screen.getByLabelText("Staff accounts") as HTMLInputElement).value).toBe("12");
    expect(
      (screen.getByLabelText("Order form reference (optional)") as HTMLInputElement).value,
    ).toBe("OF-2026-114");
  });

  it("brings back the change-billing-service prompt the same way", async () => {
    const handlers = {
      GET: { [PLANS]: () => ok([PLAN]), [SUB]: () => ok({ contract: CONTRACT, statements: [] }) },
      PUT: { [MODE]: () => refused(403, "STEP_UP_REQUIRED", "x") },
    };
    mount(handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Change billing service" }));
    fireEvent.change(screen.getByLabelText("New billing service"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Tenant bills outside ChartWarden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    cleanup();

    mount(handlers, view(), undefined, RETURNED_FROM_STEP_UP);
    expect(((await screen.findByLabelText(/^Reason/)) as HTMLTextAreaElement).value).toBe(
      "Tenant bills outside ChartWarden",
    );
    expect((screen.getByLabelText("New billing service") as HTMLSelectElement).value).toBe("none");
  });
});
