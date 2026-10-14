/**
 * WP 2.10 in the web client: the poll card (radio group, text results, live region, close, who voted, closed and
 * failure states) and the composer action (create dialog, patient-linked channels explain why it is unavailable).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PollView } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";
import type { ChannelSummary } from "./messaging-types";

const ME = "11111111-1111-4111-8111-111111111111";
const LIST = "/api/v1/messaging/channels/{id}/messages";
const POLL = "/api/v1/messaging/channels/{id}/messages/{messageId}/poll";
const VOTE = `${POLL}/vote`;
const CLOSE = `${POLL}/close`;
const CREATE = "/api/v1/messaging/channels/{id}/polls";

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

const poll = (over: Partial<PollView> = {}): PollView => ({
  pollId: "poll-1",
  closed: false,
  closedAt: null,
  totalVotes: 4,
  myOptionId: "o1",
  canClose: false,
  options: [
    { optionId: "o1", label: "Pizza", voteCount: 3 },
    { optionId: "o2", label: "Salad", voteCount: 1 },
    { optionId: "o3", label: "Soup", voteCount: 0 },
  ],
  ...over,
});

const pollMessage = (view: PollView) => ({
  messageId: "m1",
  channelId: "dm-1",
  authorUserId: ME,
  authorDisplayName: "Me",
  body: "Lunch on Friday?",
  bodyKind: "plain",
  createdAt: "2026-10-10T09:00:00.000Z",
  parentMessageId: null,
  replyCount: 0,
  lastReplyAt: null,
  references: [],
  attachments: [],
  reactions: [],
  pinned: false,
  poll: view,
});

interface World {
  messages: unknown[];
  put?: (path: string, init: Record<string, any>) => unknown;
  post?: (path: string, init: Record<string, any>) => unknown;
  get?: (path: string, init: Record<string, any>) => unknown;
}

const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } });
const refused = (status: number) => ({
  data: undefined,
  error: { error: { code: "X", message: "refused" } },
  response: { status },
});

function mount(world: World, channelOver: Partial<ChannelSummary> = {}) {
  const api = {
    GET: vi.fn((path: string, init: Record<string, any>) =>
      Promise.resolve(
        path === LIST ? ok({ messages: world.messages }) : (world.get?.(path, init) ?? ok({})),
      ),
    ),
    POST: vi.fn((path: string, init: Record<string, any>) =>
      Promise.resolve(world.post?.(path, init) ?? ok({})),
    ),
    PUT: vi.fn((path: string, init: Record<string, any>) =>
      Promise.resolve(world.put?.(path, init) ?? ok({})),
    ),
    DELETE: vi.fn(() => Promise.resolve(ok({}))),
  };
  render(
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
        />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return api;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("WP 2.10 poll card", () => {
  it("is a radio group with results as text (count and share) and the viewer's own vote checked", async () => {
    mount({ messages: [pollMessage(poll())] });
    const group = await screen.findByRole("group", { name: /Choose one option/ });
    const pizza = within(group).getByRole("radio", { name: /Pizza/ }) as HTMLInputElement;
    expect(pizza.checked).toBe(true);
    expect(within(group).getByText("3 votes (75%)")).toBeTruthy();
    expect(within(group).getByText("1 vote (25%)")).toBeTruthy();
    expect(within(group).getByText("0 votes (0%)")).toBeTruthy();
    expect(screen.getByText("4 votes · Open")).toBeTruthy();
    expect(screen.getByText("Your vote: Pizza")).toBeTruthy();
  });

  it("changes the vote with one request and announces it in a polite live region", async () => {
    const after = poll({
      myOptionId: "o2",
      options: [
        { optionId: "o1", label: "Pizza", voteCount: 2 },
        { optionId: "o2", label: "Salad", voteCount: 2 },
        { optionId: "o3", label: "Soup", voteCount: 0 },
      ],
    });
    const api = mount({
      messages: [pollMessage(poll())],
      put: (path) => (path === VOTE ? ok({ poll: after }) : ok({})),
    });
    fireEvent.click(await screen.findByRole("radio", { name: /Salad/ }));
    await waitFor(() =>
      expect(screen.getAllByText("2 votes (50%)", { selector: "span" }).length).toBe(2),
    );
    const call = api.PUT.mock.calls.find((c) => c[0] === VOTE);
    expect(call?.[1]).toMatchObject({
      params: { path: { id: "dm-1", messageId: "m1" } },
      body: { optionId: "o2" },
    });
    const live = document.querySelector(".wx-poll-live");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toBe("Vote saved: Salad.");
    expect((screen.getByRole("radio", { name: /Salad/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("locks a closed poll: radios disabled, status says Closed, no Close button", async () => {
    mount({
      messages: [pollMessage(poll({ closed: true, closedAt: "2026-10-10T10:00:00.000Z" }))],
    });
    const group = await screen.findByRole("group", { name: /Poll closed/ });
    for (const radio of within(group).getAllByRole("radio")) {
      expect((radio as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByText("4 votes · Closed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close poll" })).toBeNull();
  });

  it("locks the poll and explains when the server says it closed under the voter (409)", async () => {
    mount({ messages: [pollMessage(poll())], put: () => refused(409) });
    fireEvent.click(await screen.findByRole("radio", { name: /Soup/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/This poll has closed/);
    expect(screen.getByText("4 votes · Closed")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Soup/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it("lets the author close after a confirmation, then shows it closed", async () => {
    const closed = poll({ closed: true, closedAt: "2026-10-10T10:00:00.000Z" });
    const api = mount({
      messages: [pollMessage(poll({ canClose: true }))],
      post: (path) => (path === CLOSE ? ok({ poll: closed }) : ok({})),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Close poll" }));
    const confirm = screen.getByRole("group", { name: "Close this poll?" });
    expect(api.POST.mock.calls.some((c) => c[0] === CLOSE)).toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: "Close poll" }));
    await waitFor(() => expect(screen.getByText("4 votes · Closed")).toBeTruthy());
    expect(api.POST.mock.calls.some((c) => c[0] === CLOSE)).toBe(true);
  });

  it("shows who voted for each option by name on request", async () => {
    mount({
      messages: [pollMessage(poll())],
      get: (path) =>
        path === POLL
          ? ok({
              ...poll(),
              voters: {
                o1: [{ userId: "u1", displayName: "Ada Nurse", votedAt: "2026-10-10T09:30:00Z" }],
                o2: [{ userId: "u2", displayName: "Bo Aide", votedAt: "2026-10-10T09:31:00Z" }],
              },
            })
          : ok({}),
    });
    const toggle = await screen.findByRole("button", { name: "Who voted" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(await screen.findByText("Ada Nurse")).toBeTruthy();
    expect(screen.getByText("Bo Aide")).toBeTruthy();
    expect(screen.getAllByText("No votes yet.").length).toBe(1);
  });
});

describe("WP 2.10 poll composer action", () => {
  it("is unavailable in a patient-linked channel, stays focusable, and says why", async () => {
    mount({ messages: [] }, { kind: "care_team", subjectId: "patient-1" });
    const button = await screen.findByRole("button", { name: "Poll" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe("wx-poll-blocked");
    expect(document.getElementById("wx-poll-blocked")?.textContent).toMatch(
      /not available in a conversation linked to a patient/,
    );
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("creates a poll: needs a question and two options, then POSTs with an Idempotency-Key", async () => {
    const created = {
      messageId: "m9",
      channelId: "dm-1",
      createdAt: "2026-10-10T09:00:00Z",
      poll: poll(),
    };
    const api = mount({
      messages: [],
      post: (path) =>
        path === CREATE ? { data: created, error: undefined, response: { status: 201 } } : ok({}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Poll" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create poll" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/Add a question/);
    expect(api.POST.mock.calls.some((c) => c[0] === CREATE)).toBe(false);

    fireEvent.change(within(dialog).getByLabelText("Question"), { target: { value: " Lunch? " } });
    fireEvent.change(within(dialog).getByPlaceholderText("Option 1"), {
      target: { value: "Pizza" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText("Option 2"), {
      target: { value: "Salad" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create poll" }));

    await waitFor(() => expect(api.POST.mock.calls.some((c) => c[0] === CREATE)).toBe(true));
    const [, init] = api.POST.mock.calls.find((c) => c[0] === CREATE)!;
    expect(init.body).toMatchObject({ question: "Lunch?", options: ["Pizza", "Salad"] });
    expect(typeof init.params.header["Idempotency-Key"]).toBe("string");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Poll posted.")).toBeTruthy();
  });

  it("caps options at ten and keeps at least two", async () => {
    mount({ messages: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Poll" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /Remove option/ })).toBeNull();
    for (let i = 0; i < 8; i += 1)
      fireEvent.click(within(dialog).getByRole("button", { name: "Add option" }));
    expect(within(dialog).getAllByPlaceholderText(/Option \d+/).length).toBe(10);
    expect(
      (within(dialog).getByRole("button", { name: "Add option" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
