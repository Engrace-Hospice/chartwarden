// M36 WP 2.11 phase 3-4 — member list states and archive / unarchive of department channels.
// Importers: none (test). API: ChannelMembersDialog, useAnnouncementTools. Data: GET members, POST archive/unarchive.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { ChannelMembersDialog } from "./channel-members-dialog";
import type { ChannelSummary } from "./messaging-types";
import { useAnnouncementTools } from "./use-announcement-tools";

const MEMBERS = "/api/v1/messaging/channels/{id}/members";
const ARCHIVE = "/api/v1/messaging/channels/{id}/archive";
const UNARCHIVE = "/api/v1/messaging/channels/{id}/unarchive";
const OK_MEMBERS = {
  data: {
    members: [{ userId: "u-1", displayName: "Nurse One", role: "member", source: "manual" }],
  },
  error: undefined,
};

type Reply = Record<string, unknown>;
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function makeClient(replies: { members?: () => Reply | Promise<Reply>; post?: () => Reply }) {
  return {
    GET: vi.fn((path: string) =>
      Promise.resolve(
        path === MEMBERS
          ? (replies.members?.() ?? OK_MEMBERS)
          : { data: { staff: [] }, error: undefined },
      ),
    ),
    POST: vi.fn(() => Promise.resolve(replies.post?.() ?? { error: undefined })),
    DELETE: vi.fn(() => Promise.resolve({ error: undefined })),
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

describe("member list states", () => {
  it("reads the member route and shows a busy skeleton until it answers", async () => {
    const api = makeClient({ members: () => new Promise(() => {}) });
    render(provide(api, dialog()));
    expect(screen.getByText("Loading members").closest("[aria-busy=true]")).toBeTruthy();
    expect(api.GET).toHaveBeenCalledWith(MEMBERS, { params: { path: { id: "ch-1" } } });
  });

  it("offers retry and quotes the correlation id when the list failed", async () => {
    let fail = true;
    const api = makeClient({
      members: () =>
        fail
          ? {
              data: undefined,
              error: { correlationId: "c-77", message: "boom" },
              response: { status: 500 },
            }
          : OK_MEMBERS,
    });
    render(provide(api, dialog()));
    expect((await screen.findByRole("alert")).textContent).toContain("c-77");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Nurse One")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a thrown load shows the failure and no stale correlation id from an earlier failure", async () => {
    let mode: "http" | "throw" = "http";
    const api = makeClient({
      members: () => {
        if (mode === "throw") throw new Error("offline");
        return { data: undefined, error: { correlationId: "c-old" }, response: { status: 500 } };
      },
    });
    render(provide(api, dialog()));
    expect((await screen.findByRole("alert")).textContent).toContain("c-old");
    mode = "throw";
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).not.toContain("c-old"));
    expect(screen.getByRole("alert").textContent).toContain("could not be loaded");
  });

  it("says the viewer cannot manage members on 403, without leaking the title or the access-ended wording", async () => {
    const api = makeClient({
      members: () => ({ data: undefined, error: { message: "no" }, response: { status: 403 } }),
    });
    render(provide(api, dialog({ channelTitle: "Secret Unit" })));
    expect(
      (await screen.findAllByText("You can't manage members of this conversation.")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/no longer have access/)).toBeNull();
    expect(screen.queryByText(/Secret Unit/)).toBeNull();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Members");
  });

  it("closes on Escape and restores focus to the opener", async () => {
    const api = makeClient({});
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Members
          </button>
          {dialog({ open, onClose: () => setOpen(false) })}
        </>
      );
    }
    render(provide(api, <Harness />));
    const opener = screen.getByRole("button", { name: "Members" });
    await userEvent.click(opener);
    await screen.findByText("Nurse One");
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

describe("archive and unarchive", () => {
  const archiveButton = () => screen.findByRole("button", { name: "Archive conversation" });

  it("is not offered unless the viewer may archive", async () => {
    render(provide(makeClient({}), dialog()));
    await screen.findByText("Nurse One");
    expect(screen.queryByRole("button", { name: /archive conversation/i })).toBeNull();
  });

  it("asks for confirmation, then archives and tells the parent", async () => {
    const api = makeClient({});
    const onChanged = vi.fn();
    render(provide(api, dialog({ canArchive: true, onChanged })));
    await userEvent.click(await archiveButton());
    expect(api.POST).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith(ARCHIVE, { params: { path: { id: "ch-1" } } }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it("cancel leaves the conversation untouched", async () => {
    const api = makeClient({});
    render(provide(api, dialog({ canArchive: true })));
    await userEvent.click(await archiveButton());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.POST).not.toHaveBeenCalled();
    expect(await archiveButton()).toBeTruthy();
  });

  it.each([
    [409, "This kind of conversation can't be archived."],
    [403, "You don't have permission to archive conversations."],
  ])("explains a %s refusal", async (status, copy) => {
    const api = makeClient({ post: () => ({ error: { message: "x" }, response: { status } }) });
    const onChanged = vi.fn();
    render(provide(api, dialog({ canArchive: true, onChanged })));
    await userEvent.click(await archiveButton());
    await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
    expect(await screen.findByText((text) => text.includes(copy))).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("unarchives an archived conversation", async () => {
    const api = makeClient({});
    const onChanged = vi.fn();
    render(provide(api, dialog({ canArchive: true, archived: true, onChanged })));
    await userEvent.click(await screen.findByRole("button", { name: "Unarchive conversation" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm unarchive" }));
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith(UNARCHIVE, { params: { path: { id: "ch-1" } } }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });
});

describe("archive control focus and races", () => {
  it("Cancel returns focus to the trigger and Escape still closes the dialog", async () => {
    const onClose = vi.fn();
    render(provide(makeClient({}), dialog({ canArchive: true, onClose })));
    const trigger = await screen.findByRole("button", { name: "Archive conversation" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Archive conversation" }),
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape inside the confirm closes only the confirm", async () => {
    const onClose = vi.fn();
    render(provide(makeClient({}), dialog({ canArchive: true, onClose })));
    await userEvent.click(await screen.findByRole("button", { name: "Archive conversation" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Archive conversation" }),
    );
  });

  it("keeps focus on Confirm while the request is in flight and issues one POST on double click", async () => {
    const post = deferred<{ error: undefined }>();
    const api = makeClient({});
    api.POST.mockImplementation(() => post.promise);
    render(provide(api, dialog({ canArchive: true })));
    await userEvent.click(await screen.findByRole("button", { name: "Archive conversation" }));
    const confirm = screen.getByRole("button", { name: "Confirm archive" });
    confirm.focus();
    await userEvent.dblClick(confirm);
    expect(api.POST).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(confirm);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    post.resolve({ error: undefined });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unarchive conversation" })).toBeTruthy(),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Unarchive conversation" }),
    );
  });

  it("a network throw shows the failure text and returns focus to the trigger", async () => {
    const api = makeClient({});
    api.POST.mockImplementation(() => Promise.reject(new Error("offline")));
    render(provide(api, dialog({ canArchive: true })));
    await userEvent.click(await screen.findByRole("button", { name: "Archive conversation" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
    expect(await screen.findByText(/could not be updated/)).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Archive conversation" }),
    );
  });

  it("flips the verb and announces success once, after the refetch resolves", async () => {
    const refetch = deferred<void>();
    const onChanged = vi.fn(() => refetch.promise);
    render(provide(makeClient({}), dialog({ canArchive: true, onChanged })));
    await userEvent.click(await screen.findByRole("button", { name: "Archive conversation" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Confirm archive" }).getAttribute("aria-disabled"),
    ).toBe("true");
    refetch.resolve();
    expect(await screen.findByRole("button", { name: "Unarchive conversation" })).toBeTruthy();
    expect(screen.getAllByText("Conversation archived.")).toHaveLength(1);
  });

  it("clears the previous status when the confirm opens and ties the sentence to Confirm", async () => {
    const api = makeClient({
      post: () => ({ error: { message: "x" }, response: { status: 409 } }),
    });
    render(provide(api, dialog({ canArchive: true })));
    await userEvent.click(await screen.findByRole("button", { name: "Archive conversation" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
    await screen.findByText(/can't be archived/);
    await userEvent.click(screen.getByRole("button", { name: "Archive conversation" }));
    expect(screen.queryByText(/can't be archived/)).toBeNull();
    const confirm = screen.getByRole("button", { name: "Confirm archive" });
    const described = document.getElementById(confirm.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toContain("read only");
  });
});

describe("archive control round 3", () => {
  const trigger = () => screen.findByRole("button", { name: "Archive conversation" });

  it("describes what is being confirmed on BOTH Cancel and Confirm", async () => {
    render(provide(makeClient({}), dialog({ canArchive: true })));
    await userEvent.click(await trigger());
    for (const name of ["Cancel", "Confirm archive"]) {
      const button = screen.getByRole("button", { name });
      const sentence = document.getElementById(button.getAttribute("aria-describedby") ?? "");
      expect(sentence?.textContent, name).toContain("read only");
    }
  });

  it("does not revive a stale verb after the real state moves on and comes back", async () => {
    const api = makeClient({});
    const view = (archived: boolean) => provide(api, dialog({ canArchive: true, archived }));
    const { rerender } = render(view(false));
    await userEvent.click(await trigger());
    await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
    await screen.findByRole("button", { name: "Unarchive conversation" });
    rerender(view(true));
    rerender(view(false));
    expect(await screen.findByRole("button", { name: "Archive conversation" })).toBeTruthy();
  });

  it("keeps the archived message and adds a refresh note when the refetch reports failure or rejects", async () => {
    for (const onChanged of [() => Promise.resolve(false), () => Promise.reject(new Error("x"))]) {
      const { unmount } = render(provide(makeClient({}), dialog({ canArchive: true, onChanged })));
      await userEvent.click(await trigger());
      await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
      expect(
        await screen.findByText("Conversation archived. The list will refresh shortly."),
      ).toBeTruthy();
      expect(screen.queryByText(/Not updated/)).toBeNull();
      unmount();
    }
  });

  it("stops holding the buttons after the refetch cap and says the list will refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onChanged = vi.fn(() => new Promise<void>(() => {}));
      render(provide(makeClient({}), dialog({ canArchive: true, onChanged })));
      fireEvent.click(await trigger());
      fireEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_100);
      });
      expect(
        await screen.findByText("Conversation archived. The list will refresh shortly."),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Unarchive conversation" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("members dialog focus on state changes", () => {
  it("puts focus on Close when the members route answers 403", async () => {
    const api = makeClient({
      members: () => ({ data: undefined, error: { message: "no" }, response: { status: 403 } }),
    });
    render(provide(api, dialog()));
    await screen.findByText("You can't manage members of this conversation.");
    await waitFor(() =>
      expect(document.activeElement?.closest(".wx-channel-members-state")).toBeTruthy(),
    );
    expect(document.activeElement?.textContent).toBe("Close");
  });

  it("keeps Retry mounted and disabled during a retry, then lands focus on the heading", async () => {
    const retryReply = deferred<Reply>();
    let calls = 0;
    const api = makeClient({
      members: () => {
        calls += 1;
        if (calls === 1) {
          return { data: undefined, error: { message: "x" }, response: { status: 500 } };
        }
        return retryReply.promise as unknown as Reply;
      },
    });
    render(provide(api, dialog()));
    const retry = await screen.findByRole("button", { name: "Retry" });
    await userEvent.click(retry);
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    retryReply.resolve(OK_MEMBERS);
    await screen.findByText("Nurse One");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Members" })),
    );
  });
});

describe("member list races", () => {
  it("does not reload a list after the dialog closed mid-change", async () => {
    const post = deferred<{ error: undefined }>();
    const api = makeClient({});
    api.POST.mockImplementation(() => post.promise);
    api.GET.mockImplementation((path: string) =>
      Promise.resolve(
        path === MEMBERS
          ? OK_MEMBERS
          : {
              data: { staff: [{ userId: "u-2", displayName: "Nurse Two", roles: [] }] },
              error: undefined,
            },
      ),
    );
    const { rerender } = render(provide(api, dialog()));
    await screen.findByText("Nurse One");
    await screen.findByRole("option", { name: "Nurse Two" });
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.POST).toHaveBeenCalled());
    const before = api.GET.mock.calls.filter(([path]) => path === MEMBERS).length;
    rerender(provide(api, dialog({ open: false })));
    post.resolve({ error: undefined });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.GET.mock.calls.filter(([path]) => path === MEMBERS).length).toBe(before);
  });
});

describe("useAnnouncementTools archive gating", () => {
  const channel = (kind: ChannelSummary["kind"]) =>
    ({ channelId: "ch-1", kind, title: "North", archivedAt: null }) as unknown as ChannelSummary;
  function Harness({ kind }: { kind: ChannelSummary["kind"] }) {
    const tools = useAnnouncementTools(channel(kind), false, true, () => {});
    return (
      <>
        <button type="button" onClick={tools.onShowMembers}>
          open
        </button>
        {tools.dialogs}
      </>
    );
  }
  const mount = (kind: ChannelSummary["kind"], isAdmin: boolean) =>
    render(
      provide(
        makeClient({}),
        <SessionProvider session={{ isAdmin } as unknown as Session}>
          <Harness kind={kind} />
        </SessionProvider>,
      ),
    );

  it("offers archive to an org admin on a location channel", async () => {
    mount("location", true);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    expect(await screen.findByRole("button", { name: "Archive conversation" })).toBeTruthy();
  });

  it.each(["care_team", "announcement"] as const)(
    "never offers archive to an admin on a %s channel",
    async (kind) => {
      mount(kind, true);
      await userEvent.click(screen.getByRole("button", { name: "open" }));
      expect(screen.queryByRole("button", { name: /archive conversation/i })).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("does not offer archive to a non-admin", async () => {
    mount("location", false);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await screen.findByText("Nurse One");
    expect(screen.queryByRole("button", { name: "Archive conversation" })).toBeNull();
  });
});
