// @vitest-environment jsdom
// Recording an on-hand count is a small form on the shelf list, so it opens as a drawer in the detail rail beside the
// shelf (the redesign's pattern), not as a dialog over it. Cancel closes it and records nothing; the count starts from
// what the shelf shows, and Record count stays disabled when that is cleared. While a write is in flight the drawer
// cannot be dismissed and the page beside it is inert; a refused or rejected write is announced in the drawer, which
// stays dismissible, and a reload (a filter keystroke) leaves an open drawer and its typed text alone.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParStockAdmin } from "./par-stock-admin";
import type { ParStockView } from "./supplies-api";

afterEach(cleanup);

const shelf: ParStockView = {
  parStockId: "11111111-1111-4111-8111-111111111111",
  locationId: "loc-1",
  skuId: null,
  tenantSkuExtensionId: "ext-1",
  skuName: "Mouth care swabs",
  currentQuantity: "12",
  unit: "box",
  reorderPoint: "10",
  reorderQuantity: "20",
  minSafetyStock: "2",
  severity: "ok",
  isActive: true,
  lastParReviewAt: "2026-11-08T12:00:00.000Z",
  lastParReviewedByMembershipId: "m-lopez",
  reorderNotes: null,
  updatedAt: "2026-11-17T12:00:00.000Z",
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(onWrite: () => Promise<unknown> = async () => ok({})): {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(onWrite);
  const get = vi.fn(async () => ok({ data: [shelf], next_cursor: null, has_more: false }));
  const client = {
    GET: get,
    POST: post,
    PUT: vi.fn(onWrite),
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ParStockAdmin />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, get };
}

const TITLE = "Record an on-hand count — Mouth care swabs";
const open = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: "Record count…" }));
  return screen.findByRole("complementary", { name: TITLE });
};

describe("par stock — record a count", () => {
  it("opens the count as a drawer beside the shelf, not a dialog over it", async () => {
    mount();
    const drawer = await open();
    expect(within(drawer).getByLabelText(/^Counted quantity/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The shelf stays on the page while the count is taken.
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("starts from the quantity the shelf shows", async () => {
    mount();
    const drawer = await open();
    expect((within(drawer).getByLabelText(/^Counted quantity/) as HTMLInputElement).value).toBe(
      "12",
    );
  });

  it("closes from Cancel without recording anything", async () => {
    const { post } = mount();
    const drawer = await open();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: TITLE })).toBeNull());
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps Record count disabled when the count is cleared, then records it and closes", async () => {
    const { post } = mount();
    const drawer = await open();
    const record = within(drawer).getByRole("button", {
      name: "Record count",
    }) as HTMLButtonElement;
    fireEvent.change(within(drawer).getByLabelText(/^Counted quantity/), {
      target: { value: "" },
    });
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText(/^Counted quantity/), {
      target: { value: "9" },
    });
    expect(record.disabled).toBe(false);
    fireEvent.click(record);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(call[0]).toBe("/api/v1/supplies/par-stock/observe");
    expect(call[1].body).toMatchObject({ observedQuantity: "9" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: TITLE })).toBeNull());
  });

  it("names the page's opener apart from the open drawer's own save button", async () => {
    mount();
    const drawer = await open();
    expect(screen.getAllByRole("button", { name: "Record count" })).toEqual([
      within(drawer).getByRole("button", { name: "Record count" }),
    ]);
  });

  it("holds the drawer and everything beside it while a write is in flight", async () => {
    let release: () => void = () => {};
    const { post } = mount(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({}));
        }),
    );
    const drawer = await open();
    fireEvent.click(within(drawer).getByRole("button", { name: "Record count" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(drawer).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: TITLE })).toBe(drawer);
    // The row's own openers cannot swap the drawer under the write.
    const edit = screen.getByRole("button", { name: "Edit thresholds", hidden: true });
    expect(edit.closest("[inert]")).not.toBeNull();
    release();
    await waitFor(() => expect(screen.queryByRole("complementary", { name: TITLE })).toBeNull());
  });

  it("announces a rejected request in the drawer, which stays dismissible", async () => {
    mount(async () => {
      throw new TypeError("Failed to fetch");
    });
    const drawer = await open();
    fireEvent.click(within(drawer).getByRole("button", { name: "Record count" }));
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toBe("The count could not be recorded.");
    const cancel = within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Record count" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("complementary", { name: TITLE })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a rejected threshold edit on the page and frees the row to retry", async () => {
    mount(async () => {
      throw new TypeError("Failed to fetch");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit thresholds" }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    fireEvent.click(save);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The thresholds could not be saved.");
    expect(save.disabled).toBe(false);
  });

  it("keeps the drawer and its typed text while the filter reloads the shelf", async () => {
    const { get } = mount();
    const drawer = await open();
    const count = within(drawer).getByLabelText(/^Counted quantity/) as HTMLInputElement;
    fireEvent.change(count, { target: { value: "7" } });
    const location = screen.getByLabelText("Location id") as HTMLInputElement;
    fireEvent.change(location, { target: { value: "loc-2" } });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    // The reload has landed once the page stops announcing itself busy.
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    // The same drawer and the same filter field survive the reload: no unmount, so no lost focus or typed text.
    expect(screen.getByRole("complementary", { name: TITLE })).toBe(drawer);
    expect(count.isConnected).toBe(true);
    expect(count.value).toBe("7");
    expect(location.isConnected).toBe(true);
    expect(location.value).toBe("loc-2");
  });
});
