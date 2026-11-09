import {
  ApiClientProvider,
  ToastProvider,
  createApiClient,
  discardStepUpDrafts,
} from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — money and counts the M35 forms send are parsed by string math: "1.005", "1e3" and
// "0x1f" are refused (a float multiply or Number() would have taken them), and a valid amount is sent as exact cents ("0.29" is 29).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { promoFormErrors, refundFormErrors } from "../form-rules";
import { PlanEdit } from "../plan-edit";
import { Promos } from "../promos";
import { RefundNew } from "../refund-new";

const BAD = ["1.005", "1e3", "0x1f"];
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let posted: Array<{ url: string; body: unknown }> = [];
let postReply: () => Response | Promise<Response> = () => json({ id: "r1" }, 201);
const refusal = (status: number, code: string): Response =>
  json({ error: { code, message: "refused", correlationId: "c" } }, status);
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
  if (req.method === "GET") return json(url === "/api/admin/promos" ? [] : PLAN);
  posted = [...posted, { url, body: await req.json() }];
  return postReply();
}
function mount(path: string): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/admin/refunds/new" element={<RefundNew />} />
            <Route path="/admin/refunds" element={<p>refunds</p>} />
            <Route path="/admin/plans/:id/edit" element={<PlanEdit />} />
            <Route path="/admin/promos" element={<Promos />} />
            <Route path="/step-up" element={<p>step-up</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  posted = [];
  postReply = () => json({ id: "r1" }, 201);
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
    await screen.findByLabelText(/^Event type/);
    const set = (label: string | RegExp, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };
    set(/^Event type/, "seat");
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

describe("plan meter refusals", () => {
  const set = (label: string | RegExp, value: string): void => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  };
  const typeMeter = (): void => {
    set(/^Event type/, "seat");
    set(/^Included qty/, "10");
    set(/^Overage/, "0.29");
    set(/^Warn %/, "75");
  };
  const values = () =>
    [/^Event type/, /^Included qty/, /^Overage/, /^Warn %/].map(
      (label) => (screen.getByLabelText(label) as HTMLInputElement).value,
    );

  it("a second submit while the first meter is in flight sends nothing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    postReply = async () => {
      await gate;
      return json({ id: "m1" }, 201);
    };
    mount(`/admin/plans/${PLAN.id}/edit`);
    await screen.findByLabelText(/^Event type/);
    typeMeter();
    const form = screen.getByRole("button", { name: "Add meter" }).closest("form") as HTMLElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(posted).toHaveLength(1));
    release();
    await screen.findByText(/Meter "seat" added/);
    expect(posted).toHaveLength(1);
  });

  it("marks every validated meter field as required", async () => {
    mount(`/admin/plans/${PLAN.id}/edit`);
    await screen.findByLabelText(/^Event type/);
    for (const label of [/^Event type/, /^Included qty/, /^Overage/, /^Warn %/]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).required).toBe(true);
    }
  });

  it("a 422 keeps what was typed, to fix and retry", async () => {
    postReply = () => refusal(422, "VALIDATION_FAILED");
    mount(`/admin/plans/${PLAN.id}/edit`);
    await screen.findByLabelText(/^Event type/);
    typeMeter();
    fireEvent.click(screen.getByRole("button", { name: "Add meter" }));
    expect(await screen.findByText(/Could not add the meter/)).toBeTruthy();
    expect(values()).toEqual(["seat", "10", "0.29", "75"]);
  });

  it("a step-up refusal keeps the typed meter across Re-verify, restored once", async () => {
    postReply = () => refusal(403, "STEP_UP_REQUIRED");
    mount(`/admin/plans/${PLAN.id}/edit`);
    await screen.findByLabelText(/^Event type/);
    typeMeter();
    fireEvent.click(screen.getByRole("button", { name: "Add meter" }));
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    await screen.findByText("step-up");
    cleanup();
    mount(`/admin/plans/${PLAN.id}/edit`);
    await screen.findByLabelText(/^Event type/);
    expect(values()).toEqual(["seat", "10", "0.29", "75"]);
    cleanup();
    mount(`/admin/plans/${PLAN.id}/edit`);
    await screen.findByLabelText(/^Event type/);
    expect(values()).toEqual(["", "0", "0", "80"]);
  });
});

describe("promo create body", () => {
  async function createPromo(kind: "percent_off" | "amount_off", value: string): Promise<unknown> {
    mount("/admin/promos");
    await screen.findByText(/No promos yet/);
    fireEvent.click(screen.getByRole("button", { name: "New promo" }));
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "LAUNCH" } });
    fireEvent.change(screen.getByLabelText(/^Kind/), { target: { value: kind } });
    fireEvent.change(screen.getByLabelText(kind === "percent_off" ? /^Percent/ : /^Amount/), {
      target: { value },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create promo" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    return posted[0]?.body;
  }

  it("a percent_off promo sends percentOff and no fixedOffCents", async () => {
    const body = (await createPromo("percent_off", "15")) as Record<string, unknown>;
    expect(body.percentOff).toBe(15);
    expect("fixedOffCents" in body).toBe(false);
  });

  it("an amount_off promo sends fixedOffCents and no percentOff", async () => {
    const body = (await createPromo("amount_off", "10.50")) as Record<string, unknown>;
    expect(body.fixedOffCents).toBe(1050);
    expect("percentOff" in body).toBe(false);
  });
});
