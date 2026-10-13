// M36 WP 2.11 round 4 — member row focus, busy feedback, announced forbidden state, per-verb refusal copy.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ChannelMembersDialog } from "./channel-members-dialog";

const MEMBERS = "/api/v1/messaging/channels/{id}/members";
const person = (id: string, name: string) => ({
  userId: id,
  displayName: name,
  role: "member",
  source: "manual",
});
const listOf = (...people: ReturnType<typeof person>[]) => ({
  data: { members: people },
  error: undefined,
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Reply = Record<string, unknown>;
function makeClient(handlers: {
  members?: () => Reply | Promise<Reply>;
  post?: () => Reply | Promise<Reply>;
  del?: () => Reply | Promise<Reply>;
}) {
  return {
    GET: vi.fn((path: string) =>
      Promise.resolve(
        path === MEMBERS
          ? (handlers.members?.() ?? listOf())
          : { data: { staff: [] }, error: undefined },
      ),
    ),
    POST: vi.fn(() => Promise.resolve(handlers.post?.() ?? { error: undefined })),
    DELETE: vi.fn(() => Promise.resolve(handlers.del?.() ?? { error: undefined })),
  };
}
const provide = (api: ReturnType<typeof makeClient>, ui: React.ReactElement) => (
  <MemoryRouter>
    <ApiClientProvider client={api as unknown as ApiClient}>{ui}</ApiClientProvider>
  </MemoryRouter>
);
const dialog = (props: Partial<React.ComponentProps<typeof ChannelMembersDialog>> = {}) => (
  <ChannelMembersDialog channelId="ch-1" channelTitle="North" open onClose={() => {}} {...props} />
);

describe("member rows", () => {
  const three = () => listOf(person("u-1", "Ann"), person("u-2", "Bea"), person("u-3", "Cy"));

  it("moves focus to the next row's Remove after removing a member", async () => {
    let members = three();
    const api = makeClient({
      members: () => members,
      del: () => {
        members = listOf(person("u-1", "Ann"), person("u-3", "Cy"));
        return { error: undefined };
      },
    });
    render(provide(api, dialog()));
    const remove = await screen.findByRole("button", { name: "Remove Bea" });
    remove.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Bea" })).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Cy" })),
    );
  });

  it("falls back to the previous row when the last row is removed", async () => {
    let members = three();
    const api = makeClient({
      members: () => members,
      del: () => {
        members = listOf(person("u-1", "Ann"), person("u-2", "Bea"));
        return { error: undefined };
      },
    });
    render(provide(api, dialog()));
    const remove = await screen.findByRole("button", { name: "Remove Cy" });
    remove.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Bea" })),
    );
  });

  it("falls back to the heading when the only member is removed", async () => {
    let members = listOf(person("u-1", "Ann"));
    const api = makeClient({
      members: () => members,
      del: () => {
        members = listOf();
        return { error: undefined };
      },
    });
    render(provide(api, dialog()));
    const remove = await screen.findByRole("button", { name: "Remove Ann" });
    remove.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Ann" })).toBeNull());
    await waitFor(() => expect(document.activeElement?.tagName).not.toBe("BODY"));
  });

  it("keeps Remove focused and aria-disabled (not disabled) while a change is in flight", async () => {
    const del = deferred<Reply>();
    const api = makeClient({ members: three });
    api.DELETE.mockImplementation(() => del.promise as Promise<{ error: undefined }>);
    render(provide(api, dialog()));
    const remove = await screen.findByRole("button", { name: "Remove Bea" });
    remove.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(api.DELETE).toHaveBeenCalledTimes(1));
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect((remove as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(remove);
    await userEvent.keyboard("{Enter}");
    expect(api.DELETE).toHaveBeenCalledTimes(1);
    del.resolve({ error: undefined });
  });

  it("does not pull focus back if the user moved on while the removal ran", async () => {
    let members = three();
    const del = deferred<Reply>();
    const api = makeClient({ members: () => members });
    api.DELETE.mockImplementation(() => {
      members = listOf(person("u-1", "Ann"), person("u-3", "Cy"));
      return del.promise as Promise<{ error: undefined }>;
    });
    render(provide(api, dialog()));
    const remove = await screen.findByRole("button", { name: "Remove Bea" });
    remove.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(api.DELETE).toHaveBeenCalled());
    const search = screen.getByLabelText("Find staff");
    search.focus();
    del.resolve({ error: undefined });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Bea" })).toBeNull());
    expect(document.activeElement).toBe(search);
  });

  it("makes Remove a 44px touch target", async () => {
    render(provide(makeClient({ members: three }), dialog()));
    const remove = await screen.findByRole("button", { name: "Remove Bea" });
    expect(remove.style.minHeight).toBe("2.875rem");
  });
});

describe("out-of-order member loads", () => {
  it("ignores an older response that lands after a newer one", async () => {
    const older = deferred<Reply>();
    let calls = 0;
    const api = makeClient({
      members: () => {
        calls += 1;
        return calls === 1 ? (older.promise as unknown as Reply) : listOf(person("u-new", "Newer"));
      },
    });
    const { rerender } = render(provide(api, dialog()));
    await waitFor(() => expect(calls).toBe(1));
    rerender(provide(api, dialog({ open: false })));
    rerender(provide(api, dialog({ open: true })));
    await screen.findByText("Newer");
    older.resolve(listOf(person("u-old", "Older")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Older")).toBeNull();
    expect(screen.getByText("Newer")).toBeTruthy();
  });
});

describe("forbidden state is announced", () => {
  it("ties Close to the title text", async () => {
    const api = makeClient({
      members: () => ({ data: undefined, error: { message: "no" }, response: { status: 403 } }),
    });
    render(provide(api, dialog()));
    await screen.findByText("You can't manage members of this conversation.");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Close"));
    const described = document.getElementById(
      document.activeElement?.getAttribute("aria-describedby") ?? "",
    );
    expect(described?.textContent).toContain("You can't manage members of this conversation.");
  });
});

describe("archive control, round 4", () => {
  const confirmArchive = async (verb: "Archive" | "Unarchive") => {
    await userEvent.click(await screen.findByRole("button", { name: `${verb} conversation` }));
    await userEvent.click(screen.getByRole("button", { name: `Confirm ${verb.toLowerCase()}` }));
  };

  it.each([
    [false, 409, "This kind of conversation can't be archived."],
    [false, 403, "You don't have permission to archive conversations."],
    [true, 409, "This kind of conversation can't be unarchived."],
    [true, 403, "You don't have permission to unarchive conversations."],
  ])("archived=%s: a %s refusal reads %s", async (archived, status, copy) => {
    const api = makeClient({ post: () => ({ error: { message: "x" }, response: { status } }) });
    render(provide(api, dialog({ canArchive: true, archived })));
    await confirmArchive(archived ? "Unarchive" : "Archive");
    expect(await screen.findByText((text) => text.includes(copy))).toBeTruthy();
  });

  it("dims Confirm and Cancel through inline style while the request is in flight", async () => {
    const post = deferred<Reply>();
    const api = makeClient({});
    api.POST.mockImplementation(() => post.promise as Promise<{ error: undefined }>);
    render(provide(api, dialog({ canArchive: true })));
    await confirmArchive("Archive");
    for (const name of ["Confirm archive", "Cancel"]) {
      const button = screen.getByRole("button", { name });
      expect(button.style.opacity, name).toBe("0.6");
      expect(button.style.cursor, name).toBe("not-allowed");
    }
    post.resolve({ error: undefined });
  });

  it("swallows Escape while busy so the dialog does not close mid-request", async () => {
    const post = deferred<Reply>();
    const onClose = vi.fn();
    const api = makeClient({});
    api.POST.mockImplementation(() => post.promise as Promise<{ error: undefined }>);
    render(provide(api, dialog({ canArchive: true, onClose })));
    await confirmArchive("Archive");
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    post.resolve({ error: undefined });
  });

  it("does not steal focus when the confirm closes while focus is elsewhere in the dialog", async () => {
    const post = deferred<Reply>();
    const api = makeClient({});
    api.POST.mockImplementation(() => post.promise as Promise<{ error: undefined }>);
    render(provide(api, dialog({ canArchive: true })));
    await confirmArchive("Archive");
    const search = screen.getByLabelText("Find staff");
    search.focus();
    post.resolve({ error: undefined });
    await screen.findByRole("button", { name: "Unarchive conversation" });
    expect(document.activeElement).toBe(search);
  });
});
