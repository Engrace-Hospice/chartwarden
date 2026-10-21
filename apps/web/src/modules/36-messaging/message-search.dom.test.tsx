/**
 * WP 2.7a in the web client: Ctrl/Cmd+F opens in-conversation search, results jump to the message, keyboard access,
 * loading / empty / error-with-retry states, a capped scan that can be continued, and no search in an archived
 * conversation.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";
import { MessageSearch } from "./message-search";
import type { ChannelSummary } from "./messaging-types";

const ME = "11111111-1111-4111-8111-111111111111";
const LIST = "/api/v1/messaging/channels/{id}/messages";
const SEARCH = "/api/v1/messaging/channels/{id}/search";

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

const message = (id: string, body: string, over: Record<string, unknown> = {}) => ({
  messageId: id,
  channelId: "dm-1",
  authorUserId: "22222222-2222-4222-8222-222222222222",
  authorDisplayName: "Other Nurse",
  body,
  bodyKind: "plain",
  createdAt: "2026-10-10T09:00:00.000Z",
  parentMessageId: null,
  replyCount: 0,
  lastReplyAt: null,
  references: [],
  attachments: [],
  reactions: [],
  pinned: false,
  ...over,
});

type SearchReply = { data?: unknown; error?: unknown; response: { status: number } };
const ok = (data: unknown): SearchReply => ({ data, error: undefined, response: { status: 200 } });
const failed = (status = 500): SearchReply => ({
  data: undefined,
  error: { error: { code: "INTERNAL" } },
  response: { status },
});
const page = (results: unknown[], over: Record<string, unknown> = {}) =>
  ok({ results, scanned: results.length, scanCapped: false, patientId: null, ...over });

function mount(
  search: (init: Record<string, any>) => SearchReply,
  over: Partial<ChannelSummary> = {},
) {
  const api = {
    GET: vi.fn((path: string, init: Record<string, any>) =>
      Promise.resolve(
        path === LIST
          ? ok({ messages: [message("m1", "hello there")] })
          : path === SEARCH
            ? search(init)
            : ok({ pins: [], patientId: null }),
      ),
    ),
    POST: vi.fn(() => Promise.resolve(ok({}))),
    PUT: vi.fn(() => Promise.resolve(ok({}))),
    DELETE: vi.fn(() => Promise.resolve(ok({}))),
  };
  render(
    <MemoryRouter>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <ConversationThread
          channel={channel(over)}
          meId={ME}
          meDisplayName="Me"
          onBack={() => {}}
          onReadConfirmed={() => {}}
          onMessageSent={() => {}}
          onAccessRevoked={() => {}}
        />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return api;
}

const searchCalls = (api: ReturnType<typeof mount>) =>
  api.GET.mock.calls.filter(([path]) => path === SEARCH);
const openWithShortcut = async (
  init: { ctrlKey?: boolean; metaKey?: boolean } = { ctrlKey: true },
) => {
  await screen.findByText("hello there");
  fireEvent.keyDown(document, { key: "f", ...init });
  return screen.findByRole("searchbox", { name: "Search this conversation" });
};
const type = async (box: HTMLElement, value: string) => {
  fireEvent.change(box, { target: { value } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("WP 2.7a in-conversation search", () => {
  it("opens with Ctrl+F and with Cmd+F, prevents the browser's own find, and Escape closes it", async () => {
    mount(() => page([]));
    await screen.findByText("hello there");
    const prevented = !fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    expect(prevented).toBe(true);
    const box = await screen.findByRole("searchbox", { name: "Search this conversation" });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    expect(await screen.findByRole("searchbox")).toBeTruthy();
  });

  it("does not search for a single character, then lists results and jumps to the chosen message", async () => {
    const api = mount(() =>
      page([message("m9", "the morphine dose changed", { authorDisplayName: "Pat RN" })]),
    );
    const box = await openWithShortcut();
    await type(box, "m");
    expect(searchCalls(api)).toHaveLength(0);
    expect(screen.getByText(/at least 2 characters/i)).toBeTruthy();
    await type(box, "morphine");
    const list = await screen.findByRole("list", { name: "Search results" });
    const hit = within(list).getByRole("button", { name: /Pat RN/ });
    expect(within(hit).getByText("morphine").tagName).toBe("MARK");
    expect(searchCalls(api)[0]![1].params.query).toMatchObject({ q: "morphine" });
    fireEvent.click(hit);
    // the jump reads the anchored page for a message that is not on screen
    await waitFor(() =>
      expect(
        api.GET.mock.calls.some(
          ([path, init]) => path === LIST && init?.params?.query?.anchorMessageId === "m9",
        ),
      ).toBe(true),
    );
  });

  it("moves through results with the arrow keys and activates with Enter", async () => {
    mount(() => page([message("a1", "alpha note"), message("a2", "alpha again")]));
    const box = await openWithShortcut();
    await type(box, "alpha");
    const list = await screen.findByRole("list", { name: "Search results" });
    const buttons = within(list).getAllByRole("button");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1]!, { key: "ArrowUp" });
    fireEvent.keyDown(buttons[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(box);
  });

  it("shows a loading state, an empty state, and an error with a working Retry", async () => {
    let calls = 0;
    mount(() => {
      calls += 1;
      if (calls === 1) return failed();
      return page([]);
    });
    const box = await openWithShortcut();
    await type(box, "zebra");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be searched/i);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No messages match/i)).toBeTruthy();
  });

  it("offers to keep searching older history when the scan cap ended the request", async () => {
    const cursors: Array<string | undefined> = [];
    mount((init) => {
      cursors.push(init.params.query.cursor);
      return init.params.query.cursor
        ? page([message("old1", "tiger old")])
        : page([], { scanned: 5000, scanCapped: true, nextCursor: "CUR1" });
    });
    const box = await openWithShortcut();
    await type(box, "tiger");
    expect(await screen.findByText(/most recent 5000 messages/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search older messages" }));
    expect(await screen.findByRole("button", { name: /Other Nurse/ })).toBeTruthy();
    expect(cursors).toEqual([undefined, "CUR1"]);
  });

  it("sends the sender, date and attachment filters", async () => {
    const api = mount(() => page([]));
    const box = await openWithShortcut();
    await type(box, "fall");
    fireEvent.click(screen.getByRole("checkbox", { name: "Has attachment" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: ME } });
    fireEvent.change(screen.getByLabelText("After"), { target: { value: "2026-10-01" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const last = searchCalls(api).at(-1)![1].params.query;
    expect(last).toMatchObject({ q: "fall", hasAttachment: true, senderUserId: ME });
    expect(typeof last.from).toBe("string");
  });

  it("does not offer search, or take over Ctrl+F, in an archived conversation", async () => {
    mount(() => page([]), { archivedAt: "2026-10-01T00:00:00.000Z" });
    await screen.findByText("hello there");
    expect(screen.queryByRole("button", { name: /Search messages/ })).toBeNull();
    const prevented = !fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    expect(prevented).toBe(false);
  });
});

const resultsText = (): string =>
  document.querySelector(".wx-msg-search-results")?.textContent ?? "";
const shows = (text: string) => waitFor(() => expect(resultsText()).toContain(text));

describe("fix round 1: search", () => {
  it("M9: Ctrl+Shift+F, an already-handled key, a modal, and a focus inside the thread panel are left alone", async () => {
    mount(() => page([]));
    await screen.findByText("hello there");
    expect(fireEvent.keyDown(document, { key: "f", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(screen.queryByRole("searchbox")).toBeNull();

    const handled = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", handled, true);
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    document.removeEventListener("keydown", handled, true);
    expect(screen.queryByRole("searchbox")).toBeNull();

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    expect(fireEvent.keyDown(document, { key: "f", ctrlKey: true })).toBe(true);
    expect(screen.queryByRole("searchbox")).toBeNull();
    modal.remove();

    const aside = document.createElement("aside");
    aside.className = "wx-thread-panel";
    const field = document.createElement("textarea");
    aside.appendChild(field);
    document.body.appendChild(aside);
    expect(fireEvent.keyDown(field, { key: "f", ctrlKey: true })).toBe(true);
    expect(screen.queryByRole("searchbox")).toBeNull();
    aside.remove();

    expect(fireEvent.keyDown(document, { key: "f", ctrlKey: true })).toBe(false); // still works when none apply
    expect(await screen.findByRole("searchbox")).toBeTruthy();
  });

  it("a failed 'show more' keeps the results already loaded and offers a retry", async () => {
    let calls = 0;
    mount((init) => {
      calls += 1;
      if (!init.params.query.cursor)
        return page([message("s1", "tiger one")], { nextCursor: "C1" });
      return calls === 2 ? failed() : page([message("s2", "tiger two")]);
    });
    const box = await openWithShortcut();
    await type(box, "tiger");
    await shows("tiger one");
    fireEvent.click(screen.getByRole("button", { name: "Show more results" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be searched/i);
    expect(resultsText()).toContain("tiger one");
    // One retry control, not two: the same button that said "Show more results" now says "Try again".
    expect(screen.queryAllByRole("button", { name: /retry|try again|show more/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await shows("tiger two");
    expect(resultsText()).toContain("tiger one");
  });

  it("an inverted After/Before range says so and is not sent", async () => {
    const api = mount(() => page([]));
    const box = await openWithShortcut();
    await type(box, "fall");
    const before = searchCalls(api).length;
    fireEvent.change(screen.getByLabelText("After"), { target: { value: "2026-10-10" } });
    fireEvent.change(screen.getByLabelText("Before"), { target: { value: "2026-10-01" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(screen.getByText(/before.*earlier than.*after|after.*later than.*before/i)).toBeTruthy();
    expect(
      searchCalls(api)
        .slice(before)
        .some(([, init]) => init.params.query.from && init.params.query.to),
    ).toBe(false);
  });

  it("a reply for an older query never replaces a newer one", async () => {
    const resolvers: Array<(value: SearchReply) => void> = [];
    const api = mount(() => undefined as never);
    api.GET.mockImplementation((path: string, init: Record<string, any>) =>
      path === SEARCH
        ? new Promise((resolve) => {
            resolvers.push(resolve as never);
            void init;
          })
        : Promise.resolve(
            path === LIST
              ? ok({ messages: [message("m1", "hello there")] })
              : ok({ pins: [], patientId: null }),
          ),
    );
    const box = await openWithShortcut();
    await type(box, "alpha");
    await type(box, "alphabet");
    expect(resolvers.length).toBe(2);
    resolvers[1]!(page([message("n", "alphabet soup")]));
    await shows("alphabet soup");
    resolvers[0]!(page([message("o", "stale alpha result")]));
    await act(async () => {
      await Promise.resolve();
    });
    expect(resultsText()).not.toContain("stale alpha");
    expect(resultsText()).toContain("alphabet soup");
  });

  it("has one live region, not an output nested in an aria-live", async () => {
    mount(() => page([]));
    const box = await openWithShortcut();
    fireEvent.change(box, { target: { value: "zz" } });
    const region = document.querySelector(".wx-msg-search-status") as HTMLElement;
    expect(region.querySelector("output")).toBeNull();
    expect(region.getAttribute("aria-live") ?? region.getAttribute("role")).toBeTruthy();
  });

  it("closes and clears the search when the conversation becomes archived", async () => {
    const api = {
      GET: vi.fn(() => Promise.resolve(page([]))),
    };
    const view = (archived: boolean) => (
      <ApiClientProvider client={api as unknown as ApiClient}>
        <MessageSearch
          channelId="dm-1"
          archived={archived}
          meId={ME}
          messages={[]}
          onJump={() => {}}
        />
      </ApiClientProvider>
    );
    const { rerender } = render(view(false));
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    const box = (await screen.findByRole("searchbox")) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "secret words" } });
    rerender(view(true));
    rerender(view(false));
    expect(screen.queryByRole("searchbox")).toBeNull(); // not silently reopened with the old query
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    expect(((await screen.findByRole("searchbox")) as HTMLInputElement).value).toBe("");
  });
});
