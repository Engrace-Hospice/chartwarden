import { ApiClientProvider, createApiClient, discardStepUpDrafts } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — money and counts the M35 forms send are parsed by string math: "1.005", "1e3" and
// "0x1f" are refused (a float multiply or Number() would have taken them), and a valid amount is sent as exact cents ("0.29" is 29).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { PlanEdit } from "../plan-edit";
import { promoFormErrors } from "../promos";
import { RefundNew, refundFormErrors } from "../refund-new";

const BAD = ["1.005", "1e3", "0x1f"];
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let posted: Array<{ url: string; body: unknown }> = [];
const PLAN = {
  id: "44444444-4444-4444-8444-444444444444",
  slug: "starter-monthly",
  name: "Starter",
  tier: "starter",
  cadence: "monthly",
  basePriceCents: 4900,
  currencyCode: "USD",
  trialPeriodDays: 0,
  isActive: false,
  stripePriceId: null,
  stripeProductId: null,
  meters: [],
};
async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url).pathname;
  if (req.method === "GET") return json(PLAN);
  posted = [...posted, { url, body: await req.json() }];
  return json({ id: "r1" }, 201);
}
function mount(path: string): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/refunds/new" element={<RefundNew />} />
          <Route path="/admin/refunds" element={<p>refunds</p>} />
          <Route path="/admin/plans/:id/edit" element={<PlanEdit />} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  posted = [];
  discardStepUpDrafts();
});

const REFUND = {
  invoiceId: "3f2b8c1e-1111-4111-8111-111111111111",
  amount: "25",
  kind: "partial",
  reasonCode: "requested_by_customer",
  detail: "Customer asked for a partial refund, TICKET-9",
};

describe("refund amount", () => {
  it.each(BAD)("refuses %s", (amount) => {
    expect(refundFormErrors({ ...REFUND, amount }).amount).toBeTruthy();
  });

  it("sends a valid amount as exact cents", async () => {
    window.sessionStorage.clear();
    mount("/admin/refunds/new");
    const set = (label: RegExp, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };
    set(/Invoice/, REFUND.invoiceId);
    set(/Amount/, "0.29");
    set(/Reason detail/, REFUND.detail);
    fireEvent.click(screen.getByRole("button", { name: /Request refund|Submit/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0]?.body as { amountCents: number }).amountCents).toBe(29);
  });
});

describe("promo amount and percentage", () => {
  const promo = {
    code: "LAUNCH",
    coupon: "",
    promotion: "",
    kind: "amount_off",
    percent: "",
    amount: "10",
    duration: "once",
  };
  it.each(BAD)("refuses an amount of %s", (amount) => {
    expect(promoFormErrors({ ...promo, amount }).amount).toBeTruthy();
  });
  it.each(["1e1", "0x1f", "12.5"])("refuses a percentage of %s", (percent) => {
    expect(promoFormErrors({ ...promo, kind: "percent_off", percent }).percent).toBeTruthy();
  });
  it("accepts plain values", () => {
    expect(promoFormErrors(promo)).toEqual({});
    expect(promoFormErrors({ ...promo, kind: "percent_off", percent: "15" })).toEqual({});
  });
});

describe("plan meter", () => {
  it("refuses a strange overage, quantity or threshold and sends nothing; a valid one is exact cents", async () => {
    mount(`/admin/plans/${PLAN.id}/edit`);
    await screen.findByLabelText("Event type");
    const set = (label: string | RegExp, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };
    set("Event type", "seat");
    for (const value of BAD) {
      set(/^Overage/, value);
      fireEvent.click(screen.getByRole("button", { name: "Add meter" }));
      expect(screen.getByLabelText(/^Overage/).getAttribute("aria-invalid")).toBe("true");
    }
    set(/^Overage/, "0.29");
    set(/^Included qty/, "1e3");
    fireEvent.click(screen.getByRole("button", { name: "Add meter" }));
    expect(screen.getByLabelText(/^Included qty/).getAttribute("aria-invalid")).toBe("true");
    set(/^Included qty/, "10");
    set(/^Warn %/, "0x1f");
    fireEvent.click(screen.getByRole("button", { name: "Add meter" }));
    expect(screen.getByLabelText(/^Warn %/).getAttribute("aria-invalid")).toBe("true");
    expect(posted).toHaveLength(0);
    set(/^Warn %/, "80");
    fireEvent.click(screen.getByRole("button", { name: "Add meter" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toMatchObject({
      inclusiveQuantity: 10,
      overageUnitPriceCents: 29,
      warningThresholdPercent: 80,
    });
  });
});
