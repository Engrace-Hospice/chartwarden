// @vitest-environment jsdom
// Recording an on-hand count is a small form on the shelf list, so it opens as a drawer in the detail rail beside the
// shelf (the redesign's pattern), not as a dialog over it. Cancel closes it and records nothing; the count starts from
// what the shelf shows, and Record count stays disabled when that is cleared.
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

function mount(): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async () => ok({ data: [shelf], next_cursor: null, has_more: false })),
    POST: post,
    PATCH: vi.fn(async () => ok({})),
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ParStockAdmin />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

const TITLE = "Record an on-hand count — Mouth care swabs";
const open = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: "Record count" }));
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
});
