// M36 WP 2.9 — announcement read receipts, the announcement channel's composer rule, and department channels.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AnnouncementReceiptsDialog } from "./announcement-receipts";
import { ChannelMembersDialog } from "./channel-members-dialog";
import { ConversationThread } from "./conversation-thread";
import { DepartmentChannelDialog } from "./department-channel-dialog";
import type { ChannelSummary } from "./messaging-types";

const ME = "11111111-1111-4111-8111-111111111111";
const LOCATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Handler = (path: string, init?: Record<string, any>) => unknown;
function client(handlers: { GET?: Handler; POST?: Handler; DELETE?: Handler }) {
  const call = (verb: "GET" | "POST" | "DELETE") =>
    vi.fn((path: string, init?: Record<string, any>) =>
      Promise.resolve(
        handlers[verb]?.(path, init) ??
          (verb === "GET" ? { data: { messages: [] }, error: undefined } : { error: undefined }),
      ),
    );
  return { GET: call("GET"), POST: call("POST"), DELETE: call("DELETE") };
}
const provide = (api: ReturnType<typeof client>, ui: React.ReactElement) => (
  <MemoryRouter>
    <ApiClientProvider client={api as unknown as ApiClient}>{ui}</ApiClientProvider>
  </MemoryRouter>
);

const RECEIPTS = {
  messageId: "m-1",
  channelId: "an-1",
  sentAt: "2026-10-10T10:00:00.000Z",
  recipientCount: 3,
  readCount: 1,
  readers: [{ userId: "u-1", displayName: "Nurse One", readAt: "2026-10-10T10:05:00.000Z" }],
  unread: [
    { userId: "u-2", displayName: "Nurse Two" },
    { userId: "u-3", displayName: "Nurse Three" },
  ],
  truncated: false,
};
const receiptsPath = "/api/v1/messaging/announcements/{messageId}/receipts";

describe("AnnouncementReceiptsDialog", () => {
  it("shows the read count, who read it and who has not", async () => {
    const api = client({ GET: () => ({ data: RECEIPTS, error: undefined }) });
    render(provide(api, <AnnouncementReceiptsDialog messageId="m-1" onClose={() => {}} />));
    expect(await screen.findByText("Read by 1 of 3")).toBeTruthy();
    const read = screen.getByRole("region", { name: "Read (1)" });
    expect(within(read).getByText("Nurse One")).toBeTruthy();
    const unread = screen.getByRole("region", { name: "Not read yet (2)" });
    expect(within(unread).getByText("Nurse Two")).toBeTruthy();
    expect(api.GET).toHaveBeenCalledWith(receiptsPath, { params: { path: { messageId: "m-1" } } });
    expect(screen.getByText(/only means the message was opened/)).toBeTruthy();
  });

  it("shows a refusal with Retry, and recovers", async () => {
    let attempts = 0;
    const api = client({
      GET: () =>
        ++attempts === 1
          ? { data: undefined, error: { error: { code: "FORBIDDEN", message: "No access." } } }
          : { data: RECEIPTS, error: undefined },
    });
    render(provide(api, <AnnouncementReceiptsDialog messageId="m-1" onClose={() => {}} />));
    expect((await screen.findByRole("alert")).textContent).toContain("No access.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Read by 1 of 3")).toBeTruthy();
  });

  it("closes with Escape and renders nothing while no message is chosen", async () => {
    const onClose = vi.fn();
    const api = client({ GET: () => ({ data: RECEIPTS, error: undefined }) });
    const { rerender } = render(
      provide(api, <AnnouncementReceiptsDialog messageId="m-1" onClose={onClose} />),
    );
    await screen.findByText("Read by 1 of 3");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    rerender(provide(api, <AnnouncementReceiptsDialog messageId={null} onClose={onClose} />));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

const announcementChannel: ChannelSummary = {
  channelId: "an-1",
  kind: "announcement",
  title: "Announcements",
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  mentionCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-10T10:00:00.000Z",
  lastMessage: null,
};
const announcementMessage = {
  messageId: "m-1",
  channelId: "an-1",
  authorUserId: "admin-1",
  authorDisplayName: "Admin One",
  body: "All hands at noon",
  bodyKind: "plain",
  createdAt: "2026-10-10T10:00:00.000Z",
  parentMessageId: null,
  references: [],
};

function mountAnnouncements(permissions: { canAnnounce: boolean }) {
  const api = client({
    GET: (path) =>
      path === receiptsPath
        ? { data: RECEIPTS, error: undefined }
        : { data: { messages: [announcementMessage] }, error: undefined },
  });
  render(
    provide(
      api,
      <ConversationThread
        channel={announcementChannel}
        meId={ME}
        meDisplayName="Me"
        onBack={() => {}}
        onReadConfirmed={() => {}}
        onMessageSent={() => {}}
        onAccessRevoked={() => {}}
        canAnnounce={permissions.canAnnounce}
      />,
    ),
  );
  return api;
}

describe("the announcement channel in a conversation", () => {
  it("is read-only for a member: no composer, no receipts, no reply", async () => {
    mountAnnouncements({ canAnnounce: false });
    await screen.findByText("All hands at noon");
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getByText("Only administrators can post announcements.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Read receipts/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reply in thread/ })).toBeNull();
  });

  it("gives an announcer the composer and a keyboard-reachable receipts dialog", async () => {
    const api = mountAnnouncements({ canAnnounce: true });
    await screen.findByText("All hands at noon");
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    const open = screen.getByRole("button", { name: /Read receipts for the announcement/ });
    open.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("Read by 1 of 3")).toBeTruthy();
    expect(api.GET).toHaveBeenCalledWith(receiptsPath, { params: { path: { messageId: "m-1" } } });
    expect(screen.queryByRole("button", { name: /Reply in thread/ })).toBeNull();
  });
});

describe("DepartmentChannelDialog", () => {
  const handlers = (post?: Handler) => ({
    GET: (path: string) =>
      path === "/api/v1/locations"
        ? { data: { items: [{ id: LOCATION_ID, name: "North Campus" }], nextCursor: null } }
        : {
            data: {
              roles: [
                { roleId: ROLE_ID, name: "Social Work", category: "clinical_staff", enabled: true },
                { roleId: "x", name: "Billing Clerk", category: "billing_finance", enabled: true },
                { roleId: "y", name: "Retired RN", category: "clinical_staff", enabled: false },
              ],
            },
          },
    POST: post ?? (() => ({ data: { channelId: "ch-9", created: true }, error: undefined })),
  });

  it("creates a location channel and hands its id to the opener", async () => {
    const api = client(handlers());
    const onCreated = vi.fn(() => Promise.resolve(true));
    render(provide(api, <DepartmentChannelDialog open onClose={() => {}} onCreated={onCreated} />));
    expect(await screen.findByRole("option", { name: "North Campus" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Channel name (optional)"), " Huddle ");
    await userEvent.click(screen.getByRole("button", { name: "Open channel" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("ch-9"));
    expect(api.POST).toHaveBeenCalledWith("/api/v1/messaging/department-channels", {
      body: { kind: "location", subjectId: LOCATION_ID, title: "Huddle" },
    });
  });

  it("offers only enabled clinical roles as disciplines", async () => {
    const api = client(handlers());
    render(
      provide(
        api,
        <DepartmentChannelDialog open onClose={() => {}} onCreated={() => Promise.resolve(true)} />,
      ),
    );
    await userEvent.click(await screen.findByRole("tab", { name: "Discipline" }));
    expect(await screen.findByRole("option", { name: "Social Work" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Billing Clerk" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Retired RN" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open channel" }));
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith("/api/v1/messaging/department-channels", {
        body: { kind: "discipline", subjectId: ROLE_ID },
      }),
    );
  });

  it("shows a refusal and does not open anything", async () => {
    const api = client(
      handlers(() => ({
        data: undefined,
        error: { error: { code: "FORBIDDEN", message: "Only administrators can do this." } },
      })),
    );
    const onCreated = vi.fn(() => Promise.resolve(true));
    render(provide(api, <DepartmentChannelDialog open onClose={() => {}} onCreated={onCreated} />));
    await screen.findByRole("option", { name: "North Campus" });
    await userEvent.click(screen.getByRole("button", { name: "Open channel" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Only administrators can do this.",
    );
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("reports a channel that was created but could not be opened", async () => {
    const api = client(handlers());
    render(
      provide(
        api,
        <DepartmentChannelDialog
          open
          onClose={() => {}}
          onCreated={() => Promise.resolve(false)}
        />,
      ),
    );
    await screen.findByRole("option", { name: "North Campus" });
    await userEvent.click(screen.getByRole("button", { name: "Open channel" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be opened");
  });
});

describe("ChannelMembersDialog", () => {
  const detail = (members: { userId: string; displayName: string }[]) => ({
    data: { members: members.map((m) => ({ ...m, role: "member", source: "manual" })) },
    error: undefined,
  });

  it("lists members, adds a staff member and removes another", async () => {
    let members = [{ userId: "u-1", displayName: "Nurse One" }];
    const api = client({
      GET: (path) =>
        path === "/api/v1/messaging/dm/staff"
          ? {
              data: {
                staff: [
                  { userId: "u-1", displayName: "Nurse One", roles: [] },
                  { userId: "u-2", displayName: "Nurse Two", roles: [] },
                ],
              },
            }
          : detail(members),
      POST: () => {
        members = [...members, { userId: "u-2", displayName: "Nurse Two" }];
        return { error: undefined };
      },
      DELETE: () => {
        members = members.filter((m) => m.userId !== "u-1");
        return { error: undefined };
      },
    });
    render(
      provide(
        api,
        <ChannelMembersDialog
          channelId="ch-1"
          channelTitle="North Campus"
          open
          onClose={() => {}}
        />,
      ),
    );
    const list = await screen.findByRole("list", { name: "Channel members" });
    expect(within(list).getByText("Nurse One")).toBeTruthy();
    // The member already in the channel is not offered again.
    await waitFor(() => expect(screen.getByRole("option", { name: "Nurse Two" })).toBeTruthy());
    expect(screen.queryByRole("option", { name: "Nurse One" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith("/api/v1/messaging/channels/{id}/members", {
        params: { path: { id: "ch-1" } },
        body: { userId: "u-2" },
      }),
    );
    await waitFor(() => expect(within(list).getByText("Nurse Two")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Remove Nurse One" }));
    await waitFor(() =>
      expect(api.DELETE).toHaveBeenCalledWith("/api/v1/messaging/channels/{id}/members/{userId}", {
        params: { path: { id: "ch-1", userId: "u-1" } },
      }),
    );
    await waitFor(() => expect(within(list).queryByText("Nurse One")).toBeNull());
  });

  it("shows a refusal from the server", async () => {
    const api = client({
      GET: (path) =>
        path === "/api/v1/messaging/dm/staff"
          ? { data: { staff: [{ userId: "u-2", displayName: "Nurse Two", roles: [] }] } }
          : detail([]),
      POST: () => ({
        error: { error: { code: "FORBIDDEN", message: "Not permitted for this channel." } },
      }),
    });
    render(
      provide(
        api,
        <ChannelMembersDialog
          channelId="ch-1"
          channelTitle="North Campus"
          open
          onClose={() => {}}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByRole("option", { name: "Nurse Two" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Not permitted");
  });
});
