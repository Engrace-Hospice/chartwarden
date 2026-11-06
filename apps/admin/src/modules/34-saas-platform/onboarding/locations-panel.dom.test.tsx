// @vitest-environment jsdom
// Step 6, Locations: the sites the tenant works from, entered on its behalf. The step settles on its own once a primary location
// exists (the platform checks right after each save), so there is no "mark done" to press unless it cannot read the fact.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LocationsPanel } from "./locations-panel";
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

const ENTITIES = "/api/v1/platform/tenants/{orgSlug}/provider-entities";
const LOCATIONS = "/api/v1/platform/tenants/{orgSlug}/locations";
const LOCATION = "/api/v1/platform/tenants/{orgSlug}/locations/{id}";
const PE = {
  id: "pe-1",
  ccn: "444444",
  npi: "1679576722",
  legalName: "Beta Hospice",
  status: "active",
};
const LOC = {
  id: "loc-1",
  providerEntityId: "pe-1",
  name: "Main office",
  addressLine1: "1 Valley Way",
  addressLine2: null,
  city: "Reno",
  state: "NV",
  postalCode: "89501",
  phone: null,
  fax: null,
  timezone: "America/Los_Angeles",
  status: "active",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const view = (over = {}) =>
  wizardView(
    [
      wizardStep("locations_seeded", 1, {
        title: "Locations",
        owner: "org_admin",
        completionMode: "either",
      }),
    ],
    over,
  );
function mount(locations: unknown[], extra: Parameters<typeof stubClient>[0] = {}, v = view()) {
  const client = stubClient({
    GET: { [ENTITIES]: () => ok({ items: [PE] }), [LOCATIONS]: () => ok({ items: locations }) },
    ...extra,
  });
  const ctx = panelCtx(v, "locations_seeded");
  renderAt("/x", [{ path: "/x", element: <LocationsPanel ctx={ctx} /> }], client);
  return { client, ctx };
}
beforeEach(() => window.sessionStorage.clear());

describe("LocationsPanel", () => {
  it("lists the locations, and says there are none yet", async () => {
    mount([LOC]);
    const table = await screen.findByRole("table", { name: "Locations" });
    expect(within(table).getByText("Main office")).toBeTruthy();
    expect(within(table).getByText(/Reno, NV 89501/)).toBeTruthy();
  });

  it("is honest when there is none", async () => {
    mount([]);
    expect(await screen.findByText(/No location yet/)).toBeTruthy();
    expect(screen.getByText(/At least one location/).closest("li")?.textContent).toMatch(/Not yet/);
  });

  it("needs a provider entity first, and says so", async () => {
    const client = stubClient({
      GET: { [ENTITIES]: () => ok({ items: [] }), [LOCATIONS]: () => ok({ items: [] }) },
    });
    renderAt(
      "/x",
      [{ path: "/x", element: <LocationsPanel ctx={panelCtx(view(), "locations_seeded")} /> }],
      client,
    );
    expect(await screen.findByText(/Add a provider entity first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add location" })).toBeNull();
  });

  it("creates a location under a provider entity behind a reason and an Idempotency-Key", async () => {
    const { client, ctx } = mount([], { POST: { [LOCATIONS]: () => ok(LOC, 201) } });
    await screen.findByText(/No location yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add location" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Main office" } });
    fireEvent.change(screen.getByLabelText("Address line 1"), {
      target: { value: "1 Valley Way" },
    });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Reno" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "nv" } });
    fireEvent.change(screen.getByLabelText("ZIP code"), { target: { value: "89501" } });
    fireEvent.change(screen.getByLabelText(/^Time zone/), {
      target: { value: "America/Los_Angeles" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Customer listed their sites on the kickoff call" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [
      string,
      { params: { path: unknown; header: Record<string, string> }; body: Record<string, unknown> },
    ];
    expect(path).toBe(LOCATIONS);
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG });
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.body).toEqual({
      providerEntityId: "pe-1",
      name: "Main office",
      addressLine1: "1 Valley Way",
      city: "Reno",
      state: "NV",
      postalCode: "89501",
      timezone: "America/Los_Angeles",
      reason: "Customer listed their sites on the kickoff call",
    });
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  it("checks the required address fields before it asks for a reason", async () => {
    mount([]);
    await screen.findByText(/No location yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add location" }));
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    expect(screen.getByText(/Enter the location name/)).toBeTruthy();
    expect(screen.getByText(/State is two letters/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("edits a location with a PATCH to that location", async () => {
    const { client } = mount([LOC], { PATCH: { [LOCATION]: () => ok(LOC) } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Main office" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Main campus" } });
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Renamed at the customer's request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    const [path, init] = client.PATCH.mock.calls[0] as [
      string,
      { params: { path: unknown }; body: Record<string, unknown> },
    ];
    expect(path).toBe(LOCATION);
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG, id: "loc-1" });
    expect(init.body).toMatchObject({
      name: "Main campus",
      reason: "Renamed at the customer's request",
    });
  });

  it("offers no writes when the step cannot be acted on", async () => {
    mount([LOC], {}, view({ tenantStatus: "active" }));
    await screen.findByRole("table", { name: "Locations" });
    expect(screen.queryByRole("button", { name: "Add location" })).toBeNull();
  });
});

describe("LocationsPanel: coming back from Re-verify", () => {
  it("restores an EDIT as an edit: the save is a PATCH to that location, never a duplicate create", async () => {
    mount([LOC], { PATCH: { [LOCATION]: () => refused(403, "STEP_UP_REQUIRED") } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Main office" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Main campus" } });
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Renamed at the customer's request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    cleanup();

    const { client } = mount([LOC], { PATCH: { [LOCATION]: () => ok(LOC) } });
    expect(((await screen.findByLabelText("Name")) as HTMLInputElement).value).toBe("Main campus");
    expect(screen.queryByLabelText("Provider entity")).toBeNull(); // an edit, not a create
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Renamed at the customer's request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    expect(client.POST).not.toHaveBeenCalled();
    const [path, init] = client.PATCH.mock.calls[0] as [string, { params: { path: unknown } }];
    expect(path).toBe(LOCATION);
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG, id: "loc-1" });
  });
});
