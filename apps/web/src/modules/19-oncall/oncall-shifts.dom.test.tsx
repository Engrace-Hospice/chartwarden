// @vitest-environment jsdom
// "Add shift" is a multi-field form on a list screen, so it opens as a drawer in the detail rail beside the roster
// (the redesign's pattern), not as a dialog over it. Cancel closes it and sends nothing; Create stays disabled until
// the form is valid and then sends the shift; a refused or lost write is announced in the drawer and never leaves it
// stuck; while the write is in flight the roster beside it is inert.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_ANSWER_MESSAGE } from "./drawer-write";
import { OnCallShiftsScreen } from "./oncall-shifts";

afterEach(cleanup);

const ENTITY = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-aaaa-4aaa-8aaa-333333333333";
const REFUSAL = "That window overlaps a shift already on the roster.";

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const refused = {
  data: undefined,
  error: { error: { code: "SHIFT_OVERLAP", message: REFUSAL, correlationId: "c" } },
  response: new Response(null, { status: 409 }),
};

const shift = {
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  providerEntityId: ENTITY,
  shiftStartsAt: "2026-11-18T20:00:00.000Z",
  shiftEndsAt: "2026-11-19T08:00:00.000Z",
  discipline: "clinical_rn",
  status: "scheduled",
  primaryOnCallMembershipId: MEMBERSHIP,
  backupMembershipId: null,
  externalActorId: null,
  externalActorLabel: null,
  openedAt: null,
  closedAt: null,
  m17VisitAssignmentRef: null,
  cancellationReason: null,
  version: 1,
};

type Post = ReturnType<typeof vi.fn>;

function mount(post: Post = vi.fn(async () => ok({}))): { post: Post } {
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/oncall/current") {
        return ok({ asOf: "2026-11-18T12:00:00.000Z", perProviderEntity: [] });
      }
      if (path === "/api/v1/provider-entities") {
        return ok({
          items: [
            { id: ENTITY, legalName: "Cedar Hospice", ccn: "381588", npi: null, status: "active" },
          ],
          nextCursor: null,
        });
      }
      return ok({ data: [shift], next_cursor: null, has_more: false });
    }),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <OnCallShiftsScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

const addShift = async () => (await screen.findAllByRole("button", { name: "Add shift" }))[0];

async function openDrawer(): Promise<HTMLElement> {
  fireEvent.click((await addShift()) as HTMLElement);
  return screen.findByRole("complementary", { name: "Add an on-call shift" });
}

async function fillValidForm(drawer: HTMLElement): Promise<void> {
  fireEvent.focus(within(drawer).getByRole("combobox", { name: /Provider entity/ }));
  fireEvent.click(await screen.findByRole("option", { name: /Cedar Hospice/ }));
  fireEvent.change(within(drawer).getByLabelText("Primary membership id"), {
    target: { value: MEMBERSHIP },
  });
}

const createButton = (drawer: HTMLElement) =>
  within(drawer).getByRole("button", { name: /Create shift|Creating/ }) as HTMLButtonElement;

describe("on-call roster — add a shift", () => {
  it("opens the form as a drawer beside the roster, not a dialog over it", async () => {
    mount();
    const drawer = await openDrawer();
    expect(within(drawer).getByLabelText("Starts at")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The roster stays on the page while the form is open.
    expect(screen.getByRole("heading", { name: "On-call roster" })).toBeTruthy();
  });

  it("closes from Cancel without sending anything", async () => {
    const { post } = mount();
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Add an on-call shift" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps Create shift disabled until the form is valid, then sends the shift and closes", async () => {
    const { post } = mount();
    const drawer = await openDrawer();
    expect(createButton(drawer).disabled).toBe(true);

    fireEvent.focus(within(drawer).getByRole("combobox", { name: /Provider entity/ }));
    fireEvent.click(await screen.findByRole("option", { name: /Cedar Hospice/ }));
    expect(createButton(drawer).disabled).toBe(true);

    fireEvent.change(within(drawer).getByLabelText("Primary membership id"), {
      target: { value: MEMBERSHIP },
    });
    expect(createButton(drawer).disabled).toBe(false);

    fireEvent.change(within(drawer).getByLabelText("Ends at"), {
      target: { value: "2000-01-01T00:00" },
    });
    expect(createButton(drawer).disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Ends at"), {
      target: { value: "2999-01-01T00:00" },
    });

    fireEvent.click(createButton(drawer));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[0]).toBe("/api/v1/oncall/shifts");
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      body: {
        providerEntityId: ENTITY,
        discipline: "clinical_rn",
        primaryOnCallMembershipId: MEMBERSHIP,
      },
    });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Add an on-call shift" })).toBeNull(),
    );
  });

  it("shows a refused write in the drawer beside Save, and drops it on Cancel and reopen", async () => {
    mount(vi.fn(async () => refused));
    const drawer = await openDrawer();
    await fillValidForm(drawer);
    fireEvent.click(createButton(drawer));
    expect((await within(drawer).findByRole("alert")).textContent).toContain(REFUSAL);
    // Only in the drawer: not also a page banner above the roster.
    expect(screen.getAllByText(REFUSAL)).toHaveLength(1);
    expect(createButton(drawer).disabled).toBe(false);

    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    const reopened = await openDrawer();
    expect(screen.queryByText(REFUSAL)).toBeNull();
    expect(within(reopened).queryByRole("alert")).toBeNull();
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
    expect((await within(drawer).findByRole("alert")).textContent).toContain(NO_ANSWER_MESSAGE);
    expect(createButton(drawer).disabled).toBe(false);
    const cancel = within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Add an on-call shift" })).toBeNull(),
    );
  });

  it("makes the roster inert while the write is in flight, and live again once it lands", async () => {
    let finish: (value: ReturnType<typeof ok>) => void = () => undefined;
    const pending = new Promise<ReturnType<typeof ok>>((resolve) => {
      finish = resolve;
    });
    mount(vi.fn(async () => pending));
    const drawer = await openDrawer();
    await fillValidForm(drawer);
    fireEvent.click(createButton(drawer));

    await waitFor(() => expect(createButton(drawer).textContent).toBe("Creating..."));
    const rowLink = within(screen.getByRole("table")).getByRole("link", { hidden: true });
    expect(rowLink.closest("[inert]")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "On-call policy", hidden: true }).closest("[inert]"),
    ).not.toBeNull();
    expect(drawer.closest("[inert]")).toBeNull();
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    finish(ok({}));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Add an on-call shift" })).toBeNull(),
    );
    await waitFor(() => expect(document.querySelector("[inert]")).toBeNull());
  });
});
