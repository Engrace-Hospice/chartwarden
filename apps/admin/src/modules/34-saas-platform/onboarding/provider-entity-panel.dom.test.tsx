// @vitest-environment jsdom
// Step 5, Provider entity & NPI: the CMS identity the tenant bills under, entered on its behalf. Each save is its own audited write
// (a reason, an Idempotency-Key); the EIN is write-once and never shown or kept.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ProviderEntityPanel } from "./provider-entity-panel";
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

const LIST = "/api/v1/platform/tenants/{orgSlug}/provider-entities";
const PATCH = "/api/v1/platform/tenants/{orgSlug}/provider-entities/{id}";
const ENTITY = {
  id: "pe-1",
  organizationId: "org-1",
  ccn: "444444",
  legalName: "Beta Hospice of the Valley",
  doingBusinessAs: null,
  fiscalIntermediary: null,
  npi: "1679576722",
  fiscalYearEnd: "0630",
  iqiesFacilityId: null,
  billingAddress: null,
  status: "active",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const view = (over = {}) =>
  wizardView(
    [wizardStep("ccn_registered", 1, { title: "Provider entity & NPI", owner: "either" })],
    over,
  );
function mount(items: unknown[], extra: Parameters<typeof stubClient>[0] = {}, v = view()) {
  const client = stubClient({ GET: { [LIST]: () => ok({ items }) }, ...extra });
  const ctx = panelCtx(v, "ccn_registered");
  renderAt("/x", [{ path: "/x", element: <ProviderEntityPanel ctx={ctx} /> }], client);
  return { client, ctx };
}
beforeEach(() => window.sessionStorage.clear());

const fillNew = () => {
  fireEvent.change(screen.getByLabelText("CCN"), { target: { value: "444444" } });
  fireEvent.change(screen.getByLabelText("NPI"), { target: { value: "1679576722" } });
  fireEvent.change(screen.getByLabelText("Legal name"), {
    target: { value: "Beta Hospice of the Valley" },
  });
  fireEvent.change(screen.getByLabelText(/^EIN/), { target: { value: "12-3456789" } });
  fireEvent.change(screen.getByLabelText(/^Fiscal year end/), { target: { value: "0630" } });
};

describe("ProviderEntityPanel", () => {
  it("lists the entities and says what is missing when there are none", async () => {
    mount([]);
    expect(await screen.findByText(/No provider entity yet/)).toBeTruthy();
    expect(screen.getByText(/At least one provider entity/).closest("li")?.textContent).toMatch(
      /Not yet/,
    );
  });

  it("shows each entity with its CCN, NPI and status, and the facts that hold", async () => {
    mount([ENTITY]);
    const table = await screen.findByRole("table", { name: "Provider entities" });
    expect(within(table).getByText("444444")).toBeTruthy();
    expect(within(table).getByText("1679576722")).toBeTruthy();
    expect(screen.getByText(/At least one provider entity/).closest("li")?.textContent).toMatch(
      /Met/,
    );
    expect(screen.getByRole("link", { name: /NPI verification/ }).getAttribute("href")).toBe(
      "/admin/billing/npi-verifications",
    );
  });

  it("creates an entity behind a reason, with one Idempotency-Key, and reloads", async () => {
    const created = { ...ENTITY };
    const { client, ctx } = mount([], { POST: { [LIST]: () => ok(created, 201) } });
    await screen.findByText(/No provider entity yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add provider entity" }));
    fillNew();
    fireEvent.click(screen.getByRole("button", { name: "Save provider entity" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Customer asked support to enter their CMS identity" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [
      string,
      { params: { path: unknown; header: Record<string, string> }; body: Record<string, unknown> },
    ];
    expect(path).toBe(LIST);
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG });
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.body).toMatchObject({
      ccn: "444444",
      npi: "1679576722",
      legalName: "Beta Hospice of the Valley",
      taxId: "12-3456789",
      fiscalYearEnd: "0630",
      reason: "Customer asked support to enter their CMS identity",
    });
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  it("checks the CCN, NPI and fiscal year end before it asks for a reason", async () => {
    mount([]);
    await screen.findByText(/No provider entity yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add provider entity" }));
    fireEvent.click(screen.getByRole("button", { name: "Save provider entity" }));
    expect(screen.getByText(/CCN is six letters or digits/)).toBeTruthy();
    expect(screen.getByText(/NPI is ten digits/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("edits an entity without offering the CCN, NPI or EIN, which the tenant's own record fixes", async () => {
    const { client } = mount([ENTITY], { PATCH: { [PATCH]: () => ok(ENTITY) } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit 444444" }));
    expect(screen.queryByLabelText("CCN")).toBeNull();
    expect(screen.queryByLabelText(/^EIN/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Legal name"), {
      target: { value: "Beta Hospice, LLC" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save provider entity" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Legal name corrected per the customer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    const [path, init] = client.PATCH.mock.calls[0] as [
      string,
      { params: { path: unknown }; body: Record<string, unknown> },
    ];
    expect(path).toBe(PATCH);
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG, id: "pe-1" });
    expect(init.body).toMatchObject({
      legalName: "Beta Hospice, LLC",
      reason: "Legal name corrected per the customer",
    });
  });

  it("never stashes the EIN through a re-verify, and keeps the rest", async () => {
    mount([], { POST: { [LIST]: () => refused(403, "STEP_UP_REQUIRED") } });
    await screen.findByText(/No provider entity yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add provider entity" }));
    fillNew();
    fireEvent.click(screen.getByRole("button", { name: "Save provider entity" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Customer asked support to enter it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    const stashed =
      window.sessionStorage.getItem(
        "wx.admin.step-up-draft:wizard:cedar-ridge:ccn_registered:entity",
      ) ?? "";
    expect(stashed).toContain("Beta Hospice of the Valley");
    expect(stashed).not.toContain("12-3456789");
  });

  it("offers no writes when the step cannot be acted on", async () => {
    mount([ENTITY], {}, view({ tenantStatus: "provisioning" }));
    await screen.findByRole("table", { name: "Provider entities" });
    expect(screen.queryByRole("button", { name: "Add provider entity" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit 444444" })).toBeNull();
  });

  it("says when the list cannot be loaded", async () => {
    const client = stubClient({ GET: { [LIST]: () => refused(500, "INTERNAL_ERROR") } });
    renderAt(
      "/x",
      [{ path: "/x", element: <ProviderEntityPanel ctx={panelCtx(view(), "ccn_registered")} /> }],
      client,
    );
    expect(await screen.findByText(/Could not load the provider entities/)).toBeTruthy();
  });
});
