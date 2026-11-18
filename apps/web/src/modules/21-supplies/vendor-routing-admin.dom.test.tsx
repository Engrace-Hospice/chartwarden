// @vitest-environment jsdom
// A routing rule is a multi-field form on the rules screen, so it opens as a drawer in the detail rail beside the rules
// it joins (the redesign's pattern), not as a dialog over them. Cancel closes it and sends nothing; one form is open at
// a time (New rule and Edit share the drawer). While a write is in flight the drawer cannot be dismissed and the page
// beside it is inert; a refused or rejected write is announced in the drawer, which stays dismissible (a refused Retire,
// which has no drawer, on the page), and a reload (a filter change) leaves an open drawer and its typed text alone.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VendorRoutingRuleView } from "./supplies-api";
import { NO_ANSWER_MESSAGE } from "./use-write";
import { VendorRoutingAdmin } from "./vendor-routing-admin";

afterEach(cleanup);

const rule: VendorRoutingRuleView = {
  ruleId: "11111111-1111-4111-8111-111111111111",
  isPlatform: false,
  scopeKind: "tenant",
  scopeId: null,
  skuClassPattern: null,
  assignedVendorId: "vendor-1",
  assignedFulfillmentMode: "vendor",
  defaultPharmacyDispatchMode: null,
  precedencePriority: 100,
  isActive: true,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

const pageOf = (rows: VendorRoutingRuleView[]) => ({
  data: rows,
  next_cursor: null,
  has_more: false,
});

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
  onGet: () => Promise<unknown> = async () => ok(pageOf([rule])),
): {
  post: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(onWrite);
  const del = vi.fn(onWrite);
  const get = vi.fn(onGet);
  const client = { GET: get, POST: post, PUT: vi.fn(onWrite), DELETE: del } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <VendorRoutingAdmin />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, del, get };
}

const drawerNamed = (name: string) => screen.findByRole("complementary", { name });

describe("vendor routing — rules", () => {
  it("opens New rule as a drawer beside the rules, not a dialog over them", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    const drawer = await drawerNamed("New routing rule");
    expect(within(drawer).getByLabelText("Scope")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The rules stay on the page while the form is open.
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("opens Edit with the rule's own values", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await drawerNamed("Edit routing rule");
    expect((within(drawer).getByLabelText(/^Precedence priority/) as HTMLInputElement).value).toBe(
      "100",
    );
    expect((within(drawer).getByLabelText(/^Vendor id/) as HTMLInputElement).value).toBe(
      "vendor-1",
    );
  });

  it("closes from Cancel without sending anything", async () => {
    const { post } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    const drawer = await drawerNamed("New routing rule");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New routing rule" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("saves the rule and closes the drawer", async () => {
    const { post } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    const drawer = await drawerNamed("New routing rule");
    fireEvent.change(within(drawer).getByLabelText(/^Vendor id/), {
      target: { value: "vendor-2" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0] as unknown as [string])[0]).toBe(
      "/api/v1/supplies/vendor-routing-rules",
    );
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New routing rule" })).toBeNull(),
    );
  });

  it("swaps the form when Edit is chosen while New rule is open", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    await drawerNamed("New routing rule");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await drawerNamed("Edit routing rule")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "New routing rule" })).toBeNull();
  });

  it("holds the drawer and everything beside it while a write is in flight", async () => {
    let release: () => void = () => {};
    const { post } = mount(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({}));
        }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    const drawer = await drawerNamed("New routing rule");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(drawer).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "New routing rule" })).toBe(drawer);
    // A row's Edit cannot swap the drawer under the write.
    const edit = screen.getByRole("button", { name: "Edit", hidden: true });
    expect(edit.closest("[inert]")).not.toBeNull();
    release();
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New routing rule" })).toBeNull(),
    );
  });

  it("announces a rejected request in the drawer, which stays dismissible", async () => {
    mount(async () => {
      throw new TypeError("Failed to fetch");
    });
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    const drawer = await drawerNamed("New routing rule");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save rule" }));
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toBe(NO_ANSWER_MESSAGE);
    const cancel = within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New routing rule" })).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a rejected Retire on the page and frees the row to retry", async () => {
    const { del } = mount(async () => {
      throw new TypeError("Failed to fetch");
    });
    const retire = (await screen.findByRole("button", { name: "Retire" })) as HTMLButtonElement;
    fireEvent.click(retire);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(NO_ANSWER_MESSAGE);
    expect(del).toHaveBeenCalledTimes(1);
    expect(retire.disabled).toBe(false);
  });

  it("keeps the drawer and its typed text while a filter reloads the rules", async () => {
    const { get } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    const drawer = await drawerNamed("New routing rule");
    const vendor = within(drawer).getByLabelText(/^Vendor id/) as HTMLInputElement;
    fireEvent.change(vendor, { target: { value: "vendor-9" } });
    const retired = screen.getByLabelText("Include retired rules") as HTMLInputElement;
    fireEvent.click(retired);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    // The reload has landed once the page stops announcing itself busy.
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    // The same drawer and the same filter survive the reload: no unmount, so no lost focus or typed text.
    expect(screen.getByRole("complementary", { name: "New routing rule" })).toBe(drawer);
    expect(vendor.isConnected).toBe(true);
    expect(vendor.value).toBe("vendor-9");
    expect(retired.isConnected).toBe(true);
    expect(retired.checked).toBe(true);
  });

  it("keeps the newest filter's rules when an older response lands last", async () => {
    const { reply, answers } = slowReloads(pageOf([rule]));
    const { get } = mount(undefined, reply);
    const retired = await screen.findByLabelText("Include retired rules");
    fireEvent.click(retired);
    fireEvent.click(retired);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    answers[1]?.(pageOf([{ ...rule, precedencePriority: 222 }]));
    await settle();
    expect(screen.getByText("222")).toBeTruthy();
    answers[0]?.(pageOf([{ ...rule, precedencePriority: 111 }]));
    await settle();
    expect(screen.queryByText("111")).toBeNull();
    expect(screen.getByText("222")).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("says so inline when a reload is rejected, keeping the open drawer", async () => {
    let calls = 0;
    mount(undefined, () =>
      ++calls === 1
        ? Promise.resolve(ok(pageOf([rule])))
        : Promise.reject(new TypeError("Failed to fetch")),
    );
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    const drawer = await drawerNamed("New routing rule");
    fireEvent.click(screen.getByLabelText("Include retired rules"));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The vendor routing rules could not be loaded.")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    expect(screen.getByRole("complementary", { name: "New routing rule" })).toBe(drawer);
  });

  it("does not mark the open drawer busy while a Retire is in flight", async () => {
    let release: () => void = () => {};
    const { del } = mount(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({}));
        }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    const drawer = await drawerNamed("New routing rule");
    const retire = screen.getByRole("button", { name: "Retire" }) as HTMLButtonElement;
    fireEvent.click(retire);
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    // The drawer can still be dismissed and the page (the focused Retire included) is not inert; only the drawer's own
    // Save waits for the Retire.
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(drawer.closest("[inert]")).toBeNull();
    expect(retire.closest("[inert]")).toBeNull();
    expect(retire.disabled).toBe(true);
    expect(
      (within(drawer).getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    release();
    await waitFor(() =>
      expect(
        (within(drawer).getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("clears a rejected Retire when a drawer opens and when it closes", async () => {
    mount(async () => {
      throw new TypeError("Failed to fetch");
    });
    const retire = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
      expect((await screen.findByRole("alert")).textContent).toBe(NO_ANSWER_MESSAGE);
    };
    // New rule, Edit and closing the drawer each start clean.
    await retire();
    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    const drawer = await drawerNamed("New routing rule");
    expect(screen.queryByRole("alert")).toBeNull();
    await retire();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New routing rule" })).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await retire();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await drawerNamed("Edit routing rule");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the rules when a filter read is rejected, and Reload loads them again", async () => {
    let calls = 0;
    mount(undefined, () => {
      calls += 1;
      if (calls === 2) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(
        ok(pageOf([{ ...rule, precedencePriority: calls === 1 ? 111 : 222 }])),
      );
    });
    await screen.findByText("111");
    fireEvent.click(screen.getByLabelText("Include retired rules"));
    const alert = await screen.findByRole("alert");
    // No stale rules under a filter they do not match, and no false "unconfigured" either.
    expect(screen.queryByText("111")).toBeNull();
    expect(screen.queryByText(/No tenant default is configured/)).toBeNull();
    expect(screen.queryByText(/No rule at this scope/)).toBeNull();
    expect(screen.getAllByText("Not loaded.").length).toBeGreaterThan(0);
    fireEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    expect(await screen.findByText("222")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("after a Retire, a rejected refresh keeps the rules and says so", async () => {
    let calls = 0;
    mount(undefined, () =>
      ++calls === 1
        ? Promise.resolve(ok(pageOf([{ ...rule, precedencePriority: 111 }])))
        : Promise.reject(new TypeError("Failed to fetch")),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The vendor routing rules could not be loaded.")).toBeTruthy();
    // The write landed and the rules still match the filter, so they stay.
    expect(screen.getByText("111")).toBeTruthy();
  });

  it("keeps focus on Reload through a failed retry, re-announces the repeat and moves focus on after a success", async () => {
    let calls = 0;
    const { get } = mount(undefined, () => {
      calls += 1;
      return calls === 2 || calls === 3
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(ok(pageOf([{ ...rule, precedencePriority: 111 }])));
    });
    await screen.findByText("111");
    fireEvent.click(screen.getByLabelText("Include retired rules"));
    const alert = await screen.findByRole("alert");
    const reload = within(alert).getByRole("button", { name: "Reload" });
    const firstMessage = within(alert).getByText("The vendor routing rules could not be loaded.");
    reload.focus();
    fireEvent.click(reload);
    // The retry is in flight: the alert and the focused button stay, and a second click is ignored.
    expect(screen.getByRole("alert")).toBe(alert);
    expect(document.activeElement).toBe(reload);
    expect(reload.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(reload);
    expect(get).toHaveBeenCalledTimes(3);
    // The identical second failure re-keys the message (so it is announced again); focus never left Reload.
    await waitFor(() => expect(reload.getAttribute("aria-disabled")).toBe("false"));
    expect(screen.getByRole("alert")).toBe(alert);
    expect(within(alert).getByText("The vendor routing rules could not be loaded.")).not.toBe(
      firstMessage,
    );
    expect(document.activeElement).toBe(reload);
    // A successful retry removes the alert and hands focus to the page, not to <body>.
    fireEvent.click(reload);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByText("111")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.className).toContain("wx-list-drawer-main");
  });
});
