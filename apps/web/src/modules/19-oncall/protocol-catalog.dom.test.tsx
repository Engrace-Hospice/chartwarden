// @vitest-environment jsdom
// "Author a protocol" is a multi-field form on a list screen, so it opens as a drawer in the detail rail beside the
// catalog (the redesign's pattern), not as a dialog over it. Cancel closes it and sends nothing; Create stays disabled
// until the key, label and SNOMED code are valid and then sends the protocol; a refused or lost write is announced in the
// drawer and never leaves it stuck; while the write is in flight the catalog beside it is inert.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TriageProtocolView } from "./oncall-api";
import { TriageProtocolCatalogScreen } from "./protocol-catalog";

afterEach(cleanup);

const REFUSAL = "That key is already used by a platform protocol.";
const DRAWER = "Author a tenant protocol";

const protocol: TriageProtocolView = {
  id: "pr1",
  organizationId: null,
  key: "pain_crisis",
  chiefComplaintLabel: "Pain crisis",
  snomedCode: "22253000",
  disciplineRequired: "rn",
  isSystemLocked: true,
  requiresMandatoryEscalation: false,
  mandatoryEscalationTier: null,
  version: "1.0.0",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  sortOrder: 1,
  questions: [],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const refused = {
  data: undefined,
  error: { error: { code: "KEY_TAKEN", message: REFUSAL, correlationId: "c" } },
  response: new Response(null, { status: 409 }),
};

type Post = ReturnType<typeof vi.fn>;

function mount(post: Post = vi.fn(async () => ok({}))): { post: Post } {
  const client = {
    GET: vi.fn(async (path: string) =>
      path === "/api/v1/terminology/{system}/search"
        ? ok({ results: [{ code: "22253000", display: "Pain crisis" }] })
        : ok({ data: [protocol], next_cursor: null, has_more: false }),
    ),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <TriageProtocolCatalogScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

async function openDrawer(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Author a protocol" }));
  return screen.findByRole("complementary", { name: DRAWER });
}

const createButton = (drawer: HTMLElement) =>
  within(drawer).getByRole("button", { name: "Create" }) as HTMLButtonElement;

const type = (drawer: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(drawer).getByLabelText(label), { target: { value } });
};

async function pickSnomed(drawer: HTMLElement): Promise<void> {
  const input = within(drawer).getByRole("combobox", { name: /SNOMED code/ });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "22253000" } });
  fireEvent.click(await screen.findByRole("option", { name: /22253000/ }));
}

async function fillValidForm(drawer: HTMLElement): Promise<void> {
  type(drawer, "Key", "pain_flare_check");
  type(drawer, "Chief complaint label", "Pain flare check");
  await pickSnomed(drawer);
}

describe("triage protocol catalog — author a protocol", () => {
  it("opens the form as a drawer beside the catalog, not a dialog over it", async () => {
    mount();
    const drawer = await openDrawer();
    expect(within(drawer).getByLabelText("Chief complaint label")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The catalog stays on the page while the form is open.
    expect(screen.getByText("Pain crisis")).toBeTruthy();
  });

  it("closes from Cancel without sending anything", async () => {
    const { post } = mount();
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps Create disabled until the key, label and SNOMED code are valid, then sends the protocol and closes", async () => {
    const { post } = mount();
    const drawer = await openDrawer();
    expect(createButton(drawer).disabled).toBe(true);

    type(drawer, "Key", "pain_flare_check");
    type(drawer, "Chief complaint label", "Pain flare check");
    // No code yet.
    expect(createButton(drawer).disabled).toBe(true);
    await pickSnomed(drawer);
    expect(createButton(drawer).disabled).toBe(false);

    type(drawer, "Key", "Not A Key");
    expect(createButton(drawer).disabled).toBe(true);
    type(drawer, "Key", "pain_flare_check");
    type(drawer, "Chief complaint label", "Pa");
    expect(createButton(drawer).disabled).toBe(true);
    type(drawer, "Chief complaint label", "Pain flare check");
    expect(createButton(drawer).disabled).toBe(false);

    fireEvent.click(createButton(drawer));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[0]).toBe("/api/v1/triage-protocols");
    const { body } = post.mock.calls[0]?.[1] as { body: Record<string, unknown> };
    expect(body).toMatchObject({
      key: "pain_flare_check",
      chiefComplaintLabel: "Pain flare check",
      snomedCode: "22253000",
      disciplineRequired: "clinical_rn",
      requiresMandatoryEscalation: false,
    });
    expect(body).not.toHaveProperty("mandatoryEscalationTier");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
  });

  it("shows a refused write in the drawer beside Save, and drops it on Cancel and reopen", async () => {
    mount(vi.fn(async () => refused));
    const drawer = await openDrawer();
    await fillValidForm(drawer);
    fireEvent.click(createButton(drawer));
    expect((await within(drawer).findByRole("alert")).textContent).toContain(REFUSAL);
    // Only in the drawer: not also a page banner above the catalog.
    expect(screen.getAllByText(REFUSAL)).toHaveLength(1);
    expect(createButton(drawer).disabled).toBe(false);

    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
    await openDrawer();
    expect(screen.queryByText(REFUSAL)).toBeNull();
  });

  it("frees the drawer and says so when the request is lost (the client rejects)", async () => {
    mount(
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const drawer = await openDrawer();
    await fillValidForm(drawer);
    fireEvent.click(createButton(drawer));
    expect((await within(drawer).findByRole("alert")).textContent).toContain(
      "No answer came back; it may not have been recorded",
    );
    expect(createButton(drawer).disabled).toBe(false);
    const cancel = within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
  });

  it("makes the catalog inert while the write is in flight, and live again once it lands", async () => {
    let finish: (value: ReturnType<typeof ok>) => void = () => undefined;
    const pending = new Promise<ReturnType<typeof ok>>((resolve) => {
      finish = resolve;
    });
    mount(vi.fn(async () => pending));
    const drawer = await openDrawer();
    await fillValidForm(drawer);
    fireEvent.click(createButton(drawer));

    await waitFor(() =>
      expect(
        (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    const rowLink = within(screen.getByRole("table")).getByRole("link", { hidden: true });
    expect(rowLink.closest("[inert]")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Author a protocol", hidden: true }).closest("[inert]"),
    ).not.toBeNull();
    expect(drawer.closest("[inert]")).toBeNull();

    finish(ok({}));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
    await waitFor(() => expect(document.querySelector("[inert]")).toBeNull());
  });
  describe("a form that starts from scratch every time", () => {
    const input = (drawer: HTMLElement, label: string) =>
      within(drawer).getByLabelText(label) as HTMLInputElement;

    function expectBlankForm(drawer: HTMLElement): void {
      expect(input(drawer, "Key").value).toBe("");
      expect(input(drawer, "Chief complaint label").value).toBe("");
      expect(
        (within(drawer).getByRole("combobox", { name: /SNOMED code/ }) as HTMLInputElement).value,
      ).toBe("");
      expect(input(drawer, "This protocol always escalates").checked).toBe(false);
      expect(within(drawer).queryByLabelText("Escalation tier")).toBeNull();
      expect(createButton(drawer).disabled).toBe(true);
    }

    it("reopens blank after a protocol was saved, the always-escalates flag included", async () => {
      const { post } = mount();
      const drawer = await openDrawer();
      await fillValidForm(drawer);
      fireEvent.click(input(drawer, "This protocol always escalates"));
      fireEvent.click(createButton(drawer));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect((post.mock.calls[0]?.[1] as { body: unknown }).body).toMatchObject({
        requiresMandatoryEscalation: true,
        mandatoryEscalationTier: "tier_1_rn_supervisor",
      });
      await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
      expectBlankForm(await openDrawer());
    });

    it("reopens blank after Cancel", async () => {
      mount();
      const drawer = await openDrawer();
      await fillValidForm(drawer);
      fireEvent.click(input(drawer, "This protocol always escalates"));
      fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
      expectBlankForm(await openDrawer());
    });

    it("keeps the draft when Author a protocol is clicked again while the drawer is open", async () => {
      mount();
      const drawer = await openDrawer();
      await fillValidForm(drawer);
      fireEvent.click(screen.getByRole("button", { name: "Author a protocol" }));
      expect(input(drawer, "Key").value).toBe("pain_flare_check");
      expect(createButton(drawer).disabled).toBe(false);
    });
  });
});
