// @vitest-environment jsdom
// Binding a vendor and renewing a BAA are record forms on a list screen, so they open as a drawer in the detail rail
// beside the bindings (the redesign's pattern), not as a dialog over them. Only one is open at a time; Cancel sends
// nothing; Bind stays disabled until the binding is valid and then sends it; Save sends the renewal; a refused or lost
// write is announced in the drawer and never leaves it stuck; while a write is in flight the bindings beside it are inert.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VendorBindingView } from "./oncall-api";
import { ExternalVendorAdminScreen } from "./vendor-admin";

afterEach(cleanup);

const VENDOR_ENTITY = "77777777-aaaa-4aaa-8aaa-777777777777";
const REFUSAL = "A binding needs a BAA in force.";
const BIND = "Bind an external triage vendor";
const RENEW = "BAA renewal — Northwind After-Hours";

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
const refused = {
  data: undefined,
  error: { error: { code: "BAA_REQUIRED", message: REFUSAL, correlationId: "c" } },
  response: new Response(null, { status: 422 }),
};
const lost = async (): Promise<never> => {
  throw new TypeError("Failed to fetch");
};

function mount(writes: { post?: () => Promise<unknown>; patch?: () => Promise<unknown> } = {}): {
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(writes.post ?? (async (..._args: unknown[]) => ok({})));
  const patch = vi.fn(writes.patch ?? (async (..._args: unknown[]) => ok({})));
  const client = {
    GET: vi.fn(async () => ok([binding])),
    POST: post,
    PATCH: patch,
    PUT: vi.fn(),
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ExternalVendorAdminScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, patch };
}

async function openBind(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Bind a vendor" }));
  return screen.findByRole("complementary", { name: BIND });
}

async function openRenew(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "BAA renewal" }));
  return screen.findByRole("complementary", { name: RENEW });
}

const bindButton = (drawer: HTMLElement) =>
  within(drawer).getByRole("button", { name: "Bind" }) as HTMLButtonElement;
const saveButton = (drawer: HTMLElement) =>
  within(drawer).getByRole("button", { name: "Save" }) as HTMLButtonElement;
const cancelButton = (drawer: HTMLElement) =>
  within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;

function fillValidBinding(drawer: HTMLElement): void {
  fireEvent.change(within(drawer).getByLabelText("Canonical vendor entity id"), {
    target: { value: VENDOR_ENTITY },
  });
  fireEvent.change(within(drawer).getByLabelText("Display name"), {
    target: { value: "Harbor Night Triage" },
  });
  fireEvent.change(within(drawer).getByLabelText("Adapter key"), { target: { value: "harbor" } });
  fireEvent.click(within(drawer).getByLabelText("A BAA is in force (required)"));
}

function pending(): { promise: Promise<unknown>; finish: () => void } {
  let finish: () => void = () => undefined;
  const promise = new Promise<unknown>((resolve) => {
    finish = () => resolve(ok({}));
  });
  return { promise, finish };
}

function expectPageInert(): void {
  for (const name of ["Bind a vendor", "BAA renewal"]) {
    const control = screen.getByRole("button", { name, hidden: true });
    expect(control.closest("[inert]")).not.toBeNull();
  }
  expect(
    screen.getByRole("link", { name: "On-call policy", hidden: true }).closest("[inert]"),
  ).not.toBeNull();
}

describe("external triage vendors — bind and renew", () => {
  it("opens Bind as a drawer beside the bindings, not a dialog over them", async () => {
    mount();
    const drawer = await openBind();
    expect(within(drawer).getByLabelText("Display name")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The bindings stay on the page while the form is open.
    expect(screen.getByText("Northwind After-Hours")).toBeTruthy();
  });

  it("opens the BAA renewal for the chosen binding as a drawer", async () => {
    mount();
    const drawer = await openRenew();
    expect(within(drawer).getByLabelText("BAA expiry")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps one form drawer open at a time", async () => {
    mount();
    await openRenew();
    fireEvent.click(screen.getByRole("button", { name: "Bind a vendor" }));
    expect(await screen.findByRole("complementary", { name: BIND })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: RENEW })).toBeNull();
  });

  it("closes from Cancel without sending anything", async () => {
    const { post, patch } = mount();
    const drawer = await openBind();
    fireEvent.click(cancelButton(drawer));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: BIND })).toBeNull());
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  describe("Bind", () => {
    it("stays disabled until the id, name, adapter key and a BAA in force are given, then sends the binding and closes", async () => {
      const { post } = mount();
      const drawer = await openBind();
      expect(bindButton(drawer).disabled).toBe(true);

      fillValidBinding(drawer);
      expect(bindButton(drawer).disabled).toBe(false);

      fireEvent.click(within(drawer).getByLabelText("A BAA is in force (required)"));
      expect(bindButton(drawer).disabled).toBe(true);
      fireEvent.click(within(drawer).getByLabelText("A BAA is in force (required)"));
      fireEvent.change(within(drawer).getByLabelText("Canonical vendor entity id"), {
        target: { value: "not-a-uuid" },
      });
      expect(bindButton(drawer).disabled).toBe(true);
      fireEvent.change(within(drawer).getByLabelText("Canonical vendor entity id"), {
        target: { value: VENDOR_ENTITY },
      });
      expect(bindButton(drawer).disabled).toBe(false);

      fireEvent.click(bindButton(drawer));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post.mock.calls[0]?.[0]).toBe("/api/v1/oncall/external-vendors");
      const { body } = post.mock.calls[0]?.[1] as { body: Record<string, unknown> };
      expect(body).toMatchObject({
        mdmVendorId: VENDOR_ENTITY,
        name: "Harbor Night Triage",
        adapterKey: "harbor",
        rnCoverageAttested: false,
        baaInEffect: true,
        defaultMinimizationPolicy: { profile: "hybrid_phi_min" },
      });
      expect(body).not.toHaveProperty("baaExpiresOn");
      await waitFor(() => expect(screen.queryByRole("complementary", { name: BIND })).toBeNull());
    });

    it("shows a refused write in the drawer beside Bind, and drops it on Cancel and reopen", async () => {
      mount({ post: async () => refused });
      const drawer = await openBind();
      fillValidBinding(drawer);
      fireEvent.click(bindButton(drawer));
      expect((await within(drawer).findByRole("alert")).textContent).toContain(REFUSAL);
      // Only in the drawer: not also a page banner above the bindings.
      expect(screen.getAllByText(REFUSAL)).toHaveLength(1);
      expect(bindButton(drawer).disabled).toBe(false);

      fireEvent.click(cancelButton(drawer));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: BIND })).toBeNull());
      await openBind();
      expect(screen.queryByText(REFUSAL)).toBeNull();
    });

    it("frees the drawer and says so when the request is lost (the client rejects)", async () => {
      mount({ post: lost });
      const drawer = await openBind();
      fillValidBinding(drawer);
      fireEvent.click(bindButton(drawer));
      expect((await within(drawer).findByRole("alert")).textContent).toContain(
        "No answer came back; it may not have been recorded",
      );
      expect(bindButton(drawer).disabled).toBe(false);
      expect(cancelButton(drawer).disabled).toBe(false);
      fireEvent.click(cancelButton(drawer));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: BIND })).toBeNull());
    });

    it("makes the bindings inert while the write is in flight, and live again once it lands", async () => {
      const write = pending();
      mount({ post: () => write.promise });
      const drawer = await openBind();
      fillValidBinding(drawer);
      fireEvent.click(bindButton(drawer));

      await waitFor(() => expect(cancelButton(drawer).disabled).toBe(true));
      expectPageInert();
      expect(drawer.closest("[inert]")).toBeNull();

      write.finish();
      await waitFor(() => expect(screen.queryByRole("complementary", { name: BIND })).toBeNull());
      await waitFor(() => expect(document.querySelector("[inert]")).toBeNull());
    });
  });

  describe("BAA renewal", () => {
    it("sends the renewal for the chosen binding and closes", async () => {
      const { patch } = mount();
      const drawer = await openRenew();
      fireEvent.click(within(drawer).getByLabelText("A BAA is in force"));
      fireEvent.change(within(drawer).getByLabelText("BAA expiry"), { target: { value: "" } });
      fireEvent.click(saveButton(drawer));
      await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
      expect(patch.mock.calls[0]?.[0]).toBe("/api/v1/oncall/external-vendors/{vendorId}");
      expect(patch.mock.calls[0]?.[1]).toMatchObject({
        params: { path: { vendorId: "v1" } },
        body: { baaInEffect: false, rnCoverageAttested: true, baaExpiresOn: null },
      });
      await waitFor(() => expect(screen.queryByRole("complementary", { name: RENEW })).toBeNull());
    });

    it("shows a refused write in the drawer beside Save, and drops it on Cancel and reopen", async () => {
      mount({ patch: async () => refused });
      const drawer = await openRenew();
      fireEvent.click(saveButton(drawer));
      expect((await within(drawer).findByRole("alert")).textContent).toContain(REFUSAL);
      expect(screen.getAllByText(REFUSAL)).toHaveLength(1);
      expect(saveButton(drawer).disabled).toBe(false);

      fireEvent.click(cancelButton(drawer));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: RENEW })).toBeNull());
      await openRenew();
      expect(screen.queryByText(REFUSAL)).toBeNull();
    });

    it("frees the drawer and says so when the request is lost (the client rejects)", async () => {
      mount({ patch: lost });
      const drawer = await openRenew();
      fireEvent.click(saveButton(drawer));
      expect((await within(drawer).findByRole("alert")).textContent).toContain(
        "No answer came back; it may not have been recorded",
      );
      expect(saveButton(drawer).disabled).toBe(false);
      expect(cancelButton(drawer).disabled).toBe(false);
      fireEvent.click(cancelButton(drawer));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: RENEW })).toBeNull());
    });

    it("makes the bindings inert while the write is in flight, and live again once it lands", async () => {
      const write = pending();
      mount({ patch: () => write.promise });
      const drawer = await openRenew();
      fireEvent.click(saveButton(drawer));

      await waitFor(() => expect(cancelButton(drawer).disabled).toBe(true));
      expectPageInert();
      expect(drawer.closest("[inert]")).toBeNull();

      write.finish();
      await waitFor(() => expect(screen.queryByRole("complementary", { name: RENEW })).toBeNull());
      await waitFor(() => expect(document.querySelector("[inert]")).toBeNull());
    });
  });
  describe("forms that start from scratch every time", () => {
    const input = (drawer: HTMLElement, label: string) =>
      within(drawer).getByLabelText(label) as HTMLInputElement;
    const RN = "The vendor has attested to RN-level coverage";

    function fillEverything(drawer: HTMLElement): void {
      fillValidBinding(drawer);
      fireEvent.click(input(drawer, RN));
      fireEvent.change(input(drawer, "BAA expiry (optional)"), { target: { value: "2028-01-31" } });
      fireEvent.change(within(drawer).getByLabelText("PHI-minimization profile"), {
        target: { value: "minimum_necessary" },
      });
    }

    function expectBlankBind(drawer: HTMLElement): void {
      expect(input(drawer, "Canonical vendor entity id").value).toBe("");
      expect(input(drawer, "Display name").value).toBe("");
      expect(input(drawer, "Adapter key").value).toBe("");
      // A compliance attestation never carries over to the next binding.
      expect(input(drawer, "A BAA is in force (required)").checked).toBe(false);
      expect(input(drawer, RN).checked).toBe(false);
      expect(input(drawer, "BAA expiry (optional)").value).toBe("");
      expect(
        (within(drawer).getByLabelText("PHI-minimization profile") as HTMLSelectElement).value,
      ).toBe("hybrid_phi_min");
      expect(bindButton(drawer).disabled).toBe(true);
    }

    it("reopens Bind blank and unticked after a binding was saved", async () => {
      const { post } = mount();
      const drawer = await openBind();
      fillEverything(drawer);
      fireEvent.click(bindButton(drawer));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: BIND })).toBeNull());
      expectBlankBind(await openBind());
    });

    it("reopens Bind blank and unticked after Cancel", async () => {
      mount();
      const drawer = await openBind();
      fillEverything(drawer);
      fireEvent.click(cancelButton(drawer));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: BIND })).toBeNull());
      expectBlankBind(await openBind());
    });

    it("keeps the draft when Bind a vendor is clicked again while the drawer is open", async () => {
      mount();
      const drawer = await openBind();
      fillEverything(drawer);
      fireEvent.click(screen.getByRole("button", { name: "Bind a vendor" }));
      expect(input(drawer, "Display name").value).toBe("Harbor Night Triage");
      expect(input(drawer, "A BAA is in force (required)").checked).toBe(true);
      expect(bindButton(drawer).disabled).toBe(false);
    });

    it("reopens a renewal from the binding, not from an abandoned edit", async () => {
      mount();
      const drawer = await openRenew();
      fireEvent.click(input(drawer, "A BAA is in force"));
      fireEvent.click(input(drawer, RN));
      fireEvent.change(input(drawer, "BAA expiry"), { target: { value: "" } });
      fireEvent.click(cancelButton(drawer));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: RENEW })).toBeNull());
      const reopened = await openRenew();
      expect(input(reopened, "A BAA is in force").checked).toBe(true);
      expect(input(reopened, RN).checked).toBe(true);
      expect(input(reopened, "BAA expiry").value).toBe("2027-06-06");
    });

    it("keeps the renewal edit when the open binding's own button is chosen again", async () => {
      mount();
      const drawer = await openRenew();
      fireEvent.click(input(drawer, "A BAA is in force"));
      fireEvent.click(screen.getByRole("button", { name: "BAA renewal" }));
      expect(input(drawer, "A BAA is in force").checked).toBe(false);
    });
  });
});
