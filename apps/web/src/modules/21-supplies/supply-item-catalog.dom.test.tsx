// @vitest-environment jsdom
// Adding or editing a tenant item is a multi-field form on the catalog screen, so it opens as a drawer in the detail
// rail beside the catalog (the redesign's pattern), not as a dialog over it. Cancel closes it and sends nothing; Save
// stays disabled until the item has a name, a local SKU code and a unit. While a write is in flight the drawer cannot be
// dismissed and the page beside it is inert; a refused or rejected write is announced in the drawer, which stays
// dismissible, and a reload (a search keystroke) leaves an open drawer and its typed text alone.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupplyItemView } from "./supplies-api";
import { SupplyItemCatalog } from "./supply-item-catalog";

afterEach(cleanup);

const overlayItem: SupplyItemView = {
  supplyItemId: "11111111-1111-4111-8111-111111111111",
  isPlatform: false,
  hcpcs: null,
  rxnorm: null,
  ndc: null,
  name: "Comfort cart linens set",
  skuClass: "internal",
  defaultUnit: "each",
  isBillable: false,
  isActive: true,
  isControlledSubstance: false,
  requiresLotTracking: false,
  requiresExpirationTracking: false,
  isSerializedAsset: false,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  localSkuCode: "LINEN-01",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(onWrite: () => Promise<unknown> = async () => ok({})): {
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(onWrite);
  const put = vi.fn(onWrite);
  const get = vi.fn(async () => ok({ data: [overlayItem], next_cursor: null, has_more: false }));
  const client = { GET: get, POST: post, PUT: put } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <SupplyItemCatalog />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, put, get };
}

const drawerNamed = (name: string) => screen.findByRole("complementary", { name });

describe("supply catalog — tenant items", () => {
  it("opens New tenant item as a drawer beside the catalog, not a dialog over it", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New tenant item" }));
    const drawer = await drawerNamed("New tenant item");
    expect(within(drawer).getByLabelText("Local SKU code")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The catalog stays on the page while the form is open.
    expect(screen.getByText("Comfort cart linens set")).toBeTruthy();
  });

  it("opens Edit with the item's own values", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await drawerNamed("Edit tenant item");
    expect((within(drawer).getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Comfort cart linens set",
    );
    expect((within(drawer).getByLabelText("Local SKU code") as HTMLInputElement).value).toBe(
      "LINEN-01",
    );
  });

  it("closes from Cancel without saving anything", async () => {
    const { post, put } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "New tenant item" }));
    const drawer = await drawerNamed("New tenant item");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New tenant item" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps Save item disabled until the item is complete, then files it and closes", async () => {
    const { post } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "New tenant item" }));
    const drawer = await drawerNamed("New tenant item");
    const save = within(drawer).getByRole("button", { name: "Save item" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Name"), { target: { value: "Bed pads" } });
    fireEvent.change(within(drawer).getByLabelText("Local SKU code"), {
      target: { value: "PAD-01" },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(call[0]).toBe("/api/v1/supplies/tenant-supply-items");
    expect(call[1].body).toMatchObject({ name: "Bed pads", localSkuCode: "PAD-01" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New tenant item" })).toBeNull(),
    );
  });

  const fillNewItem = async (): Promise<HTMLElement> => {
    fireEvent.click(await screen.findByRole("button", { name: "New tenant item" }));
    const drawer = await drawerNamed("New tenant item");
    fireEvent.change(within(drawer).getByLabelText("Name"), { target: { value: "Bed pads" } });
    fireEvent.change(within(drawer).getByLabelText("Local SKU code"), {
      target: { value: "PAD-01" },
    });
    return drawer;
  };

  it("holds the drawer and everything beside it while a write is in flight", async () => {
    let release: () => void = () => {};
    const { post } = mount(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({}));
        }),
    );
    const drawer = await fillNewItem();
    fireEvent.click(within(drawer).getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(drawer).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "New tenant item" })).toBe(drawer);
    // A row's Edit cannot swap the drawer under the write.
    const edit = screen.getByRole("button", { name: "Edit", hidden: true });
    expect(edit.closest("[inert]")).not.toBeNull();
    release();
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New tenant item" })).toBeNull(),
    );
  });

  it("announces a rejected request in the drawer, which stays dismissible", async () => {
    mount(async () => {
      throw new TypeError("Failed to fetch");
    });
    const drawer = await fillNewItem();
    fireEvent.click(within(drawer).getByRole("button", { name: "Save item" }));
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toBe("The tenant item could not be saved.");
    const cancel = within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Save item" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New tenant item" })).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the drawer and its typed text while the search reloads the catalog", async () => {
    const { get } = mount();
    const drawer = await fillNewItem();
    const name = within(drawer).getByLabelText("Name") as HTMLInputElement;
    const search = screen.getByLabelText("Search name or HCPCS") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "pad" } });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    // The reload has landed once the page stops announcing itself busy.
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    // The same drawer and the same search field survive the reload: no unmount, so no lost focus or typed text.
    expect(screen.getByRole("complementary", { name: "New tenant item" })).toBe(drawer);
    expect(name.isConnected).toBe(true);
    expect(name.value).toBe("Bed pads");
    expect(search.isConnected).toBe(true);
    expect(search.value).toBe("pad");
  });
});
