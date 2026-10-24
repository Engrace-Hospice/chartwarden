// M36 WP 6.9 (ADR-0098, PROPOSED) - the Death follow-up screen against a mocked network boundary: the flag-off and empty states, a board with
// states as words, actions only where the server offers them, complete (one request on a double click, the exact path), reassign (client-side id
// check, the exact body, a refusal shown in the dialog), the refresh-failed alert, and axe.
import type { DeathBoardDto, DeathBoardItemDto } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { DeathBoard, itemState } from "./death-board";

const ORG = "33333333-3333-4333-8333-333333333333";
const ITEM = "11111111-1111-4111-8111-111111111111";
const TARGET = "44444444-4444-4444-8444-444444444444";

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
const ok = (data: unknown): Reply => ({ data, response: { status: 200 } });
const fail = (status: number): Reply => ({ error: {}, response: { status } });

const item = (over: Partial<DeathBoardItemDto> = {}): DeathBoardItemDto => ({
  id: ITEM,
  item_key: "pronouncement",
  label: "Pronouncement of death recorded",
  status: "open",
  owner_user_id: "55555555-5555-4555-8555-555555555555",
  owner_display_name: "Nia Nurse",
  needs_owner: false,
  due_at: "2026-10-23T14:00:00.000Z",
  overdue: false,
  completed_at: null,
  completed_by_user_id: null,
  actions: ["complete", "reassign"],
  ...over,
});
const board = (items: DeathBoardItemDto[] = [item()]): DeathBoardDto => ({
  id: "66666666-6666-4666-8666-666666666666",
  patient_id: "77777777-7777-4777-8777-777777777777",
  patient_display_name: "Ann B.",
  mrn_suffix: "1234",
  created_at: "2026-10-23T12:00:00.000Z",
  open_count: items.filter((i) => i.status === "open").length,
  items,
});

interface Routes {
  list?: () => Reply;
  post?: (path: string, body: unknown) => Promise<Reply> | Reply;
}
function mount(routes: Routes = {}) {
  const GET = vi.fn(
    (path: string): Promise<Reply> =>
      Promise.resolve(
        path === "/api/v1/messaging/dm/staff"
          ? ok({ staff: [{ userId: TARGET, displayName: "Tina Target" }] })
          : (routes.list?.() ?? ok({ enabled: true, boards: [board()] })),
      ),
  );
  const POST = vi.fn(
    (path: string, init?: { body?: unknown }): Promise<Reply> =>
      Promise.resolve(routes.post?.(path, init?.body) ?? ok({ item: item() })),
  );
  const view = render(
    <MemoryRouter initialEntries={["/messaging/death-board"]}>
      <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
        <SessionProvider
          session={{ userId: "u1", organizationId: ORG, permissions: ["messaging.read"] }}
        >
          <main>
            <DeathBoard />
          </main>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("helpers", () => {
  it("states are one word, and No owner outranks Overdue", () => {
    expect(itemState(item()).label).toBe("Open");
    expect(itemState(item({ overdue: true })).label).toBe("Overdue");
    expect(itemState(item({ overdue: true, needs_owner: true })).label).toBe("No owner");
    expect(itemState(item({ status: "done" })).label).toBe("Done");
  });
});

describe("DeathBoard screen", () => {
  it("says it is not turned on, rather than empty, when the flag is off", async () => {
    mount({ list: () => ok({ enabled: false, boards: [] }) });
    expect(await screen.findByText("Death follow-up is not turned on")).toBeTruthy();
  });

  it("shows an empty state when there are no boards", async () => {
    mount({ list: () => ok({ enabled: true, boards: [] }) });
    expect(await screen.findByText("No follow-up lists")).toBeTruthy();
  });

  it("shows the patient, the owner, a state word and only the actions the server offers", async () => {
    mount({
      list: () =>
        ok({
          enabled: true,
          boards: [
            board([
              item(),
              item({
                id: "88888888-8888-4888-8888-888888888888",
                label: "Required documents filed",
                actions: [],
                needs_owner: true,
              }),
            ]),
          ],
        }),
    });
    expect(await screen.findByRole("heading", { name: /Ann B\./ })).toBeTruthy();
    expect(screen.getAllByText(/Owner: Nia Nurse/)).toHaveLength(2);
    expect(screen.getByText("No owner")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Mark complete" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Reassign" })).toHaveLength(1);
  });

  it("completes with one request on a double click and refreshes the list", async () => {
    const user = userEvent.setup();
    let release!: (r: Reply) => void;
    const held = new Promise<Reply>((r) => {
      release = r;
    });
    const t = mount({ post: () => held });
    const button = await screen.findByRole("button", { name: "Mark complete" });
    await user.dblClick(button);
    expect(t.POST).toHaveBeenCalledTimes(1);
    release(ok({ item: item({ status: "done" }) }));
    await waitFor(() => expect(t.GET.mock.calls.length).toBeGreaterThan(1));
    expect(t.POST).toHaveBeenCalledTimes(1);
    expect(t.POST.mock.calls[0]?.[0]).toBe("/api/v1/messaging/death-board-items/{itemId}/complete");
    await waitFor(() => expect(t.GET.mock.calls.length).toBeGreaterThan(1));
    expect(await screen.findByText(/marked complete/)).toBeTruthy();
  });

  async function pickColleague(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await within(dialog).findByRole("option", { name: /Tina Target/ }));
  }

  it("reassigns through the staff picker: needs a choice, sends the exact body, shows a refusal in the dialog", async () => {
    const user = userEvent.setup();
    const t = mount({ post: () => fail(422) });
    await user.click(await screen.findByRole("button", { name: "Reassign" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/user id/i)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Reassign" }));
    expect(t.POST).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Choose a colleague/)).toBeTruthy();
    await pickColleague(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(t.POST).toHaveBeenCalledTimes(1));
    expect(t.POST.mock.calls[0]?.[1]).toMatchObject({ body: { to_user_id: TARGET } });
    expect(await within(dialog).findByText(/cannot take this item/)).toBeTruthy();
  });

  it("a scrim click does not close the dialog once a colleague is chosen, but does while it is empty", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Reassign" }));
    const dialog = await screen.findByRole("dialog");
    const scrim = () =>
      screen.getAllByRole("button", { name: "Close" }).find((b) => b.tabIndex === -1) as HTMLElement;
    await pickColleague(user, dialog);
    await user.click(scrim());
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Clear selection" }));
    await user.click(scrim());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a skipped second submit neither closes the dialog nor loses the real failure", async () => {
    const user = userEvent.setup();
    let release!: (r: Reply) => void;
    const held = new Promise<Reply>((r) => {
      release = r;
    });
    const t = mount({ post: () => held });
    await user.click(await screen.findByRole("button", { name: "Reassign" }));
    const dialog = await screen.findByRole("dialog");
    await pickColleague(user, dialog);
    const form = dialog.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form); // same tick: the button has not painted disabled yet
    expect(t.POST).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    release(fail(422));
    expect(await within(dialog).findByText(/cannot take this item/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("shows a refresh-failed alert with the data kept", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const t = mount({
      list: () => (++calls === 1 ? ok({ enabled: true, boards: [board()] }) : fail(500)),
    });
    await user.click(await screen.findByRole("button", { name: "Mark complete" }));
    await waitFor(() => expect(t.GET.mock.calls.length).toBeGreaterThan(1));
    expect(await screen.findByText(/could not be refreshed/)).toBeTruthy();
    expect(screen.getByText("Pronouncement of death recorded")).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const t = mount();
    await screen.findByRole("heading", { name: /Ann B\./ });
    const results = await axe.run(t.container);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
