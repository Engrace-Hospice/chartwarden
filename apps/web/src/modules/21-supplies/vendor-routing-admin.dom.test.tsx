// @vitest-environment jsdom
// A routing rule is a multi-field form on the rules screen, so it opens as a drawer in the detail rail beside the rules
// it joins (the redesign's pattern), not as a dialog over them. Cancel closes it and sends nothing; one form is open at
// a time (New rule and Edit share the drawer).
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VendorRoutingRuleView } from "./supplies-api";
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

function mount(): { post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const patch = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async () => ok({ data: [rule], next_cursor: null, has_more: false })),
    POST: post,
    PATCH: patch,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <VendorRoutingAdmin />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, patch };
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
    const { post, patch } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    const drawer = await drawerNamed("New routing rule");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "New routing rule" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
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
});
