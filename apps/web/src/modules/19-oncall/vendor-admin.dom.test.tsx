// @vitest-environment jsdom
// Binding a vendor and renewing a BAA are record forms on a list screen, so they open as a drawer in the detail rail
// beside the bindings (the redesign's pattern), not as a dialog over them. Only one is open at a time; Cancel sends nothing.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VendorBindingView } from "./oncall-api";
import { ExternalVendorAdminScreen } from "./vendor-admin";

afterEach(cleanup);

const binding: VendorBindingView = {
  id: "v1",
  mdmVendorId: "mdm-v1",
  name: "Northwind After-Hours",
  adapterKey: "northwind",
  rnCoverageAttested: true,
  baaInEffect: true,
  baaExpiresOn: "2027-06-06",
  minimizationProfile: "minimum_necessary",
  adapterRegistered: true,
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(): { write: ReturnType<typeof vi.fn> } {
  const write = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async () => ok([binding])),
    POST: write,
    PATCH: write,
    PUT: write,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ExternalVendorAdminScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { write };
}

describe("external triage vendors — bind and renew", () => {
  it("opens Bind as a drawer beside the bindings, not a dialog over them", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Bind a vendor" }));
    const drawer = await screen.findByRole("complementary", {
      name: "Bind an external triage vendor",
    });
    expect(within(drawer).getByLabelText("Display name")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The bindings stay on the page while the form is open.
    expect(screen.getByText("Northwind After-Hours")).toBeTruthy();
  });

  it("opens the BAA renewal for the chosen binding as a drawer", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "BAA renewal" }));
    const drawer = await screen.findByRole("complementary", {
      name: "BAA renewal — Northwind After-Hours",
    });
    expect(within(drawer).getByLabelText("BAA expiry")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps one form drawer open at a time", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "BAA renewal" }));
    await screen.findByRole("complementary", { name: "BAA renewal — Northwind After-Hours" });
    fireEvent.click(screen.getByRole("button", { name: "Bind a vendor" }));
    expect(
      await screen.findByRole("complementary", { name: "Bind an external triage vendor" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("complementary", { name: "BAA renewal — Northwind After-Hours" }),
    ).toBeNull();
  });

  it("closes from Cancel without sending anything", async () => {
    const { write } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Bind a vendor" }));
    const drawer = await screen.findByRole("complementary", {
      name: "Bind an external triage vendor",
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Bind an external triage vendor" }),
      ).toBeNull(),
    );
    expect(write).not.toHaveBeenCalled();
  });
});
