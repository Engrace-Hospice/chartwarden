// @vitest-environment jsdom
// A new tenant has no provider entity (CCN / NPI / EIN) and no service location, and nothing in either app created
// them — the ops runbook said "psql or scripts/db/seed.ts". The onboarding checks (`ccn_registered`, `org_seeded`,
// `locations_seeded`) read exactly these rows, so a tenant could not finish onboarding on its own. This screen
// creates both through the existing M2 org-admin routes.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { AgencySetup } from "./agency-setup";

const ENTITY = {
  id: "pe-1",
  legalName: "Cedar Ridge Hospice LLC",
  doingBusinessAs: null,
  ccn: "051234",
  npi: "1234567893",
  status: "active",
};
const LOCATION = {
  id: "loc-1",
  providerEntityId: "pe-1",
  name: "Main office",
  addressLine1: "1 Cedar Way",
  addressLine2: null,
  city: "Fresno",
  state: "CA",
  postalCode: "93701",
  timezone: "America/Los_Angeles",
  status: "active",
};
const page = (...items: unknown[]) => ({ data: { items, nextCursor: null } });

function client(over: {
  entities?: unknown[];
  locations?: unknown[];
  post?: ReturnType<typeof vi.fn>;
}) {
  const GET = vi.fn(async (path: string) =>
    path === "/api/v1/provider-entities"
      ? page(...(over.entities ?? []))
      : page(...(over.locations ?? [])),
  );
  const POST = over.post ?? vi.fn(async () => ({ data: {} }));
  return { GET, POST };
}

function mount(c: unknown): void {
  render(
    <ApiClientProvider client={c as ApiClient}>
      <AgencySetup />
    </ApiClientProvider>,
  );
}

const type = (label: RegExp | string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

function fillEntity(): void {
  type(/legal name/i, "Cedar Ridge Hospice LLC");
  type(/^CCN/i, "051234");
  type(/^NPI/i, "1234567893");
  type(/tax id/i, "12-3456789");
  type(/fiscal year end/i, "1231");
}

describe("AgencySetup", () => {
  it("lists the provider entities and locations that already exist", async () => {
    mount(client({ entities: [ENTITY], locations: [LOCATION] }));

    const entities = await screen.findByRole("region", { name: "Provider entities" });
    expect(await within(entities).findByText("Cedar Ridge Hospice LLC")).toBeTruthy();
    const locations = screen.getByRole("region", { name: "Locations" });
    expect(await within(locations).findByText("Main office")).toBeTruthy();
  });

  it("creates a provider entity with the CMS identity and reloads", async () => {
    const c = client({ post: vi.fn(async () => ({ data: { id: "pe-2" } })) });
    mount(c);

    await screen.findByRole("button", { name: /add provider entity/i });
    fillEntity();
    fireEvent.click(screen.getByRole("button", { name: /add provider entity/i }));

    await waitFor(() =>
      expect(c.POST).toHaveBeenCalledWith("/api/v1/provider-entities", {
        body: {
          legalName: "Cedar Ridge Hospice LLC",
          ccn: "051234",
          npi: "1234567893",
          taxId: "12-3456789",
          fiscalYearEnd: "1231",
        },
      }),
    );
    await waitFor(() => expect(c.GET.mock.calls.length).toBeGreaterThan(2));
  });

  it("refuses a malformed CCN or NPI without sending a request", async () => {
    const c = client({});
    mount(c);

    await screen.findByRole("button", { name: /add provider entity/i });
    fillEntity();
    type(/^CCN/i, "12");
    type(/^NPI/i, "123");
    fireEvent.click(screen.getByRole("button", { name: /add provider entity/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/CCN.*6|NPI.*10/i);
    expect(c.POST).not.toHaveBeenCalled();
  });

  it("shows the server's reason, e.g. the unbound tax-id cipher", async () => {
    const c = client({
      post: vi.fn(async () => ({
        error: {
          error: {
            code: "TAX_ID_CIPHER_UNBOUND",
            message: "the tax-id envelope cipher is not bound",
          },
        },
      })),
    });
    mount(c);

    await screen.findByRole("button", { name: /add provider entity/i });
    fillEntity();
    fireEvent.click(screen.getByRole("button", { name: /add provider entity/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/cipher is not bound/);
  });

  it("creates a location under a chosen provider entity", async () => {
    const c = client({ entities: [ENTITY], post: vi.fn(async () => ({ data: { id: "loc-2" } })) });
    mount(c);

    await screen.findByRole("option", { name: /Cedar Ridge Hospice LLC/ });
    type(/provider entity/i, "pe-1");
    type(/location name/i, "Main office");
    type(/address line 1/i, "1 Cedar Way");
    type(/^city/i, "Fresno");
    type(/^state/i, "CA");
    type(/zip/i, "93701");
    type(/time zone/i, "America/Los_Angeles");
    fireEvent.click(screen.getByRole("button", { name: /add location/i }));

    await waitFor(() =>
      expect(c.POST).toHaveBeenCalledWith("/api/v1/locations", {
        body: {
          providerEntityId: "pe-1",
          name: "Main office",
          addressLine1: "1 Cedar Way",
          city: "Fresno",
          state: "CA",
          postalCode: "93701",
          timezone: "America/Los_Angeles",
        },
      }),
    );
  });

  it("asks for a provider entity first when there is none, instead of an empty select", async () => {
    mount(client({}));

    expect(await screen.findByText(/add a provider entity first/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /add location/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a failed load says so with a retry instead of claiming there is no provider entity", async () => {
    const GET = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (path: string) =>
        path === "/api/v1/provider-entities" ? page(ENTITY) : page(),
      );
    mount({ GET, POST: vi.fn() });

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not load/i);
    expect(screen.queryByText(/no provider entity yet/i)).toBeNull();
    expect(screen.queryByText(/add a provider entity first/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    const entities = await screen.findByRole("region", { name: "Provider entities" });
    expect(await within(entities).findByText("Cedar Ridge Hospice LLC")).toBeTruthy();
  });

  it("a network failure is reported and the form stays usable", async () => {
    const c = client({ post: vi.fn().mockRejectedValue(new Error("offline")) });
    mount(c);

    await screen.findByRole("button", { name: /add provider entity/i });
    fillEntity();
    fireEvent.click(screen.getByRole("button", { name: /add provider entity/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/try again/i);
    expect(
      (screen.getByRole("button", { name: /add provider entity/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
