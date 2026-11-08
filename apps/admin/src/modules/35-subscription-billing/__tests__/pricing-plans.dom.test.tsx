import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — the price-plans screen: lists the plans, offers only the writes a plan's status
// allows (and only to an operator holding plan.admin.write), asks for a reason before every write, sends one Idempotency-Key per
// attempt, keeps a refusal in the dialog with the server's reason, and keeps a typed form across a step-up round trip.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePriceCents } from "../plans-list";
import { PricingPlans, actionsFor, parsePercentBps, pricingFormErrors } from "../pricing-plans";

const DRAFT = {
  id: "11111111-1111-4111-8111-111111111111",
  familySlug: "hospice-core",
  version: 1,
  slug: "hospice-core-v1",
  name: "Hospice core",
  description: null,
  status: "draft" as "draft" | "published" | "archived",
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
  supersedesPlanId: null as string | null,
  publishedAt: null as string | null,
  archivedAt: null,
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: "2026-11-08T10:00:00.000Z",
};
type Plan = typeof DRAFT;
const PUBLISHED: Plan = {
  ...DRAFT,
  id: "22222222-2222-4222-8222-222222222222",
  status: "published",
  publishedAt: "2026-11-08T11:00:00.000Z",
};
const NEXT_DRAFT: Plan = {
  ...DRAFT,
  id: "33333333-3333-4333-8333-333333333333",
  version: 2,
  slug: "hospice-core-v2",
  supersedesPlanId: PUBLISHED.id,
};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string, message: string): Response =>
  json({ error: { code, message, correlationId: "c" } }, status);

interface Sent {
  method: string;
  url: string;
  body: unknown;
  idempotencyKey: string | null;
}
let sent: Sent[] = [];
let list: Plan[] = [DRAFT];
let listReply: () => Response = () => json(list);
let writeReplies: Array<() => Response> = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url).pathname;
  if (req.method === "GET") {
    if (url === "/api/admin/pricing/defaults")
      return json({ bandThresholds: [0, 25], currencyCode: "USD" });
    if (url === "/api/v1/auth/context") return json(actor);
    return listReply();
  }
  sent = [
    ...sent,
    {
      method: req.method,
      url,
      body: await req.json(),
      idempotencyKey: req.headers.get("Idempotency-Key"),
    },
  ];
  const next = writeReplies.shift();
  if (!next) throw new TypeError("network down");
  return next();
}

interface Actor {
  userId: string;
  organizationId: string;
  roles: string[];
  permissions: string[];
}
const WRITER: Actor = {
  userId: "u1",
  organizationId: "o1",
  roles: ["platform_billing_admin"],
  permissions: ["plan.admin.read", "plan.admin.write"],
};
const READER: Actor = { ...WRITER, permissions: ["plan.admin.read"] };
let actor: Actor = WRITER;

function mount(path = "/admin/pricing-plans", as: Actor = WRITER): void {
  actor = as;
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/pricing-plans" element={<PricingPlans />} />
          <Route path="/step-up" element={<p>step-up page</p>} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const REASON = "Launch pricing for the first tenants";
const dialog = (): HTMLElement => screen.getByRole("dialog");
function confirmWithReason(label: string, reason = REASON): void {
  fireEvent.change(within(dialog()).getByRole("textbox"), { target: { value: reason } });
  fireEvent.click(within(dialog()).getByRole("button", { name: label }));
}
const drawer = (name = "Price plan"): Promise<HTMLElement> =>
  screen.findByRole("complementary", { name });

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  sent = [];
  list = [DRAFT];
  listReply = () => json(list);
  writeReplies = [];
});

describe("money and percentage parsing", () => {
  it("takes plain decimals with at most two places, by string math", () => {
    expect(parsePriceCents("19.99")).toBe(1999);
    expect(parsePriceCents("49")).toBe(4900);
    expect(parsePriceCents("0.1")).toBe(10);
    expect(parsePercentBps("4.5")).toBe(450);
    expect(parsePercentBps("100")).toBe(10_000);
  });

  it("refuses more than two decimals, signs, exponents, hex, binary and values above the cap", () => {
    for (const raw of [
      "1.005",
      "0.145",
      "49.999",
      "0x1f",
      "0b11",
      "1e3",
      "-1",
      "+1",
      "Infinity",
      "",
      "abc",
      "1,000",
    ])
      expect(parsePriceCents(raw)).toBeNull();
    expect(parsePercentBps("-0.004")).toBeNull();
    expect(parsePercentBps("100.01")).toBeNull();
    expect(parsePriceCents("1000000000.01", 100_000_000_000)).toBeNull();
    expect(parsePriceCents("1000000000", 100_000_000_000)).toBe(100_000_000_000);
  });
});

describe("pricingFormErrors", () => {
  const valid = {
    familySlug: "hospice-core",
    name: "Hospice core",
    perUserPrice: "49",
    bandFees: ["1000", "2000"],
    billingSoftwarePct: "2.5",
    managedBillingPct: "4.5",
    termMonths: "12",
    implementationFee: "0",
    minimumMonthly: "",
  };

  it("passes a valid form, and names every field that cannot be sent", () => {
    expect(pricingFormErrors(valid)).toEqual({});
    const errors = pricingFormErrors({
      ...valid,
      familySlug: "X",
      name: "",
      bandFees: ["1000", ""],
      managedBillingPct: "450",
      termMonths: "0",
    });
    expect(Object.keys(errors).sort()).toEqual(
      ["band1", "familySlug", "managedBillingPct", "name", "termMonths"].sort(),
    );
  });

  it("mirrors the server's rules: managed never below software, bands never cheaper going up, the caps", () => {
    expect(pricingFormErrors({ ...valid, managedBillingPct: "2" }).managedBillingPct).toMatch(
      /cannot cost less than billing software/,
    );
    expect(pricingFormErrors({ ...valid, bandFees: ["2000", "1000"] }).band1).toMatch(
      /cannot cost less than the band below/,
    );
    expect(pricingFormErrors({ ...valid, name: "x".repeat(121) }).name).toMatch(/120 characters/);
    expect(pricingFormErrors({ ...valid, familySlug: "a".repeat(65) }).familySlug).toBeTruthy();
    expect(pricingFormErrors({ ...valid, perUserPrice: "10000000.01" }).perUserPrice).toBeTruthy();
    expect(pricingFormErrors({ ...valid, termMonths: "1e1" }).termMonths).toBeTruthy();
  });

  it("an edit does not check the plan family (a draft keeps its family)", () => {
    expect(pricingFormErrors({ ...valid, familySlug: "" }, "edit")).toEqual({});
  });
});

describe("actionsFor", () => {
  it("offers only what the server allows for each status", () => {
    expect(actionsFor(DRAFT, [DRAFT])).toEqual(["publish"]);
    expect(actionsFor(PUBLISHED, [PUBLISHED])).toEqual(["new-version", "archive"]);
    // The family already has a draft: a new version would be refused.
    expect(actionsFor(PUBLISHED, [PUBLISHED, NEXT_DRAFT])).toEqual(["archive"]);
    const archived: Plan = { ...PUBLISHED, status: "archived" };
    expect(actionsFor(archived, [archived])).toEqual(["new-version"]);
    // A newer version exists: copying this one would copy stale prices.
    const newer: Plan = { ...NEXT_DRAFT, status: "published" };
    expect(actionsFor(archived, [archived, newer])).toEqual([]);
  });
});

describe("PricingPlans", () => {
  it("a draft offers Edit prices and Publish, never Archive or a new version", async () => {
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await drawer();
    expect(within(d).getByText("2.5% of net collections")).toBeTruthy();
    expect(within(d).getByRole("button", { name: "Edit prices" })).toBeTruthy();
    expect(within(d).getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(within(d).queryByRole("button", { name: "Archive" })).toBeNull();
    expect(within(d).queryByRole("button", { name: "Start a new version" })).toBeNull();
  });

  it("an operator without plan.admin.write sees the plans but no write buttons", async () => {
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`, READER);
    const d = await drawer();
    expect(within(d).getByText("2.5% of net collections")).toBeTruthy();
    expect(within(d).queryByRole("button", { name: "Publish" })).toBeNull();
    expect(within(d).queryByRole("button", { name: "Edit prices" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New plan" })).toBeNull();
  });

  it("publishes only after a reason, says the prices freeze, and sends an Idempotency-Key", async () => {
    writeReplies = [() => json({ ...DRAFT, status: "published" })];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Publish" }));
    expect(within(dialog()).getByText(/freezes these prices for good/)).toBeTruthy();
    expect(sent).toHaveLength(0);
    list = [{ ...DRAFT, status: "published" }];
    confirmWithReason("Publish");
    expect(await screen.findByText(/"Hospice core" published/)).toBeTruthy();
    expect(sent).toEqual([
      {
        method: "POST",
        url: `/api/admin/pricing/plans/${DRAFT.id}/publish`,
        body: { reason: REASON },
        idempotencyKey: expect.any(String),
      },
    ]);
  });

  it("a refusal stays in the dialog with the typed reason and the server's words; the retry is a new attempt on a new key", async () => {
    writeReplies = [
      () =>
        refusal(409, "CONFLICT", "only a draft can be edited or published; this plan is published"),
      () => json({ ...DRAFT, status: "published" }),
    ];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Publish" }));
    confirmWithReason("Publish");
    expect(
      await within(dialog()).findByText(
        "Could not publish the plan. Only a draft can be edited or published; this plan is published.",
      ),
    ).toBeTruthy();
    expect((within(dialog()).getByRole("textbox") as HTMLTextAreaElement).value).toBe(REASON);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Publish" }));
    await screen.findByText(/"Hospice core" published/);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.idempotencyKey).not.toBe(sent[1]?.idempotencyKey);
  });

  it("a step-up refusal offers Re-verify in the dialog", async () => {
    list = [PUBLISHED];
    writeReplies = [() => refusal(403, "STEP_UP_REQUIRED", "refused")];
    mount(`/admin/pricing-plans?plan=${PUBLISHED.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Archive" }));
    expect(within(dialog()).getByText(/keep their contract and price/)).toBeTruthy();
    confirmWithReason("Archive");
    expect(await within(dialog()).findByRole("link", { name: "Re-verify" })).toBeTruthy();
  });

  it("archives a published plan", async () => {
    list = [PUBLISHED];
    writeReplies = [() => json({ ...PUBLISHED, status: "archived" })];
    mount(`/admin/pricing-plans?plan=${PUBLISHED.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Archive" }));
    list = [{ ...PUBLISHED, status: "archived" }];
    confirmWithReason("Archive");
    expect(await screen.findByText(/"Hospice core" archived/)).toBeTruthy();
    expect(sent[0]?.url).toBe(`/api/admin/pricing/plans/${PUBLISHED.id}/archive`);
  });

  it("a new version opens the new draft", async () => {
    list = [PUBLISHED];
    writeReplies = [() => json(NEXT_DRAFT, 201)];
    mount(`/admin/pricing-plans?plan=${PUBLISHED.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Start a new version" }));
    list = [PUBLISHED, NEXT_DRAFT];
    confirmWithReason("Start a new version");
    expect(await screen.findByText(/copied to a new draft version/)).toBeTruthy();
    const d = await drawer();
    expect(within(d).getByRole("heading", { name: "Version 2" })).toBeTruthy();
    expect(within(d).getByRole("button", { name: "Edit prices" })).toBeTruthy();
  });

  it("a dropped connection says so and leaves the dialog usable", async () => {
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Publish" }));
    confirmWithReason("Publish");
    expect(await within(dialog()).findByText(/Could not reach the server/)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a double submit sends one request", async () => {
    writeReplies = [() => json({ ...DRAFT, status: "published" })];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Publish" }));
    fireEvent.change(within(dialog()).getByRole("textbox"), { target: { value: REASON } });
    const confirm = within(dialog()).getByRole("button", { name: "Publish" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByText(/"Hospice core" published/);
    expect(sent).toHaveLength(1);
  });

  it("a reason that is too short sends nothing", async () => {
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Publish" }));
    confirmWithReason("Publish", "ok");
    expect(within(dialog()).getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
    expect(sent).toHaveLength(0);
  });

  it("load failures: a 500 offers Try again, a 403 says who has access, a dropped connection says so", async () => {
    listReply = () => refusal(500, "INTERNAL", "boom");
    mount();
    expect(await screen.findByText("Price plans unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    cleanup();
    listReply = () => refusal(403, "FORBIDDEN", "no");
    mount();
    expect(await screen.findByText(/do not have access to price plans/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    cleanup();
    listReply = () => {
      throw new TypeError("network down");
    };
    mount();
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
  });

  it("an empty catalog says what to do", async () => {
    list = [];
    mount();
    expect(await screen.findByText(/No price plans yet/)).toBeTruthy();
  });

  it("a link to a plan that is not in the list opens no drawer", async () => {
    mount("/admin/pricing-plans?plan=99999999-9999-4999-8999-999999999999");
    expect(await screen.findByText("Hospice core")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Price plan" })).toBeNull();
  });

  it("the create form refuses what the server would, and focuses the first problem", async () => {
    mount("/admin/pricing-plans?plan=new");
    const form = await drawer("New price plan");
    fireEvent.click(within(form).getByRole("button", { name: "Create draft" }));
    const family = within(form).getByLabelText(/Plan family/);
    expect(family.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(family));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  const fill = (form: HTMLElement): void => {
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
  };

  it("creates a draft: shows what will be recorded, then sends dollars as cents and percentages as basis points", async () => {
    writeReplies = [() => json(DRAFT, 201)];
    mount("/admin/pricing-plans?plan=new");
    const form = await drawer("New price plan");
    fill(form);
    fireEvent.click(within(form).getByRole("button", { name: "Create draft" }));
    expect(within(dialog()).getByText("$49.00 a month")).toBeTruthy();
    expect(within(dialog()).getByText("2.50% of net collections")).toBeTruthy();
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

  it("a step-up refusal on create keeps the typed form for the return from Re-verify", async () => {
    writeReplies = [() => refusal(403, "STEP_UP_REQUIRED", "refused")];
    mount("/admin/pricing-plans?plan=new");
    fill(await drawer("New price plan"));
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    confirmWithReason("Create draft");
    fireEvent.click(await within(dialog()).findByRole("link", { name: "Re-verify" }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    cleanup();
    mount("/admin/pricing-plans?plan=new");
    const form = await drawer("New price plan");
    expect((within(form).getByLabelText(/Plan family/) as HTMLInputElement).value).toBe(
      "hospice-core",
    );
    expect((within(form).getByLabelText(/Per user a month/) as HTMLInputElement).value).toBe("49");
  });

  it("edits a draft's prices in place (PUT, no plan family)", async () => {
    writeReplies = [() => json({ ...DRAFT, perUserPriceCents: 5500 })];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await drawer();
    fireEvent.click(within(d).getByRole("button", { name: "Edit prices" }));
    const price = within(d).getByLabelText(/Per user a month/) as HTMLInputElement;
    expect(price.value).toBe("49");
    expect(within(d).queryByLabelText(/Plan family/)).toBeNull();
    fireEvent.change(price, { target: { value: "55" } });
    list = [{ ...DRAFT, perUserPriceCents: 5500 }];
    fireEvent.click(within(d).getByRole("button", { name: "Save prices" }));
    confirmWithReason("Save prices");
    expect(await screen.findByText(/"Hospice core" prices saved/)).toBeTruthy();
    expect(sent[0]).toEqual({
      method: "PUT",
      url: `/api/admin/pricing/plans/${DRAFT.id}`,
      body: {
        name: "Hospice core",
        perUserPriceCents: 5500,
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
      },
      idempotencyKey: expect.any(String),
    });
    await waitFor(() => expect(within(d).getByText("$55.00 a month")).toBeTruthy());
  });
});
