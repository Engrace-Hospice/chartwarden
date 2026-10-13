// M36 WP 2.11 phase 3-4 — member list states and archive / unarchive of department channels.
// Importers: none (test). API: ChannelMembersDialog, useAnnouncementTools. Data: GET members, POST archive/unarchive.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
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
  });

  it("shows the access-ended notice on 403 without leaking the title", async () => {
    const api = makeClient({
      members: () => ({ data: undefined, error: { message: "no" }, response: { status: 403 } }),
    });
    render(provide(api, dialog({ channelTitle: "Secret Unit" })));
    expect(await screen.findByText("You no longer have access to this conversation")).toBeTruthy();
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

  it("does not offer archive to a non-admin", async () => {
    mount("location", false);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await screen.findByText("Nurse One");
    expect(screen.queryByRole("button", { name: "Archive conversation" })).toBeNull();
  });
});
