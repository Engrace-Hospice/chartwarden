// apps/admin/src/modules/35-subscription-billing — shared list behaviour of the four drawer lists (plans, promos,
// subscriptions, refunds): a stale ?param is cleared with a notice, Enter opens a row's drawer, Escape closes it and
// hands focus back to the row; plus the create-plan form (Enter submits, a non-numeric price cannot be submitted).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlansList, parsePriceCents, parseTrialDays } from "../plans-list";
import { Promos } from "../promos";
import { RefundsQueue } from "../refunds-queue";
import { SubscriptionsList } from "../subscriptions-list";

const ID = "11111111-1111-4111-8111-111111111111";
const MISSING = "99999999-9999-4999-8999-999999999999";
const ORG = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-01T00:00:00.000Z";

const PLAN = {
  id: ID,
  slug: "pro-monthly",
  name: "Pro Monthly",
  tier: "professional",
  cadence: "monthly",
  basePriceCents: 9900,
  currencyCode: "USD",
  trialPeriodDays: 14,
  isActive: true,
};
const PROMO = {
  id: ID,
  code: "SPRING",
  percentOff: 20,
  fixedOffCents: null,
  duration: "once",
  durationInMonths: null,
  redemptionCount: 3,
  maxRedemptions: null,
  isActive: true,
};
const SUBSCRIPTION = {
  id: ID,
  organizationId: ORG,
  organizationName: "Cedar Ridge Hospice",
  planName: "Pro Monthly",
  planTier: "professional",
  status: "active",
  dunningStage: "none",
  defaultPaymentMethodLast4: "4242",
};
const REFUND = {
  id: ID,
  organizationId: ORG,
  organizationName: "Cedar Ridge Hospice",
  requestedAt: NOW,
  amountCents: 5000,
  kind: "partial",
  reasonCode: "duplicate",
  status: "requested",
};
const page = (item: unknown): unknown => ({ items: [item], nextCursor: null, hasMore: false });

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function Probe(): JSX.Element {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

function mount(element: JSX.Element, url: string, listBody: unknown): Recorded[] {
  const calls: Recorded[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(await req.clone().text()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      calls.push({ method: req.method, path: new URL(req.url).pathname, body });
      return json(req.method === "GET" ? listBody : { id: ID });
    },
  });
  render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          {element}
          <Probe />
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SCREENS = [
  {
    name: "plans",
    el: <PlansList />,
    param: "plan",
    body: [PLAN],
    row: "Pro Monthly",
    drawer: "Plan",
  },
  {
    name: "promos",
    el: <Promos />,
    param: "promo",
    body: [PROMO],
    row: "SPRING",
    drawer: "Promo code",
  },
  {
    name: "subscriptions",
    el: <SubscriptionsList />,
    param: "subscription",
    body: page(SUBSCRIPTION),
    row: "Cedar Ridge Hospice",
    drawer: "Subscription",
  },
  {
    name: "refunds",
    el: <RefundsQueue />,
    param: "refund",
    body: page(REFUND),
    row: "Cedar Ridge Hospice",
    drawer: "Refund",
  },
] as const;

describe.each(SCREENS)("$name list behaviour", ({ el, param, body, row, drawer }) => {
  const findRow = async (): Promise<HTMLElement> => {
    const cell = await screen.findByText(row);
    const tr = cell.closest("tr");
    if (!tr) throw new Error("row not found");
    return tr;
  };

  it("clears a ?param naming a record that is not in the loaded list and says so", async () => {
    mount(el, `/x?${param}=${MISSING}`, body);
    await waitFor(() => expect(screen.getByTestId("search").textContent).toBe(""));
    expect(await screen.findByText("That record is no longer in this list.")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: drawer })).toBeNull();
  });

  it("opens the drawer for a ?param that is present, without clearing it", async () => {
    mount(el, `/x?${param}=${ID}`, body);
    expect(await screen.findByRole("complementary", { name: drawer })).toBeTruthy();
    expect(screen.getByTestId("search").textContent).toBe(`?${param}=${ID}`);
  });

  it("opens the drawer on Enter, then Escape closes it and returns focus to the row", async () => {
    mount(el, "/x", body);
    const tr = await findRow();
    expect(tr.getAttribute("aria-selected")).toBeNull();
    tr.focus();
    fireEvent.keyDown(tr, { key: "Enter" });
    const aside = await screen.findByRole("complementary", { name: drawer });
    expect(screen.getByTestId("search").textContent).toBe(`?${param}=${ID}`);
    await waitFor(() => expect(document.activeElement).toBe(aside));
    fireEvent.keyDown(aside, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: drawer })).toBeNull());
    expect(screen.getByTestId("search").textContent).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(tr));
  });
});

describe("create plan form", () => {
  const openForm = async (): Promise<void> => {
    fireEvent.click(await screen.findByRole("button", { name: "New plan" }));
    await screen.findByRole("complementary", { name: "New plan" });
  };
  const fill = (label: string, value: string): void => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  };

  it("submits on Enter (form submit) with the price converted to cents", async () => {
    const calls = mount(<PlansList />, "/x", [PLAN]);
    await openForm();
    fill("Slug", "team");
    fill("Name", "Team");
    fill("Base price (USD)", "12.34");
    const form = screen.getByRole("button", { name: "Create draft" }).closest("form");
    expect(form).not.toBeNull();
    if (form) fireEvent.submit(form);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body?.basePriceCents).toBe(1234);
  });

  it("keeps submit disabled and posts nothing for a non-numeric price", async () => {
    const calls = mount(<PlansList />, "/x", [PLAN]);
    await openForm();
    fill("Slug", "team");
    fill("Name", "Team");
    fill("Base price (USD)", "abc");
    const button = screen.getByRole("button", { name: "Create draft" });
    expect(button.hasAttribute("disabled")).toBe(true);
    const form = button.closest("form");
    if (form) fireEvent.submit(form);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("price and trial parsing", () => {
  it("accepts only finite non-negative numbers", () => {
    expect(parsePriceCents("0")).toBe(0);
    expect(parsePriceCents("19.99")).toBe(1999);
    expect(parsePriceCents("")).toBeNull();
    expect(parsePriceCents("abc")).toBeNull();
    expect(parsePriceCents("-1")).toBeNull();
    expect(parsePriceCents("Infinity")).toBeNull();
    expect(parseTrialDays("14")).toBe(14);
    expect(parseTrialDays("1.5")).toBeNull();
    expect(parseTrialDays("x")).toBeNull();
  });
});
