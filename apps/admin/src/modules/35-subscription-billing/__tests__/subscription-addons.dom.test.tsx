import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// ADR-0108 — the subscription detail's Add-ons panel: lists the subscription's add-ons, grants (or starts a trial of)
// the claims-billing add-on with a reason and an Idempotency-Key, cancels a live one, and shows the period's count.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AddonsPanel } from "../subscription-addons";

const SUB = "44444444-4444-4444-8444-444444444444";
const ADDON = "55555555-5555-4555-8555-555555555555";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seen {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | null;
}

function mount(rows: unknown[], usage: Parameters<typeof AddonsPanel>[0]["usage"] = null): Seen[] {
  const seen: Seen[] = [];
  let current = rows;
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    const text = await req.text();
    const path = new URL(req.url).pathname;
    seen.push({
      method: req.method,
      path,
      body: text ? JSON.parse(text) : undefined,
      idempotencyKey: req.headers.get("Idempotency-Key"),
    });
    if (req.method === "GET") return json(current);
    if (path.endsWith("/cancel")) {
      current = [{ ...(rows[0] as object), status: "canceled", live: false }];
      return json(current[0]);
    }
    current = [liveRow];
    return json(liveRow, 201);
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <AddonsPanel subscriptionId={SUB} usage={usage} />
    </ApiClientProvider>,
  );
  return seen;
}

const liveRow = {
  id: "66666666-6666-4666-8666-666666666666",
  organizationId: SUB,
  subscriptionId: SUB,
  addonId: ADDON,
  addonSlug: "claims_billing",
  addonName: "Claims billing",
  status: "active",
  live: true,
  trialEndsAt: null,
  startedAt: "2026-11-01T00:00:00.000Z",
  endsAt: null,
  canceledAt: null,
  grantedByMembershipId: null,
  grantReason: "signed order form",
};

afterEach(cleanup);

describe("Add-ons panel (ADR-0108)", () => {
  it("grants the add-on with the operator's reason and an Idempotency-Key", async () => {
    const seen = mount([]);
    expect(await screen.findByText("No add-ons on this subscription.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Grant add-on" }));
    expect(await screen.findByText("Give a reason (3+ characters).")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "signed order form" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant add-on" }));
    expect(await screen.findByText("Add-on granted.")).toBeTruthy();
    const post = seen.find((s) => s.method === "POST");
    expect(post).toMatchObject({
      path: `/api/admin/subscriptions/${SUB}/addons`,
      body: { addonSlug: "claims_billing", mode: "grant", reason: "signed order form" },
    });
    expect(post?.idempotencyKey).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Cancel add-on" })).toBeTruthy();
  });

  it("asks for the trial end before starting a trial", async () => {
    const seen = mount([]);
    await screen.findByText("No add-ons on this subscription.");
    fireEvent.change(screen.getByLabelText("Claims billing"), { target: { value: "trial" } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "30-day pilot" } });
    fireEvent.click(screen.getByRole("button", { name: "Start trial" }));
    expect(await screen.findByText("Pick the day the trial ends.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Trial ends/), { target: { value: "2026-12-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Start trial" }));
    await screen.findByText("Trial started.");
    expect(seen.find((s) => s.method === "POST")?.body).toMatchObject({
      mode: "trial",
      trialEndsAt: "2026-12-05T23:59:59.000Z",
    });
  });

  it("cancels a live add-on and shows the census count (not billed)", async () => {
    const seen = mount([liveRow], {
      addonSlug: "claims_billing",
      periodStart: "2026-11-01T00:00:00.000Z",
      periodEnd: "2026-12-01T00:00:00.000Z",
      activePatientCount: 42,
      unitPriceCents: null,
      computedAt: null,
    });
    expect(screen.getByText(/Active patients this period: 42/)).toBeTruthy();
    expect(screen.getByText(/price not set/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel add-on" }));
    expect(await screen.findByText(/Add-on canceled/)).toBeTruthy();
    await waitFor(() =>
      expect(
        seen.some((s) => s.path === `/api/admin/subscriptions/${SUB}/addons/${ADDON}/cancel`),
      ).toBe(true),
    );
  });
});
