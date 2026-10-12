/**
 * WP 2.2 threads in the web client: the reply affordances on a row, the side panel (open, close, focus, keyboard,
 * in-thread send), jump-to-parent (on screen, and not loaded -> the anchored page), the archived and unavailable states,
 * and refresh on a realtime hint that names the thread.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";
import type { ChannelSummary } from "./messaging-types";

const ME = "11111111-1111-4111-8111-111111111111";
const LIST = "/api/v1/messaging/channels/{id}/messages";
const THREAD = "/api/v1/messaging/channels/{id}/messages/{messageId}/thread";

const channel = (over: Partial<ChannelSummary> = {}): ChannelSummary => ({
  channelId: "dm-1",
  kind: "dm",
  title: "Nurse Two",
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  mentionCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
  ...over,
});

const message = (id: string, over: Record<string, unknown> = {}) => ({
  messageId: id,
  channelId: "dm-1",
  authorUserId: "other-user",
  authorDisplayName: "Other Nurse",
  body: `body of ${id}`,
  bodyKind: "plain",
  createdAt: "2026-10-10T09:00:00.000Z",
  parentMessageId: null,
  replyCount: 0,
  lastReplyAt: null,
  references: [],
  attachments: [],
  ...over,
});

type Handler = (path: string, init: Record<string, any>) => unknown;

function mount(
  handlers: { GET?: Handler; POST?: Handler } = {},
  channelOver: Partial<ChannelSummary> = {},
  props: Partial<ComponentProps<typeof ConversationThread>> = {},
) {
  const api = {
    GET: vi.fn((path: string, init: Record<string, any>) =>
      Promise.resolve(handlers.GET?.(path, init) ?? { data: { messages: [] }, error: undefined }),
    ),
    POST: vi.fn((path: string, init: Record<string, any>) =>
      Promise.resolve(
        handlers.POST?.(path, init) ?? {
          data: {
            messageId: "new-reply",
            channelId: "dm-1",
            createdAt: "2026-10-10T10:00:00.000Z",
          },
          error: undefined,
          response: { status: 201 },
        },
      ),
    ),
  };
  const tree = (extra: Partial<ComponentProps<typeof ConversationThread>> = {}) => (
    <MemoryRouter>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <ConversationThread
          channel={channel(channelOver)}
          meId={ME}
          meDisplayName="Me"
          onBack={() => {}}
          onReadConfirmed={() => {}}
          onMessageSent={() => {}}
          onAccessRevoked={() => {}}
          {...extra}
        />
      </ApiClientProvider>
    </MemoryRouter>
  );
  const view = render(tree(props));
  return { api, view, tree };
}

const threadCalls = (api: { GET: ReturnType<typeof vi.fn> }) =>
  api.GET.mock.calls.filter(([p]) => p === THREAD) as Array<[string, Record<string, any>]>;
const panel = () => screen.queryByRole("complementary", { name: "Thread" });

/** A channel timeline with a root that has two replies, and the thread read for that root. */
function threadWorld(extra: { GET?: Handler; POST?: Handler } = {}) {
  const root = message("root-1", { replyCount: 2, lastReplyAt: "2026-10-10T09:05:00.000Z" });
  const replyA = message("reply-a", {
    parentMessageId: "root-1",
    authorDisplayName: "Reply Author",
    createdAt: "2026-10-10T09:01:00.000Z",
  });
  const replyB = message("reply-b", {
    parentMessageId: "root-1",
    authorUserId: ME,
    authorDisplayName: "Me",
    createdAt: "2026-10-10T09:05:00.000Z",
  });
  const solo = message("solo-1", { createdAt: "2026-10-10T08:00:00.000Z" });
  return {
    root,
    replyA,
    replyB,
    handlers: {
      GET: (path: string, init: Record<string, any>) => {
        const custom = extra.GET?.(path, init);
        if (custom !== undefined) return custom;
        if (path === LIST) {
          return { data: { messages: [solo, root, replyA, replyB] }, error: undefined };
        }
        if (path === THREAD) {
          return {
            data: { root, replies: [replyA, replyB], patientId: null },
            error: undefined,
            response: { status: 200 },
          };
        }
        return undefined;
      },
      POST: extra.POST,
    },
  };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("WP 2.2 reply affordances and the thread panel", () => {
  it("shows a reply count on the root, opens the panel from it, and reads the thread of that message", async () => {
    const { handlers } = threadWorld();
    const { api } = mount(handlers);
    const open = await screen.findByRole("button", { name: "Open thread, 2 replies" });
    expect(panel()).toBeNull();
    fireEvent.click(open);
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    await within(dialog).findByText("body of reply-a");
    expect(within(dialog).getByText("body of root-1")).toBeTruthy();
    expect(within(dialog).getAllByText("2 replies").length).toBeGreaterThan(0);
    expect(threadCalls(api)[0]![1].params.path).toEqual({ id: "dm-1", messageId: "root-1" });
  });

  it("puts focus in the panel on open", async () => {
    const { handlers } = threadWorld();
    mount(handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    expect(document.activeElement).toBe(dialog);
  });

  it("offers Reply on a message with no replies, and a reply row opens its PARENT's thread", async () => {
    const { handlers } = threadWorld();
    const { api } = mount(handlers);
    await screen.findByText("body of solo-1");
    fireEvent.click(screen.getByRole("button", { name: "Reply in thread to Reply Author" }));
    await screen.findByRole("complementary", { name: "Thread" });
    expect(threadCalls(api)[0]![1].params.path.messageId).toBe("root-1");
  });

  it("opens an empty thread for a message nobody has replied to", async () => {
    const solo = message("solo-1");
    const { api } = mount({
      GET: (path) =>
        path === LIST
          ? { data: { messages: [solo] }, error: undefined }
          : { data: { root: solo, replies: [], patientId: null }, error: undefined },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reply in thread to Other Nurse" }));
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    expect((await within(dialog).findAllByText("No replies yet")).length).toBeGreaterThan(0);
    expect(threadCalls(api)).toHaveLength(1);
  });

  it("closes on Escape and gives focus back to the control that opened it", async () => {
    const { handlers } = threadWorld();
    mount(handlers);
    const open = await screen.findByRole("button", { name: "Open thread, 2 replies" });
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(panel()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("closes from the Close button too", async () => {
    const { handlers } = threadWorld();
    mount(handlers);
    const open = await screen.findByRole("button", { name: "Open thread, 2 replies" });
    fireEvent.click(open);
    fireEvent.click(await screen.findByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(panel()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("Escape in the reply box closes only when it is empty: a draft is never lost to a stray key", async () => {
    const { handlers } = threadWorld();
    mount(handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
    const box = (await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "half a thought" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(panel()).toBeTruthy();
    expect(box.value).toBe("half a thought");
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(panel()).toBeNull());
  });

  it("sends a reply with the root as parentMessageId, shows it in the panel, and refreshes the channel", async () => {
    const onMessageSent = vi.fn();
    const { handlers } = threadWorld();
    const { api } = mount(handlers, {}, { onMessageSent });
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
    const box = (await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "on it" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    });
    const sent = api.POST.mock.calls.find(([p]) => p === LIST) as [string, Record<string, any>];
    expect(sent[1].body.parentMessageId).toBe("root-1");
    expect(sent[1].body.body).toBe("on it");
    expect(sent[1].params.header["Idempotency-Key"]).toBeTruthy();
    const dialog = screen.getByRole("complementary", { name: "Thread" });
    await within(dialog).findByText("on it");
    expect(box.value).toBe("");
    expect(within(dialog).getAllByText("3 replies").length).toBeGreaterThan(0);
    expect(onMessageSent).toHaveBeenCalled();
  });

  it("Enter sends from the reply box; Shift+Enter does not", async () => {
    const { handlers } = threadWorld();
    const { api } = mount(handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
    const box = (await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "line" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(api.POST.mock.calls.filter(([p]) => p === LIST)).toHaveLength(0);
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(api.POST.mock.calls.filter(([p]) => p === LIST)).toHaveLength(1);
  });

  it("is read only in an archived channel: no Reply buttons, no reply box, but an existing thread opens", async () => {
    const { handlers } = threadWorld();
    mount(handlers, { archivedAt: "2026-10-01T00:00:00.000Z" });
    await screen.findByText("body of solo-1");
    expect(screen.queryByRole("button", { name: /^Reply in thread/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    expect(within(dialog).queryByLabelText("Reply in thread")).toBeNull();
    expect(within(dialog).getByText(/Replies are read only/)).toBeTruthy();
  });

  it("an unreadable thread is 'unavailable', with no reply box (the answer for a thread that never existed)", async () => {
    const { handlers } = threadWorld({
      GET: (path) =>
        path === THREAD
          ? { data: undefined, error: { error: { code: "NOT_FOUND" } }, response: { status: 404 } }
          : undefined,
    });
    mount(handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    await within(dialog).findByText("Thread unavailable");
    expect(within(dialog).queryByLabelText("Reply in thread")).toBeNull();
  });

  it("a tombstone offers no Reply, but its replies stay reachable", async () => {
    const gone = message("gone-1", { body: "", replyCount: 1 });
    mount({
      GET: (path) => (path === LIST ? { data: { messages: [gone] }, error: undefined } : undefined),
    });
    await screen.findByText("Message deleted");
    expect(screen.queryByRole("button", { name: /^Reply in thread/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Open thread, 1 reply" })).toBeTruthy();
  });

  it("re-reads when a hint names this thread (its replies or its root), a reconnect, and ignores other threads", async () => {
    const { handlers } = threadWorld();
    const { api, view, tree } = mount(handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
    await screen.findByText("body of reply-a", { selector: "span, p, div" });
    await waitFor(() => expect(threadCalls(api)).toHaveLength(1));
    const hint = (seq: number, messageId: string | null, parentMessageId: string | null) =>
      view.rerender(tree({ liveHint: { seq, messageId, parentMessageId } }));
    hint(1, "elsewhere", "another-root");
    await act(async () => {});
    expect(threadCalls(api)).toHaveLength(1);
    hint(2, "reply-c", "root-1");
    await waitFor(() => expect(threadCalls(api)).toHaveLength(2));
    hint(3, "root-1", null);
    await waitFor(() => expect(threadCalls(api)).toHaveLength(3));
    hint(4, null, null);
    await waitFor(() => expect(threadCalls(api)).toHaveLength(4));
  });
});

describe("WP 2.2 jump to parent", () => {
  it("focuses and scrolls to the parent when it is on screen, without another read", async () => {
    const { handlers } = threadWorld();
    const { api } = mount(handlers);
    const link = await screen.findAllByRole("button", { name: "Replying to Other Nurse" });
    const listReads = api.GET.mock.calls.filter(([p]) => p === LIST).length;
    fireEvent.click(link[0]!);
    const parentRow = document.querySelector('[data-message-id="root-1"]') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(parentRow));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(parentRow.getAttribute("data-highlighted")).toBe("true");
    expect(api.GET.mock.calls.filter(([p]) => p === LIST)).toHaveLength(listReads);
  });

  it("loads the anchored page when the parent is not loaded, then focuses it and offers Back to latest", async () => {
    const parent = message("old-parent", {
      createdAt: "2026-09-01T09:00:00.000Z",
      body: "ancient",
    });
    const reply = message("late-reply", {
      parentMessageId: "old-parent",
      createdAt: "2026-10-10T09:00:00.000Z",
    });
    const { api } = mount({
      GET: (path, init) => {
        if (path !== LIST) return undefined;
        return init.params.query.anchorMessageId === "old-parent"
          ? { data: { messages: [parent], nextCursor: undefined }, error: undefined }
          : { data: { messages: [reply] }, error: undefined };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Replying to an earlier message" }));
    await screen.findByText("ancient");
    const anchored = api.GET.mock.calls.find(
      ([p, init]) => p === LIST && init.params.query.anchorMessageId === "old-parent",
    );
    expect(anchored).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[data-message-id="old-parent"]')),
    );
    // one contiguous page: the newest page's reply is no longer mixed in with the history page
    expect(screen.queryByText("body of late-reply")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to latest messages" }));
    await screen.findByText("body of late-reply");
    expect(screen.queryByRole("button", { name: "Back to latest messages" })).toBeNull();
  });

  it("'Show in conversation' in the panel jumps to the root", async () => {
    const { handlers } = threadWorld();
    mount(handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show in conversation" }));
    const row = document.querySelector('[data-message-id="root-1"]') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(row));
  });
});
