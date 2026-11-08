import {
  ApiClientProvider,
  createApiClient,
  discardStepUpDrafts,
  parsePriceCents,
} from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — the price-plans screen: lists the plans, offers only the writes a plan's status
// allows (and only to an operator holding plan.admin.write), asks for a reason before every write, sends one Idempotency-Key per
// attempt, keeps a refusal in the dialog with the server's reason, and keeps a typed form across a step-up round trip.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PricingPlan,
  actionsFor,
  failureText,
  parsePercentBps,
  pricesOf,
  pricingFormErrors,
  serverFieldErrors,
} from "../pricing-plan-model";
import { PricingPlans } from "../pricing-plans";

const DRAFT = {
  id: "11111111-1111-4111-8111-111111111111",
  familySlug: "hospice-core",
  version: 1,
  slug: "hospice-core-v1",
  name: "Hospice core",
  description: null as string | null,
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
  ifMatch: string | null;
}
let sent: Sent[] = [];
let list: Plan[] = [DRAFT];
let listReply: () => Response = () => json(list);
let writeReplies: Array<() => Response> = [];
/** GET /api/admin/pricing/plans/:id (the action dialog's re-read); default: the plan as the list has it. */
let getReply: ((id: string) => Response) | null = null;
let actorReply: () => Response = () => json(actor);

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url).pathname;
  if (req.method === "GET") {
    if (url === "/api/admin/pricing/defaults")
      return json({ bandThresholds: [0, 25], currencyCode: "USD" });
    if (url === "/api/v1/auth/context") return actorReply();
    const one = /^\/api\/admin\/pricing\/plans\/([^/]+)$/.exec(url)?.[1];
    if (one) {
      if (getReply) return getReply(one);
      const found = list.find((p) => p.id === one);
      return found ? json(found) : refusal(404, "NOT_FOUND", "plan not found");
    }
    return listReply();
  }
  sent = [
    ...sent,
    {
      method: req.method,
      url,
      body: await req.json(),
      idempotencyKey: req.headers.get("Idempotency-Key"),
      ifMatch: req.headers.get("If-Match"),
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

beforeEach(() => {
  window.sessionStorage.clear();
  discardStepUpDrafts();
});
afterEach(() => {
  cleanup();
  sent = [];
  list = [DRAFT];
  listReply = () => json(list);
  writeReplies = [];
  getReply = null;
  actorReply = () => json(actor);
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

  it("given the census thresholds, refuses a form without one fee per band; pricesOf then sends nothing", () => {
    expect(pricingFormErrors(valid, "edit", [0, 50])).toEqual({});
    expect(pricingFormErrors(valid, "edit", [0, 50, 100]).band0).toMatch(/census bands changed/);
    expect(pricesOf(valid, [0, 50])?.bands).toEqual([
      { minAdc: 0, monthlyFeeCents: 100000 },
      { minAdc: 50, monthlyFeeCents: 200000 },
    ]);
    expect(pricesOf(valid, [0, 50, 100])).toBeNull();
    expect(pricesOf(valid, [0])).toBeNull();
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
    expect(within(d).getByText("2.50% of net collections")).toBeTruthy();
    expect(within(d).getByText("12 months")).toBeTruthy();
    expect(within(d).getByRole("button", { name: "Edit prices" })).toBeTruthy();
    expect(within(d).getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(within(d).queryByRole("button", { name: "Archive" })).toBeNull();
    expect(within(d).queryByRole("button", { name: "Start a new version" })).toBeNull();
  });

  it("an operator without plan.admin.write sees the plans but no write buttons", async () => {
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`, READER);
    const d = await drawer();
    expect(within(d).getByText("2.50% of net collections")).toBeTruthy();
    expect(within(d).queryByRole("button", { name: "Publish" })).toBeNull();
    expect(within(d).queryByRole("button", { name: "Edit prices" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New plan" })).toBeNull();
  });

  it("publishes only after a reason, shows the prices that freeze, and sends an Idempotency-Key and the version read", async () => {
    writeReplies = [() => json({ ...DRAFT, status: "published" })];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Publish" }));
    expect(within(dialog()).getByText(/freezes these prices for good/)).toBeTruthy();
    expect(within(dialog()).getByText("$49.00 a month")).toBeTruthy();
    expect(within(dialog()).queryByText(/changed since you opened it/)).toBeNull();
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
        ifMatch: `"${DRAFT.updatedAt}"`,
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
    // the Archive button is gone; focus is on the drawer, not lost to the page
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("complementary", { name: "Price plan" }),
      ),
    );
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
    const reVerify = await within(dialog()).findByRole("link", { name: "Re-verify" });
    fireEvent.change(within(dialog()).getByRole("textbox"), {
      target: { value: "Edited after the refusal, ticket PRICE-12" },
    });
    fireEvent.click(reVerify);
    expect(await screen.findByText("step-up page")).toBeTruthy();
    cleanup();
    mount("/admin/pricing-plans?plan=new");
    const form = await drawer("New price plan");
    expect((within(form).getByLabelText(/Plan family/) as HTMLInputElement).value).toBe(
      "hospice-core",
    );
    expect((within(form).getByLabelText(/Per user a month/) as HTMLInputElement).value).toBe("49");
    // the reason comes back too: the live text typed after the refusal, shown when the dialog next opens
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect((within(dialog()).getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Edited after the refusal, ticket PRICE-12",
    );
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
        description: null,
        reason: REASON,
      },
      idempotencyKey: expect.any(String),
      ifMatch: `"${DRAFT.updatedAt}"`,
    });
    await waitFor(() => expect(within(d).getByText("$55.00 a month")).toBeTruthy());
  });
  const editPrice = async (value: string): Promise<HTMLElement> => {
    const d = await drawer();
    fireEvent.click(within(d).getByRole("button", { name: "Edit prices" }));
    fireEvent.change(within(d).getByLabelText(/Per user a month/), { target: { value } });
    return d;
  };
  const perUser = (d: HTMLElement): string =>
    (within(d).getByLabelText(/Per user a month/) as HTMLInputElement).value;

  it("edit: a step-up refusal restores the typed prices once; Cancel drops them, so re-editing shows the saved prices", async () => {
    writeReplies = [() => refusal(403, "STEP_UP_REQUIRED", "refused")];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await editPrice("77");
    fireEvent.click(within(d).getByRole("button", { name: "Save prices" }));
    confirmWithReason("Save prices");
    fireEvent.click(await within(dialog()).findByRole("link", { name: "Re-verify" }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    cleanup();
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const back = await drawer();
    expect(perUser(back)).toBe("77"); // the editor reopened with the typed prices
    fireEvent.click(within(back).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(back).getByRole("button", { name: "Edit prices" }));
    expect(perUser(back)).toBe("49"); // the stash was consumed: the saved prices, not the discarded edit
  });

  it("edit: a save sends the plan's description back as read (a save never erases it)", async () => {
    const described = { ...DRAFT, description: "DEMO prices for local development" };
    list = [described];
    writeReplies = [() => json({ ...described, perUserPriceCents: 5500 })];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await editPrice("55");
    fireEvent.click(within(d).getByRole("button", { name: "Save prices" }));
    confirmWithReason("Save prices");
    await screen.findByText(/"Hospice core" prices saved/);
    expect((sent[0]?.body as { description: string }).description).toBe(
      "DEMO prices for local development",
    );
  });

  it("edit: focus moves to the first field when editing starts and back to the drawer on Cancel", async () => {
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await drawer();
    fireEvent.click(within(d).getByRole("button", { name: "Edit prices" }));
    await waitFor(() => expect(document.activeElement).toBe(within(d).getByLabelText(/^Name/)));
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(d));
  });

  it("edit: a field the server refuses is marked on the form, the dialog closes, and the reason comes back on the next try", async () => {
    writeReplies = [
      () =>
        json(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "the plan's prices are not valid",
              correlationId: "c",
              details: [
                {
                  field: "bands[1].monthlyFeeCents",
                  code: "MONEY_INVALID",
                  message: "a band fee is whole cents, 0 or more",
                },
              ],
            },
          },
          422,
        ),
    ];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await editPrice("55");
    fireEvent.click(within(d).getByRole("button", { name: "Save prices" }));
    confirmWithReason("Save prices");
    const band = within(d).getByLabelText(/Census band 25\+/);
    await waitFor(() => expect(band.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(band));
    fireEvent.click(within(d).getByRole("button", { name: "Save prices" }));
    expect((within(dialog()).getByRole("textbox") as HTMLTextAreaElement).value).toBe(REASON);
  });

  const changedReply = (updatedAt: string) => () =>
    json(
      {
        error: {
          code: "PRICING_PLAN_CHANGED",
          message: "this plan changed since you read it; re-read it and confirm again",
          correlationId: "c",
          details: [
            { field: "currentUpdatedAt", code: "PRICING_PLAN_CHANGED", message: updatedAt },
          ],
        },
      },
      409,
    );

  it("edit: a draft changed by someone else (409) closes the editor, shows what the draft says now, and sends nothing more", async () => {
    const changed = { ...DRAFT, perUserPriceCents: 6100, updatedAt: "2026-11-08T12:00:00.000Z" };
    writeReplies = [changedReply(changed.updatedAt)];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await editPrice("55");
    list = [changed];
    fireEvent.click(within(d).getByRole("button", { name: "Save prices" }));
    confirmWithReason("Save prices");
    expect(
      await within(d).findByText(/Someone changed this plan since you opened it/),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(d).queryByLabelText(/Per user a month/)).toBeNull(); // the editor closed
    await waitFor(() => expect(within(d).getByText("$61.00 a month")).toBeTruthy());
    expect(sent).toHaveLength(1); // no blind second save
    // editing again starts from the fresh prices, pinned to the fresh version
    fireEvent.click(within(d).getByRole("button", { name: "Edit prices" }));
    expect(perUser(d)).toBe("61");
    expect(within(d).queryByText(/Someone changed this plan/)).toBeNull();
  });

  it("edit: a Re-verify draft keeps the version it was typed against, so a save after someone else's is refused, not an overwrite", async () => {
    writeReplies = [() => refusal(403, "STEP_UP_REQUIRED", "refused")];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await editPrice("77");
    fireEvent.click(within(d).getByRole("button", { name: "Save prices" }));
    confirmWithReason("Save prices");
    fireEvent.click(await within(dialog()).findByRole("link", { name: "Re-verify" }));
    await screen.findByText("step-up page");
    cleanup();
    // meanwhile another operator saved the draft
    list = [{ ...DRAFT, updatedAt: "2026-11-08T12:00:00.000Z" }];
    writeReplies = [changedReply("2026-11-08T12:00:00.000Z")];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const back = await drawer();
    expect(perUser(back)).toBe("77");
    fireEvent.click(within(back).getByRole("button", { name: "Save prices" }));
    confirmWithReason("Save prices");
    expect(await within(back).findByText(/Someone changed this plan/)).toBeTruthy();
    expect(sent.map((x) => x.ifMatch)).toEqual([`"${DRAFT.updatedAt}"`, `"${DRAFT.updatedAt}"`]);
  });

  it("edit: a reload that finds the plan no longer a draft closes the editor", async () => {
    writeReplies = [changedReply("2026-11-08T12:00:00.000Z")];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await editPrice("55");
    list = [{ ...DRAFT, status: "published", updatedAt: "2026-11-08T12:00:00.000Z" }];
    fireEvent.click(within(d).getByRole("button", { name: "Save prices" }));
    confirmWithReason("Save prices");
    await waitFor(() =>
      expect(within(d).queryByRole("button", { name: "Edit prices" })).toBeNull(),
    );
    expect(within(d).queryByLabelText(/Per user a month/)).toBeNull();
  });

  it("publish: the dialog re-reads the plan and shows what changed since the drawer was read, then pins that read", async () => {
    const repriced = { ...DRAFT, perUserPriceCents: 49000, updatedAt: "2026-11-08T12:00:00.000Z" };
    getReply = () => json(repriced);
    writeReplies = [() => json({ ...repriced, status: "published" })];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Publish" }));
    expect(await within(dialog()).findByText("$490.00 a month")).toBeTruthy();
    expect(within(dialog()).getByText(/changed since you opened it/)).toBeTruthy();
    confirmWithReason("Confirm the updated record: Publish");
    await screen.findByText(/"Hospice core" published/);
    expect(sent[0]?.ifMatch).toBe(`"${repriced.updatedAt}"`);
  });

  it("publish: a 409 PRICING_PLAN_CHANGED re-reads the plan in the dialog and asks again", async () => {
    const repriced = { ...DRAFT, perUserPriceCents: 49000, updatedAt: "2026-11-08T12:00:00.000Z" };
    let reads = 0;
    getReply = () => {
      reads += 1;
      return json(reads === 1 ? DRAFT : repriced);
    };
    writeReplies = [
      () =>
        refusal(
          409,
          "PRICING_PLAN_CHANGED",
          "this plan changed since you read it; re-read it and confirm again",
        ),
    ];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(reads).toBe(1));
    confirmWithReason("Publish");
    expect(await within(dialog()).findByText("$490.00 a month")).toBeTruthy();
    expect(within(dialog()).getByText(/changed since you opened it/)).toBeTruthy();
    expect(
      within(dialog()).getByText(/Could not publish the plan\. This plan changed/),
    ).toBeTruthy();
  });

  it("a write refused 403 (not a step-up) or 500 says so in the dialog", async () => {
    writeReplies = [
      () => refusal(403, "FORBIDDEN", "permission denied"),
      () => refusal(500, "INTERNAL", "an unexpected error occurred"),
    ];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Publish" }));
    confirmWithReason("Publish");
    expect(
      await within(dialog()).findByText(/Could not publish the plan\. You do not have access/),
    ).toBeTruthy();
    expect(within(dialog()).queryByRole("link", { name: "Re-verify" })).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Publish" }));
    expect(
      await within(dialog()).findByText(
        "Could not publish the plan. An unexpected error occurred.",
      ),
    ).toBeTruthy();
  });

  it("a write that lands but whose reload fails shows the error and no stale drawer", async () => {
    writeReplies = [() => json({ ...DRAFT, status: "published" })];
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    fireEvent.click(within(await drawer()).getByRole("button", { name: "Publish" }));
    listReply = () => refusal(500, "INTERNAL", "boom");
    confirmWithReason("Publish");
    expect(await screen.findByText("Price plans unavailable.")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Price plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });

  it("Escape closes the drawer again after a dialog the operator typed in was cancelled", async () => {
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await drawer();
    fireEvent.click(within(d).getByRole("button", { name: "Publish" }));
    fireEvent.change(within(dialog()).getByRole("textbox"), { target: { value: "typed" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(d, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Price plan" })).toBeNull(),
    );
  });

  it("no write buttons when the actor context cannot be read (fail closed)", async () => {
    actorReply = () => refusal(500, "INTERNAL", "boom");
    mount(`/admin/pricing-plans?plan=${DRAFT.id}`);
    const d = await drawer();
    expect(within(d).queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New plan" })).toBeNull();
  });

  it("?plan=new for an operator who cannot write explains instead of showing nothing", async () => {
    mount("/admin/pricing-plans?plan=new", READER);
    expect(
      await screen.findByText(/Only a platform billing admin can create price plans/),
    ).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "New price plan" })).toBeNull();
  });
});

describe("the model's refusal helpers", () => {
  const failure = (fieldErrors: Record<string, string>) => ({
    kind: "validation" as const,
    code: "VALIDATION_FAILED",
    status: 422,
    message: "the plan's prices are not valid",
    fieldErrors,
    details: Object.entries(fieldErrors).map(([field, message]) => ({ field, code: "X", message })),
    current: null,
    blockedBy: null,
    correlationId: null,
  });

  it("maps the API's field names (and TypeBox paths) onto the form's inputs", () => {
    expect(
      serverFieldErrors(
        failure({
          perUserPriceCents: "perUserPriceCents must be whole cents, 0 or more",
          "bands.0.monthlyFeeCents": "a band fee is whole cents",
          "bands[1].monthlyFeeCents": "a band fee is whole cents",
          managedBillingBps: "managed billing cannot cost less than billing software",
          somethingElse: "ignored",
        }),
      ),
    ).toEqual({
      perUserPrice: "PerUserPriceCents must be whole cents, 0 or more.",
      band0: "A band fee is whole cents.",
      band1: "A band fee is whole cents.",
      managedBillingPct: "Managed billing cannot cost less than billing software.",
    });
  });

  it("says what failed, then the server's reason and its details, once each", () => {
    expect(
      failureText(failure({ name: "the plan's prices are not valid" }), "Could not save."),
    ).toBe("Could not save. The plan's prices are not valid.");
    // a stale pin's detail is a timestamp for a retry, never shown as a sentence
    expect(
      failureText(
        {
          ...failure({}),
          details: [{ field: "currentUpdatedAt", code: "X", message: "2026-11-08T12:00:00.000Z" }],
        },
        "Could not save.",
      ),
    ).toBe("Could not save. The plan's prices are not valid.");
  });

  it("a plan type check: the test fixtures are plans", () => {
    const plan: PricingPlan = DRAFT;
    expect(plan.id).toBe(DRAFT.id);
  });
});
