// @vitest-environment jsdom
// Adding or editing a tenant item is a multi-field form on the catalog screen, so it opens as a drawer in the detail
// rail beside the catalog (the redesign's pattern), not as a dialog over it. Cancel closes it and sends nothing; Save
// stays disabled until the item has a name, a local SKU code and a unit.
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

function mount(): { post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const patch = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async () => ok({ data: [overlayItem], next_cursor: null, has_more: false })),
    POST: post,
    PATCH: patch,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <SupplyItemCatalog />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, patch };
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
    const { post, patch } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "New tenant item" }));
    const drawer = await drawerNamed("New tenant item");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New tenant item" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
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
});
