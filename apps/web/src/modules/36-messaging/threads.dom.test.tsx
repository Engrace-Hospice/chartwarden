/**
 * WP 2.2 threads in the web client: the reply affordances on a row, the side panel (open, close, focus, keyboard,
 * in-thread send), jump-to-parent (on screen, and not loaded -> the anchored page), the archived and unavailable states,
 * and refresh on a realtime hint that names the thread.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
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
      view.rerender(tree({ liveHint: { seq, items: [{ seq, messageId, parentMessageId }] } }));
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
    const link = await screen.findAllByRole("button", { name: "Jump to message from Other Nurse" });
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Jump to the message this replies to" }),
    );
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

// ── review fixes ────────────────────────────────────────────────────────────────────────────────────────────────
const openRoot = async () =>
  fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
const sendReply = async (text: string) => {
  const box = (await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  });
  return box;
};

describe("WP 2.2 jump while a read is in flight (H1, M8, M9)", () => {
  const parent = message("old-parent", { createdAt: "2026-09-01T09:00:00.000Z", body: "ancient" });
  const reply = message("late-reply", {
    parentMessageId: "old-parent",
    createdAt: "2026-10-10T09:00:00.000Z",
  });
  function gatedWorld(extra: Partial<ComponentProps<typeof ConversationThread>> = {}) {
    const gate = { promise: null as Promise<void> | null, release: () => {} };
    const closeGate = () => {
      gate.promise = new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    };
    const handler: Handler = (path, init) => {
      if (path !== LIST) return undefined;
      const anchored = init.params.query.anchorMessageId === "old-parent";
      const data = { data: { messages: [anchored ? parent : reply] }, error: undefined };
      return gate.promise ? gate.promise.then(() => data) : data;
    };
    return { gate, closeGate, ...mount({ GET: handler }, {}, extra) };
  }
  const bump = (w: ReturnType<typeof gatedWorld>, liveToken: number) =>
    w.view.rerender(w.tree({ liveToken }));
  const jumpLink = () =>
    screen.findByRole("button", { name: "Jump to the message this replies to" });

  it("a jump asked for while a latest read is in flight shows the anchored page ALONE", async () => {
    const w = gatedWorld();
    const link = await jumpLink();
    w.closeGate();
    bump(w, 1); // a background read is now in flight
    fireEvent.click(link);
    await act(async () => w.gate.release());
    await screen.findByText("ancient");
    expect(screen.queryByText("body of late-reply")).toBeNull();
  });

  it("Back to latest asked for while an anchored read is in flight shows the latest page ALONE", async () => {
    const w = gatedWorld();
    fireEvent.click(await jumpLink());
    await screen.findByText("ancient");
    w.closeGate();
    bump(w, 1);
    fireEvent.click(screen.getByRole("button", { name: "Back to latest messages" }));
    await act(async () => w.gate.release());
    await screen.findByText("body of late-reply");
    expect(screen.queryByText("ancient")).toBeNull();
  });

  it("a changed route anchor ends the jump: Back to latest goes away and the new anchor is read", async () => {
    const w = gatedWorld();
    fireEvent.click(await jumpLink());
    await screen.findByText("ancient");
    w.view.rerender(w.tree({ anchorMessageId: "other-anchor" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Back to latest messages" })).toBeNull(),
    );
    expect(
      w.api.GET.mock.calls.some(
        ([p, i]) => p === LIST && i.params.query.anchorMessageId === "other-anchor",
      ),
    ).toBe(true);
  });

  it("an anchor that is gone says so, is not an access revocation, and leaves the timeline alone", async () => {
    const onAccessRevoked = vi.fn();
    mount(
      {
        GET: (path, init) =>
          path !== LIST
            ? undefined
            : init.params.query.anchorMessageId === "old-parent"
              ? {
                  data: undefined,
                  error: { error: { code: "NOT_FOUND" } },
                  response: { status: 404 },
                }
              : { data: { messages: [reply] }, error: undefined },
      },
      {},
      { onAccessRevoked },
    );
    fireEvent.click(await jumpLink());
    await screen.findByText("That message is no longer available.");
    expect(onAccessRevoked).not.toHaveBeenCalled();
    expect(screen.getByText("body of late-reply")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to latest messages" })).toBeNull();
  });
});

describe("WP 2.2 panel behaviour (H2, H3, M1-M7, M10, M11)", () => {
  it("never disables the reply box while sending (a disabled box drops focus), and Escape still works after", async () => {
    let finish = () => {};
    const sent = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const world = threadWorld();
    mount({
      ...world.handlers,
      POST: () =>
        sent.then(() => ({
          data: {
            messageId: "new-reply",
            channelId: "dm-1",
            createdAt: "2026-10-10T10:00:00.000Z",
          },
          error: undefined,
          response: { status: 201 },
        })),
    });
    await openRoot();
    const box = (await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement;
    box.focus();
    fireEvent.change(box, { target: { value: "on it" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    });
    expect(box.disabled).toBe(false);
    expect(box.readOnly).toBe(true);
    await act(async () => finish());
    await within(screen.getByRole("complementary", { name: "Thread" })).findByText("on it");
    expect(document.activeElement).toBe(box);
    expect(box.readOnly).toBe(false);
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(panel()).toBeNull());
  });

  it("a thread read that rejects shows a failure with Retry, not a spinner forever", async () => {
    const { handlers } = threadWorld();
    let first = true;
    mount({
      ...handlers,
      GET: (path, init) => {
        if (path === THREAD && first) {
          first = false;
          return Promise.reject(new Error("network down"));
        }
        return handlers.GET(path, init);
      },
    });
    await openRoot();
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    await within(dialog).findByText("Thread could not be loaded");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await within(dialog).findByText("body of reply-a");
  });

  it("a Load more that rejects clears its spinner and offers another try", async () => {
    const { handlers, root, replyA } = threadWorld();
    mount({
      ...handlers,
      GET: (path, init) => {
        if (path === THREAD) {
          return init.params.query.cursor
            ? Promise.reject(new Error("network down"))
            : {
                data: { root, replies: [replyA], nextCursor: "c1", patientId: null },
                error: undefined,
              };
        }
        return handlers.GET(path, init);
      },
    });
    await openRoot();
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Load more replies" }));
    await within(dialog).findByText(/Connection interrupted/);
    const again = within(dialog).getByRole("button", {
      name: "Load more replies",
    }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
  });

  it("announces a new reply from someone else in a polite live region", async () => {
    const { handlers, root, replyA, replyB } = threadWorld();
    let extra = false;
    const replyC = message("reply-c", {
      parentMessageId: "root-1",
      createdAt: "2026-10-10T09:09:00.000Z",
    });
    const { view, tree } = mount({
      ...handlers,
      GET: (path, init) =>
        path === THREAD && extra
          ? {
              data: { root, replies: [replyA, replyB, replyC], patientId: null },
              error: undefined,
            }
          : handlers.GET(path, init),
    });
    await openRoot();
    await screen.findByText("body of reply-a");
    extra = true;
    view.rerender(
      tree({
        liveHint: { seq: 1, items: [{ seq: 1, messageId: "reply-c", parentMessageId: "root-1" }] },
      }),
    );
    const note = await screen.findByText(/1 new reply/);
    expect(note.closest("[aria-live='polite']")).toBeTruthy();
  });

  it("Escape never closes while a draft is held, whichever element has focus", async () => {
    const { handlers } = threadWorld();
    mount(handlers);
    await openRoot();
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    fireEvent.change(await screen.findByLabelText("Reply in thread"), {
      target: { value: "draft" },
    });
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Close thread" }), {
      key: "Escape",
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(panel()).toBeTruthy();
  });

  it("keeps a draft per thread when switching threads and back", async () => {
    const { handlers } = threadWorld();
    mount(handlers);
    await openRoot();
    fireEvent.change(await screen.findByLabelText("Reply in thread"), {
      target: { value: "keep me" },
    });
    fireEvent.click(
      within(document.querySelector('[data-message-id="solo-1"]') as HTMLElement).getByRole(
        "button",
        { name: "Reply in thread to Other Nurse" },
      ),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Reply in thread") as HTMLTextAreaElement).value).toBe(""),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open thread, 2 replies" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Reply in thread") as HTMLTextAreaElement).value).toBe(
        "keep me",
      ),
    );
  });

  it("does not insert a non-contiguous reply when more replies are unloaded", async () => {
    const { handlers, root, replyA } = threadWorld();
    mount({
      ...handlers,
      GET: (path, init) =>
        path === THREAD
          ? {
              data: { root, replies: [replyA], nextCursor: "c1", patientId: null },
              error: undefined,
            }
          : handlers.GET(path, init),
    });
    await openRoot();
    await sendReply("hidden for now");
    const dialog = screen.getByRole("complementary", { name: "Thread" });
    await within(dialog).findByText(/Reply sent\. Load more replies to see it/);
    expect(within(dialog).queryByText("hidden for now")).toBeNull();
  });

  it("patches the timeline's reply count at once, and re-reads even when a read was in flight", async () => {
    let serverReplies = 2;
    let hold: Promise<void> | null = null;
    let release = () => {};
    const world = threadWorld({
      GET: (path) => {
        if (path !== LIST) return undefined;
        const data = {
          data: { messages: [message("root-1", { replyCount: serverReplies })] },
          error: undefined,
        };
        return hold ? hold.then(() => data) : data;
      },
    });
    const { api, view, tree } = mount({
      ...world.handlers,
      POST: (path) => {
        if (path === LIST) serverReplies += 1;
        return undefined;
      },
    });
    await openRoot();
    await screen.findByLabelText("Reply in thread");
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    view.rerender(tree({ liveToken: 1 })); // a latest read is now in flight
    const before = api.GET.mock.calls.filter(([p]) => p === LIST).length;
    await sendReply("one more");
    expect(await screen.findByRole("button", { name: "Open thread, 3 replies" })).toBeTruthy();
    await act(async () => release());
    await waitFor(() =>
      expect(api.GET.mock.calls.filter(([p]) => p === LIST).length).toBeGreaterThan(before),
    );
  });

  it("closes the slide-over when 'Show in conversation' is used on a narrow screen", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    try {
      const { handlers } = threadWorld();
      mount(handlers);
      await openRoot();
      fireEvent.click(await screen.findByRole("button", { name: "Show in conversation" }));
      await waitFor(() => expect(panel()).toBeNull());
    } finally {
      window.matchMedia = original;
    }
  });

  it("returns focus to another control for the same thread when the opener is gone", async () => {
    const { handlers } = threadWorld();
    mount(handlers);
    const open = await screen.findByRole("button", { name: "Open thread, 2 replies" });
    fireEvent.click(open);
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    open.remove();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(panel()).toBeNull());
    await waitFor(() => {
      const active = document.activeElement as HTMLElement;
      expect(active.getAttribute("data-thread-opener")).toBe("root-1");
      expect(active).not.toBe(open);
    });
  });

  it("moves focus to the first newly loaded reply when Load more unmounts", async () => {
    const { handlers, root, replyA, replyB } = threadWorld();
    mount({
      ...handlers,
      GET: (path, init) =>
        path === THREAD
          ? init.params.query.cursor
            ? { data: { root, replies: [replyB], patientId: null }, error: undefined }
            : {
                data: { root, replies: [replyA], nextCursor: "c1", patientId: null },
                error: undefined,
              }
          : handlers.GET(path, init),
    });
    await openRoot();
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    const more = await within(dialog).findByRole("button", { name: "Load more replies" });
    more.focus();
    fireEvent.click(more);
    await waitFor(() =>
      expect((document.activeElement as HTMLElement).getAttribute("data-message-id")).toBe(
        "reply-b",
      ),
    );
  });
});

// ── second review round ─────────────────────────────────────────────────────────────────────────────────────────
const narrowScreen = (initial: boolean) => {
  const original = window.matchMedia;
  const listeners = new Set<() => void>();
  let matches = initial;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
  return {
    set: (next: boolean) => {
      matches = next;
      for (const fn of listeners) fn();
    },
    restore: () => {
      window.matchMedia = original;
    },
  };
};

describe("WP 2.2 second review round", () => {
  const parent = message("old-parent", { createdAt: "2026-09-01T09:00:00.000Z", body: "ancient" });
  const reply = message("late-reply", {
    parentMessageId: "old-parent",
    createdAt: "2026-10-10T09:00:00.000Z",
  });
  const jumpLink = () =>
    screen.findByRole("button", { name: "Jump to the message this replies to" });
  const failure = (status: number) => ({
    data: undefined,
    error: { error: { code: status === 404 ? "NOT_FOUND" : "UNAVAILABLE" } },
    response: { status },
  });

  /** Latest page = [reply]; the page anchored at old-parent = [parent]; `anchoredAnswer` can be switched to an error. */
  function anchoredWorld(props: Partial<ComponentProps<typeof ConversationThread>> = {}) {
    const state = { anchored: null as unknown, latest: null as unknown };
    const handler: Handler = (path, init) => {
      if (path !== LIST) return undefined;
      if (init.params.query.anchorMessageId === "old-parent") {
        return state.anchored ?? { data: { messages: [parent] }, error: undefined };
      }
      return state.latest ?? { data: { messages: [reply] }, error: undefined };
    };
    return { state, ...mount({ GET: handler }, {}, props) };
  }

  it("a 503 on a poll while browsing history keeps the page and Back to latest", async () => {
    const w = anchoredWorld();
    fireEvent.click(await jumpLink());
    await screen.findByText("ancient");
    w.state.anchored = failure(503);
    w.view.rerender(w.tree({ liveToken: 1 }));
    await screen.findByText(/Connection interrupted/);
    expect(screen.getByText("ancient")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to latest messages" })).toBeTruthy();
    expect(screen.queryByText("That message is no longer available.")).toBeNull();
  });

  it("a 404 on a later anchored read shows the notice and REPLACES the stale page with the latest", async () => {
    const w = anchoredWorld();
    fireEvent.click(await jumpLink());
    await screen.findByText("ancient");
    w.state.anchored = failure(404);
    w.view.rerender(w.tree({ liveToken: 1 }));
    await screen.findByText("That message is no longer available.");
    await screen.findByText("body of late-reply");
    expect(screen.queryByText("ancient")).toBeNull();
  });

  it("'Show in conversation' on a narrow screen lands focus on a LOADED parent even though the timeline was inert", async () => {
    const media = narrowScreen(true);
    const originalFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focus(this: HTMLElement, ...args) {
      if (this.closest("[inert]")) return; // a browser will not focus inside an inert subtree
      originalFocus.apply(this, args);
    };
    try {
      const { handlers } = threadWorld();
      mount(handlers);
      await openRoot();
      await waitFor(() =>
        expect(document.querySelector(".wx-message-timeline")?.hasAttribute("inert")).toBe(true),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Show in conversation" }));
      await waitFor(() => expect(panel()).toBeNull());
      const row = document.querySelector('.wx-message-timeline [data-message-id="root-1"]');
      await waitFor(() => expect(document.activeElement).toBe(row));
    } finally {
      HTMLElement.prototype.focus = originalFocus;
      media.restore();
    }
  });

  it("re-evaluates inert when the screen is resized or rotated", async () => {
    const media = narrowScreen(false);
    try {
      const { handlers } = threadWorld();
      mount(handlers);
      await openRoot();
      const timeline = document.querySelector(".wx-message-timeline") as HTMLElement;
      expect(timeline.hasAttribute("inert")).toBe(false);
      act(() => media.set(true));
      expect(timeline.hasAttribute("inert")).toBe(true);
      act(() => media.set(false));
      expect(timeline.hasAttribute("inert")).toBe(false);
    } finally {
      media.restore();
    }
  });

  it("a reply that succeeds after the panel was closed is still recorded: draft gone, count patched", async () => {
    let serverReplies = 2;
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const world = threadWorld({
      GET: (path) =>
        path === LIST
          ? {
              data: { messages: [message("root-1", { replyCount: serverReplies })] },
              error: undefined,
            }
          : undefined,
    });
    mount({
      ...world.handlers,
      POST: (path) =>
        path !== LIST
          ? undefined
          : gate.then(() => {
              serverReplies += 1;
              return {
                data: {
                  messageId: "late-1",
                  channelId: "dm-1",
                  createdAt: "2026-10-10T10:00:00.000Z",
                },
                error: undefined,
                response: { status: 201 },
              };
            }),
    });
    await openRoot();
    const box = (await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "dup me" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(panel()).toBeNull());
    await act(async () => finish());
    expect(await screen.findByRole("button", { name: "Open thread, 3 replies" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open thread, 3 replies" }));
    expect(((await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("an older page that answers after a jump replaced the list is dropped", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const older = message("older-1", {
      body: "from the older page",
      createdAt: "2026-08-01T09:00:00.000Z",
    });
    mount({
      GET: (path, init) => {
        if (path !== LIST) return undefined;
        if (init.params.query.cursor === "older") {
          return gate.then(() => ({ data: { messages: [older] }, error: undefined }));
        }
        return init.params.query.anchorMessageId === "old-parent"
          ? { data: { messages: [parent] }, error: undefined }
          : { data: { messages: [reply], nextCursor: "older" }, error: undefined };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Load older messages" }));
    fireEvent.click(await jumpLink());
    await screen.findByText("ancient");
    await act(async () => release());
    await act(async () => {});
    expect(screen.queryByText("from the older page")).toBeNull();
  });

  it("an open thread is re-read on a timer, and several hints in one batch are not collapsed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { handlers } = threadWorld();
      const { api, view, tree } = mount(handlers);
      await openRoot();
      await screen.findByText("body of reply-a");
      expect(threadCalls(api)).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_500);
      });
      expect(threadCalls(api).length).toBeGreaterThanOrEqual(2);
      const before = threadCalls(api).length;
      // two hints delivered in ONE state update: the first concerns this thread, the last does not
      view.rerender(
        tree({
          liveHint: {
            seq: 2,
            items: [
              { seq: 1, messageId: "reply-x", parentMessageId: "root-1" },
              { seq: 2, messageId: "elsewhere", parentMessageId: "another-root" },
            ],
          },
        }),
      );
      await waitFor(() => expect(threadCalls(api).length).toBeGreaterThan(before));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not announce replies fetched by Load more, and announces each new batch as a fresh node", async () => {
    const { handlers, root, replyA, replyB } = threadWorld();
    let phase: "first" | "second" | "third" = "first";
    const c = message("reply-c", {
      parentMessageId: "root-1",
      createdAt: "2026-10-10T09:08:00.000Z",
    });
    const d = message("reply-d", {
      parentMessageId: "root-1",
      createdAt: "2026-10-10T09:09:00.000Z",
    });
    const { view, tree } = mount({
      ...handlers,
      GET: (path, init) => {
        if (path !== THREAD) return handlers.GET(path, init);
        if (init.params.query.cursor) {
          return { data: { root, replies: [replyB], patientId: null }, error: undefined };
        }
        if (phase === "first") {
          return {
            data: { root, replies: [replyA], nextCursor: "c1", patientId: null },
            error: undefined,
          };
        }
        return {
          data: {
            root,
            replies: phase === "second" ? [replyA, replyB, c] : [replyA, replyB, c, d],
            patientId: null,
          },
          error: undefined,
        };
      },
    });
    await openRoot();
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Load more replies" }));
    await within(dialog).findByText("body of reply-b");
    expect(within(dialog).queryByText(/new repl/)).toBeNull();
    phase = "second";
    view.rerender(
      tree({
        liveHint: { seq: 1, items: [{ seq: 1, messageId: "reply-c", parentMessageId: "root-1" }] },
      }),
    );
    const first = await within(dialog).findByText("1 new reply");
    phase = "third";
    view.rerender(
      tree({
        liveHint: { seq: 2, items: [{ seq: 2, messageId: "reply-d", parentMessageId: "root-1" }] },
      }),
    );
    await waitFor(() => {
      const again = within(dialog).getByText("1 new reply");
      expect(again).not.toBe(first); // a new node, so a screen reader announces the repeat
    });
  });

  it("'Retry now' reads in the background: a failing retry never replaces the working thread", async () => {
    const { handlers, root, replyA } = threadWorld();
    let mode: "ok" | "reject" = "ok";
    const { view, tree } = mount({
      ...handlers,
      GET: (path, init) =>
        path === THREAD
          ? mode === "reject"
            ? Promise.reject(new Error("down"))
            : { data: { root, replies: [replyA], patientId: null }, error: undefined }
          : handlers.GET(path, init),
    });
    await openRoot();
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    await within(dialog).findByText("body of reply-a");
    mode = "reject";
    view.rerender(
      tree({ liveHint: { seq: 1, items: [{ seq: 1, messageId: null, parentMessageId: null }] } }),
    );
    fireEvent.click(await within(dialog).findByRole("button", { name: "Retry now" }));
    await act(async () => {});
    expect(within(dialog).getByText("body of reply-a")).toBeTruthy();
    expect(within(dialog).queryByText("Thread could not be loaded")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Retry now" })).toBeTruthy();
  });

  it("Back to latest survives a re-render with new callback identities", async () => {
    const w = anchoredWorld({ anchorMessageId: "route-a" });
    fireEvent.click(await jumpLink());
    await screen.findByText("ancient");
    fireEvent.click(screen.getByRole("button", { name: "Back to latest messages" }));
    await screen.findByText("body of late-reply");
    w.view.rerender(
      w.tree({ anchorMessageId: "route-a", onAccessRevoked: () => {}, liveToken: 1 }),
    );
    await waitFor(() => {
      const reads = w.api.GET.mock.calls.filter(([p]) => p === LIST);
      expect(reads.at(-1)?.[1].params.query.anchorMessageId).toBeUndefined();
    });
  });
});

// ── final round ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("WP 2.2 final round: in-flight sends, polling safeguards", () => {
  /** A world whose reply POST waits on a gate; `posts()` counts the reply POSTs. */
  function slowSendWorld() {
    let serverReplies = 2;
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const hold = { reads: null as Promise<void> | null };
    const world = threadWorld({
      GET: (path) => {
        if (path !== LIST) return undefined;
        const data = {
          data: { messages: [message("root-1", { replyCount: serverReplies })] },
          error: undefined,
        };
        return hold.reads ? hold.reads.then(() => data) : data;
      },
    });
    const m = mount({
      ...world.handlers,
      POST: (path) =>
        path !== LIST
          ? undefined
          : gate.then(() => {
              serverReplies += 1;
              return {
                data: {
                  messageId: "late-1",
                  channelId: "dm-1",
                  createdAt: "2026-10-10T10:00:00.000Z",
                },
                error: undefined,
                response: { status: 201 },
              };
            }),
    });
    const posts = () => m.api.POST.mock.calls.filter(([p]) => p === LIST).length;
    return { ...m, finish: () => act(async () => finish()), hold, posts };
  }
  const startSend = async (text: string) => {
    const box = (await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: text } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    });
  };
  const closeThread = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(panel()).toBeNull());
  };

  it("a reopened thread holds Send while the earlier reply is still in flight (no duplicate POST, empty box)", async () => {
    const w = slowSendWorld();
    await openRoot();
    await startSend("send me once");
    await closeThread();
    fireEvent.click(screen.getByRole("button", { name: "Open thread, 2 replies" }));
    const box = (await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement;
    expect(box.value).toBe("");
    fireEvent.change(box, { target: { value: "send me once" } });
    expect((screen.getByRole("button", { name: "Send reply" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.keyDown(box, { key: "Enter" });
    await act(async () => {});
    expect(w.posts()).toBe(1);
    expect(screen.getByText("Your previous reply is still being sent.")).toBeTruthy();
    await w.finish();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Send reply" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("a late success never erases a draft typed after the thread was reopened", async () => {
    const w = slowSendWorld();
    await openRoot();
    await startSend("first");
    await closeThread();
    fireEvent.click(screen.getByRole("button", { name: "Open thread, 2 replies" }));
    const box = (await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "second thought" } });
    await w.finish();
    await act(async () => {});
    expect(box.value).toBe("second thought");
    await closeThread();
    fireEvent.click(await screen.findByRole("button", { name: /Open thread, \d+ replies/ }));
    expect(((await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement).value).toBe(
      "second thought",
    );
  });

  it("a failed send puts the text back into the draft", async () => {
    const world = threadWorld();
    mount({
      ...world.handlers,
      POST: (path) =>
        path === LIST
          ? { data: undefined, error: { error: { message: "boom" } }, response: { status: 500 } }
          : undefined,
    });
    await openRoot();
    await startSend("try again");
    await screen.findByRole("alert");
    await closeThread();
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
    expect(((await screen.findByLabelText("Reply in thread")) as HTMLTextAreaElement).value).toBe(
      "try again",
    );
  });

  it("the timeline count comes from the local patch while the follow-up read has not answered", async () => {
    const w = slowSendWorld();
    await openRoot();
    await startSend("patch me");
    await closeThread();
    w.hold.reads = new Promise<void>(() => {}); // the follow-up read never answers
    await w.finish();
    expect(await screen.findByRole("button", { name: "Open thread, 3 replies" })).toBeTruthy();
  });

  describe("polling", () => {
    const tick = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    it("stops polling a thread that is unavailable, and a hint does not bring it back", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const world = threadWorld();
        let readable = false;
        const { api, view, tree } = mount({
          ...world.handlers,
          GET: (path, init) =>
            path !== THREAD || readable
              ? world.handlers.GET(path, init)
              : {
                  data: undefined,
                  error: { error: { code: "NOT_FOUND" } },
                  response: { status: 404 },
                },
        });
        await openRoot();
        await screen.findByText("Thread unavailable");
        const calls = threadCalls(api).length;
        readable = true;
        await tick(10 * 60_000);
        view.rerender(
          tree({
            liveHint: { seq: 1, items: [{ seq: 1, messageId: null, parentMessageId: null }] },
          }),
        );
        await tick(1_000);
        expect(threadCalls(api)).toHaveLength(calls);
        expect(screen.getByText("Thread unavailable")).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("backs off after failures, and re-reads when the window regains focus", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { handlers, root, replyA } = threadWorld();
        let down = false;
        const { api } = mount({
          ...handlers,
          GET: (path, init) =>
            path === THREAD
              ? down
                ? Promise.reject(new Error("down"))
                : { data: { root, replies: [replyA], patientId: null }, error: undefined }
              : handlers.GET(path, init),
        });
        await openRoot();
        await screen.findByText("body of reply-a");
        expect(threadCalls(api)).toHaveLength(1);
        down = true;
        await tick(61_000); // first poll fails
        expect(threadCalls(api)).toHaveLength(2);
        await tick(61_000); // backed off to 120 s: not yet
        expect(threadCalls(api)).toHaveLength(2);
        await tick(61_000);
        expect(threadCalls(api)).toHaveLength(3);
        down = false;
        act(() => {
          window.dispatchEvent(new Event("focus"));
        });
        await waitFor(() => expect(threadCalls(api)).toHaveLength(4));
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not restart the countdown when the socket connects", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { handlers } = threadWorld();
        const { api, view, tree } = mount(handlers);
        await openRoot();
        await screen.findByText("body of reply-a");
        await tick(50_000);
        view.rerender(tree({ realtimeConnected: true }));
        await tick(15_000); // 65 s since open: the poll scheduled at 60 s still fires
        expect(threadCalls(api)).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("a Retry click is not swallowed by a background read already in flight", async () => {
    const { handlers, root, replyA } = threadWorld();
    let phase: "fail" | "slow" | "ok" = "fail";
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { view, tree } = mount({
      ...handlers,
      GET: (path, init) => {
        if (path !== THREAD) return handlers.GET(path, init);
        if (phase === "fail") return Promise.reject(new Error("down"));
        const data = { data: { root, replies: [replyA], patientId: null }, error: undefined };
        return phase === "slow" ? gate.then(() => data) : data;
      },
    });
    await openRoot();
    const dialog = await screen.findByRole("complementary", { name: "Thread" });
    await within(dialog).findByText("Thread could not be loaded");
    phase = "slow";
    view.rerender(
      tree({ liveHint: { seq: 1, items: [{ seq: 1, messageId: null, parentMessageId: null }] } }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await within(dialog).findByLabelText("Loading thread");
    await act(async () => release());
    await within(dialog).findByText("body of reply-a");
  });

  it("falls back to addListener when the media query has no addEventListener", async () => {
    const original = window.matchMedia;
    const listeners = new Set<() => void>();
    window.matchMedia = (() => ({
      matches: true,
      addListener: (fn: () => void) => listeners.add(fn),
      removeListener: (fn: () => void) => listeners.delete(fn),
    })) as unknown as typeof window.matchMedia;
    try {
      const { handlers } = threadWorld();
      mount(handlers);
      await openRoot();
      await screen.findByText("body of reply-a");
      expect(document.querySelector(".wx-message-timeline")?.hasAttribute("inert")).toBe(true);
      expect(listeners.size).toBe(1);
    } finally {
      window.matchMedia = original;
    }
  });

  it("scrolls to the end and clears the new-message count when a gone anchor falls back to the latest page", async () => {
    const parent = message("old-parent", {
      createdAt: "2026-09-01T09:00:00.000Z",
      body: "ancient",
    });
    const reply = message("late-reply", {
      parentMessageId: "old-parent",
      createdAt: "2026-10-10T09:00:00.000Z",
    });
    let gone = false;
    const { view, tree } = mount({
      GET: (path, init) =>
        path !== LIST
          ? undefined
          : init.params.query.anchorMessageId === "old-parent"
            ? gone
              ? {
                  data: undefined,
                  error: { error: { code: "NOT_FOUND" } },
                  response: { status: 404 },
                }
              : { data: { messages: [parent] }, error: undefined }
            : { data: { messages: [reply] }, error: undefined },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Jump to the message this replies to" }),
    );
    await screen.findByText("ancient");
    const timeline = document.querySelector(".wx-message-timeline") as HTMLElement;
    Object.defineProperty(timeline, "scrollHeight", { configurable: true, value: 777 });
    timeline.scrollTop = 5;
    gone = true;
    view.rerender(tree({ liveToken: 1 }));
    await screen.findByText("That message is no longer available.");
    await waitFor(() => expect(timeline.scrollTop).toBe(777));
  });
});

describe("WP 5.6 the thread's Legal hold chip", () => {
  const openThread = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 2 replies" }));
    return screen.findByRole("complementary", { name: "Thread" });
  };

  it("shows a 'Legal hold' chip in the thread header when any message of the thread carries the server's flag", async () => {
    const world = threadWorld();
    const held = { ...world.replyA, legalHold: true };
    mount({
      GET: (path: string, init: Record<string, any>) =>
        path === THREAD
          ? {
              data: { root: world.root, replies: [held, world.replyB], patientId: null },
              error: undefined,
              response: { status: 200 },
            }
          : world.handlers.GET(path, init),
    });
    const dialog = await openThread();
    await within(dialog).findByText(/At least one message in this thread is held/);
    // The held reply carries its own chip as well.
    expect(within(dialog).getAllByText("Legal hold").length).toBeGreaterThanOrEqual(2);
  });

  it("shows nothing when no message carries the flag (an ordinary reader never learns of a hold)", async () => {
    const { handlers } = threadWorld();
    mount(handlers);
    const dialog = await openThread();
    await within(dialog).findByText("body of reply-a");
    expect(within(dialog).queryByText("Legal hold")).toBeNull();
    expect(dialog.querySelector(".wx-legal-hold-chip")).toBeNull();
  });
});
