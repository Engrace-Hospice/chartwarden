// @vitest-environment jsdom
// Recording an on-hand count is a small form on the shelf list, so it opens as a drawer in the detail rail beside the
// shelf (the redesign's pattern), not as a dialog over it. Cancel closes it and records nothing; the count starts from
// what the shelf shows, and Record count stays disabled when that is cleared. While a write is in flight the drawer
// cannot be dismissed and the page beside it is inert; a refused or rejected write is announced in the drawer, which
// stays dismissible, and a reload (a filter keystroke) leaves an open drawer and its typed text alone.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParStockAdmin } from "./par-stock-admin";
import type { ParStockView } from "./supplies-api";
import { NO_ANSWER_MESSAGE } from "./use-write";

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

const pageOf = (rows: ParStockView[]) => ({ data: rows, next_cursor: null, has_more: false });

/** A GET whose first call answers at once and whose later calls wait for the test to answer them, in any order. */
function slowReloads(first: unknown): {
  reply: () => Promise<unknown>;
  answers: Array<(page: unknown) => void>;
} {
  const answers: Array<(page: unknown) => void> = [];
  let calls = 0;
  const reply = () =>
    ++calls === 1
      ? Promise.resolve(ok(first))
      : new Promise((resolve) => {
          answers.push((page) => resolve(ok(page)));
        });
  return { reply, answers };
}
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function mount(
  onWrite: () => Promise<unknown> = async () => ok({}),
  onGet: () => Promise<unknown> = async () => ok(pageOf([shelf])),
): {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(onWrite);
  const get = vi.fn(onGet);
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
    expect(alert.textContent).toBe(NO_ANSWER_MESSAGE);
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
    expect(alert.textContent).toBe(NO_ANSWER_MESSAGE);
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

  it("keeps the newest filter's rows when an older response lands last", async () => {
    const { reply, answers } = slowReloads(pageOf([shelf]));
    const { get } = mount(undefined, reply);
    await screen.findByText("Mouth care swabs");
    const location = screen.getByLabelText("Location id");
    fireEvent.change(location, { target: { value: "loc-" } });
    fireEvent.change(location, { target: { value: "loc-2" } });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    answers[1]?.(pageOf([{ ...shelf, skuName: "Gauze pads" }]));
    await settle();
    expect(screen.getByText("Gauze pads")).toBeTruthy();
    answers[0]?.(pageOf([{ ...shelf, skuName: "Lip balm" }]));
    await settle();
    expect(screen.queryByText("Lip balm")).toBeNull();
    expect(screen.getByText("Gauze pads")).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("says so inline when a reload is rejected, keeps the page and frees the row", async () => {
    let calls = 0;
    mount(undefined, () =>
      ++calls === 1
        ? Promise.resolve(ok(pageOf([shelf])))
        : Promise.reject(new TypeError("Failed to fetch")),
    );
    await screen.findByText("Mouth care swabs");
    fireEvent.change(screen.getByLabelText("Location id"), { target: { value: "loc-2" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The par shelf could not be loaded.");
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    // The previous rows stay, and an inline save is not left disabled by a load that never ended.
    fireEvent.click(screen.getByRole("button", { name: "Edit thresholds" }));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("shows Unavailable when the first load is rejected", async () => {
    mount(undefined, () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("The par shelf could not be loaded.")).toBeTruthy();
  });

  it("does not mark the open drawer busy while an inline save is in flight", async () => {
    let release: () => void = () => {};
    const { get } = mount(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({}));
        }),
    );
    const drawer = await open();
    fireEvent.click(screen.getByRole("button", { name: "Edit thresholds" }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => expect(save.disabled).toBe(true));
    // The drawer can still be dismissed and the page (the focused Save included) is not inert; only the drawer's own
    // Save waits for the inline write.
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(drawer.closest("[inert]")).toBeNull();
    expect(save.closest("[inert]")).toBeNull();
    expect(
      (within(drawer).getByRole("button", { name: "Record count" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    release();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        (within(drawer).getByRole("button", { name: "Record count" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("clears a rejected inline save when a drawer opens and when it closes", async () => {
    const second = {
      ...shelf,
      parStockId: "22222222-2222-4222-8222-222222222222",
      skuName: "Zinc",
    };
    mount(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      async () => ok(pageOf([shelf, second])),
    );
    // The row being edited offers Save / Cancel, so the drawer is opened from the other row.
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Edit thresholds" }))[0] as HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(NO_ANSWER_MESSAGE);
    // Opening a drawer starts clean.
    fireEvent.click(screen.getByRole("button", { name: "Record count…" }));
    const drawer = await screen.findByRole("complementary", {
      name: "Record an on-hand count — Zinc",
    });
    expect(screen.queryByRole("alert")).toBeNull();
    // A fresh refusal of the inline edit shows on the page, and closing the drawer clears it too.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(NO_ANSWER_MESSAGE);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Record an on-hand count — Zinc" }),
      ).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
