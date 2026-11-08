import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — the price-plans screen: lists the plans, offers only the actions a plan's status
// allows, asks for a reason before every write, and sends it with an Idempotency-Key; a step-up refusal offers Re-verify.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { PricingPlans, parsePercentBps, pricingFormErrors } from "../pricing-plans";

const DRAFT = {
  id: "11111111-1111-4111-8111-111111111111",
  familySlug: "hospice-core",
  version: 1,
  slug: "hospice-core-v1",
  name: "Hospice core",
  description: null,
  status: "draft",
  offered: false,
  currencyCode: "USD",
  perUserPriceCents: 4900,
  bands: [
    { minAdc: 0, maxAdc: 24, monthlyFeeCents: 100000 },
    { minAdc: 25, maxAdc: null, monthlyFeeCents: 200000 },
  ],
  billingSoftwareBps: 250,
  managedBillingBps: 450,
  contractTermMonths: 12,
  implementationFeeCents: 0,
  minimumMonthlyCents: null,
  supersedesPlanId: null,
  publishedAt: null,
  archivedAt: null,
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: "2026-11-08T10:00:00.000Z",
};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Sent {
  url: string;
  body: unknown;
  idempotencyKey: string | null;
}
let sent: Sent[] = [];
let writeReply: () => Response = () => json({ ...DRAFT, status: "published" });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url).pathname;
  if (req.method === "GET") {
    if (url === "/api/admin/pricing/defaults")
      return json({ bandThresholds: [0, 25], currencyCode: "USD" });
    return json([DRAFT]);
  }
  sent = [
    ...sent,
    { url, body: await req.json(), idempotencyKey: req.headers.get("Idempotency-Key") },
  ];
  return writeReply();
}

function mount(path = "/admin/pricing-plans"): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/pricing-plans" element={<PricingPlans />} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const REASON = "Launch pricing for the first tenants";
function confirmWithReason(label: string): void {
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: REASON } });
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
}

afterEach(() => {
  cleanup();
  sent = [];
  writeReply = () => json({ ...DRAFT, status: "published" });
});

describe("parsePercentBps", () => {
  it("turns a percentage into whole basis points, and refuses what is not 0 to 100", () => {
    expect(parsePercentBps("4.5")).toBe(450);
    expect(parsePercentBps("0")).toBe(0);
    expect(parsePercentBps("100")).toBe(10_000);
    expect(parsePercentBps("100.01")).toBeNull();
    expect(parsePercentBps("abc")).toBeNull();
    expect(parsePercentBps("")).toBeNull();
  });
});

describe("pricingFormErrors", () => {
  it("names every field that cannot be sent, a census band included", () => {
    const errors = pricingFormErrors({
      familySlug: "X",
      name: "",
      perUserPrice: "49",
      bandFees: ["1000", ""],
      billingSoftwarePct: "2.5",
      managedBillingPct: "450",
      termMonths: "0",
      implementationFee: "0",
      minimumMonthly: "",
    });
    expect(Object.keys(errors).sort()).toEqual(
      ["band1", "familySlug", "managedBillingPct", "name", "termMonths"].sort(),
    );
  });
});

describe("PricingPlans", () => {
  it("lists the plans, and a draft offers Publish and Archive but not a new version", async () => {
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const drawer = await screen.findByRole("complementary", { name: "Price plan" });
    expect(within(drawer).getByText("2.5% of net collections")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "Start a new version" })).toBeNull();
  });

  it("publishes only after a reason, sent with an Idempotency-Key", async () => {
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    expect(sent).toHaveLength(0);
    confirmWithReason("Publish");
    expect(await screen.findByText(/"Hospice core" published/)).toBeTruthy();
    expect(sent).toEqual([
      {
        url: `/api/admin/pricing/plans/${DRAFT.id}/publish`,
        body: { reason: REASON },
        idempotencyKey: expect.any(String),
      },
    ]);
  });

  it("a step-up refusal offers Re-verify", async () => {
    writeReply = () =>
      json({ error: { code: "STEP_UP_REQUIRED", message: "refused", correlationId: "c" } }, 403);
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    confirmWithReason("Archive");
    expect(await screen.findByRole("link", { name: "Re-verify" })).toBeTruthy();
  });

  it("creates a draft from the form: dollars to cents, percentages to basis points, one fee per census band", async () => {
    writeReply = () => json(DRAFT, 201);
    mount("/admin/pricing-plans?plan=new");
    const form = await screen.findByRole("complementary", { name: "New price plan" });
    const type = (label: RegExp, value: string): void => {
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    };
    type(/Plan family/, "hospice-core");
    type(/^Name/, "Hospice core");
    type(/Per user a month/, "49");
    type(/Census band 0-24/, "1000");
    type(/Census band 25\+/, "2000");
    type(/Billing software/, "2.5");
    type(/Managed billing/, "4.5");
    fireEvent.click(within(form).getByRole("button", { name: "Create draft" }));
    confirmWithReason("Create draft");
    expect(await screen.findByText(/Draft "Hospice core" created/)).toBeTruthy();
    expect(sent[0]?.body).toEqual({
      familySlug: "hospice-core",
      name: "Hospice core",
      perUserPriceCents: 4900,
      bands: [
        { minAdc: 0, monthlyFeeCents: 100000 },
        { minAdc: 25, monthlyFeeCents: 200000 },
      ],
      billingSoftwareBps: 250,
      managedBillingBps: 450,
      contractTermMonths: 12,
      implementationFeeCents: 0,
      minimumMonthlyCents: null,
      reason: REASON,
    });
  });
});
