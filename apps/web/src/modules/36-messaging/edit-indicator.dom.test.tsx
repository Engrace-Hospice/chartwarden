// M36 WP 1.3 - the "Edited" indicator on a message bubble (jsdom). Plain text, never colour alone, not a button;
// it sits outside the body renderer so it applies to every body kind, own and others' messages, channel and thread.
// Opening a revision list is Phase 5 (docs/messaging-hub/06-ux-design.md), tied to messaging.history.read.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";
import { MessageRow } from "./message-row";
import type { Message } from "./messaging-types";
import { absoluteTime } from "./messaging-utils";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const EDITED_AT = "2026-10-10T10:07:00.000Z";

const message = (overrides: Partial<Message> = {}): Message => ({
  messageId: "m-1",
  channelId: "c-1",
  authorUserId: OTHER,
  authorDisplayName: "Nurse Two",
  body: "hello",
  bodyKind: "plain",
  createdAt: "2026-10-10T10:00:00.000Z",
  parentMessageId: null,
  references: [],
  ...overrides,
});

function mount(msg: Message, props: Partial<Parameters<typeof MessageRow>[0]> = {}) {
  const api = {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
  } as unknown as ApiClient;
  return render(
    <ApiClientProvider client={api}>
      <MemoryRouter>
        <MessageRow
          message={msg}
          previous={undefined}
          meId={ME}
          anchorMessageId={null}
          {...props}
        />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const indicator = () => screen.queryByText(/^Edited/);

describe("edit indicator", () => {
  it("shows nothing for a message that was never edited", () => {
    const { unmount } = mount(message());
    expect(indicator()).toBeNull();
    unmount();
    mount(message({ messageId: "m-2", editedAt: null }));
    expect(indicator()).toBeNull();
  });

  it.each([
    ["others' message", OTHER],
    ["own message", ME],
  ])("shows a text 'Edited' label with a machine-readable time on %s", (_name, author) => {
    mount(message({ authorUserId: author, editedAt: EDITED_AT }));
    const label = screen.getByText(/^Edited/);
    expect(label.tagName).toBe("SPAN");
    // visible text == accessible text: no aria-label to override it, and the full date is real (screen-reader) text
    expect(label.getAttribute("aria-label")).toBeNull();
    expect(label.textContent).toMatch(/^Edited \S+/);
    expect(label.textContent).toContain(absoluteTime(EDITED_AT));
    const time = label.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(EDITED_AT);
    expect(time?.getAttribute("title")).toBe(absoluteTime(EDITED_AT));
    expect(label.closest("button, a")).toBeNull();
  });

  it.each([
    ["plain", { bodyKind: "plain" as const }],
    ["markdown", { bodyKind: "markdown" as const, body: "**hi**" }],
    [
      "rich",
      {
        bodyKind: "rich" as const,
        bodyDoc: {
          schemaVersion: 1 as const,
          doc: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
          },
        },
      },
    ],
  ])("renders on a %s body", (_kind, overrides) => {
    mount(message({ ...overrides, editedAt: EDITED_AT } as Partial<Message>));
    expect(indicator()).not.toBeNull();
  });

  it("is not shown on a deleted tombstone", () => {
    mount(message({ body: "", editedAt: EDITED_AT }));
    expect(screen.getByText("Message deleted")).toBeTruthy();
    expect(indicator()).toBeNull();
  });

  it("puts the sent time first, then the edited marker, in one div wrapper (DOM order is reading order)", () => {
    mount(message({ editedAt: EDITED_AT }));
    const meta = document.querySelector(".wx-message-meta");
    // not a direct-child span of the bubble: `.wx-message-bubble > span` would force pre-wrap/anywhere onto it
    expect(meta?.tagName).toBe("DIV");
    const [sent, edited] = Array.from(meta?.children ?? []).filter(
      (el) => !el.hasAttribute("aria-hidden"),
    );
    expect(sent?.tagName).toBe("TIME");
    expect(sent?.getAttribute("datetime")).toBe("2026-10-10T10:00:00.000Z");
    expect(edited?.className).toBe("wx-message-edited");
    expect(within(sent as HTMLElement).queryByText(/Edited/)).toBeNull();
    // the sent time keeps its existing name; the marker adds no second aria-label
    expect(meta?.querySelectorAll("[aria-label]")).toHaveLength(1);
  });

  it.each(["not a date", "<img src=x onerror=alert(1)>", "10", "2026", "Oct 10 2026"])(
    "renders no indicator (and no 'Invalid Date') for a non-ISO or hostile editedAt %j",
    (hostile) => {
      mount(message({ editedAt: hostile }));
      expect(indicator()).toBeNull();
      expect(document.body.textContent).not.toMatch(/Invalid Date/);
      expect(document.querySelector("img")).toBeNull();
    },
  );

  it("has no axe violations (colour contrast is covered by bubble-contrast.test.ts)", async () => {
    const { container } = mount(message({ editedAt: EDITED_AT }));
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("edit indicator in the real thread panel", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows Edited on an edited reply and not on the unedited root", async () => {
    const base = {
      channelId: "dm-1",
      authorUserId: OTHER,
      authorDisplayName: "Other Nurse",
      bodyKind: "plain",
      references: [],
      attachments: [],
      lastReplyAt: null,
    };
    const root = {
      ...base,
      messageId: "root-1",
      body: "root body",
      createdAt: "2026-10-10T09:00:00.000Z",
      parentMessageId: null,
      replyCount: 1,
    };
    const reply = {
      ...base,
      messageId: "reply-1",
      body: "reply body",
      createdAt: "2026-10-10T09:01:00.000Z",
      parentMessageId: "root-1",
      replyCount: 0,
      editedAt: EDITED_AT,
    };
    // Strict mock: every call the thread makes is answered by path; anything else is recorded and fails the test.
    const unmocked: string[] = [];
    const answer = (method: string, path: string) => {
      if (
        method === "GET" &&
        path === "/api/v1/messaging/channels/{id}/messages/{messageId}/thread"
      ) {
        return {
          data: { root, replies: [reply], patientId: null },
          error: undefined,
          response: { status: 200 },
        };
      }
      if (method === "GET" && path === "/api/v1/messaging/channels/{id}/messages") {
        return { data: { messages: [root, reply] }, error: undefined };
      }
      if (method === "POST" && path === "/api/v1/messaging/messages/{id}/read") {
        return { data: undefined, error: undefined, response: { status: 204 } };
      }
      if (method === "GET" && path === "/api/v1/messaging/channels/{id}/pins") {
        return { data: { pins: [], patientId: null }, error: undefined, response: { status: 200 } };
      }
      if (method === "GET" && path === "/api/v1/messaging/tasks") {
        // The message-row Task trigger asks once whether the tenant has tasks on; off here.
        return { data: { enabled: false, tasks: [] }, error: undefined, response: { status: 200 } };
      }
      if (
        method === "GET" &&
        (path === "/api/v1/messaging/channels/{id}/snooze" ||
          path === "/api/v1/messaging/reminders")
      ) {
        // WP 4.10: the header snooze control and the message "Remind me" trigger each ask once whether the tenant has them on; off here.
        return { data: undefined, error: {}, response: { status: 404 } };
      }
      if (method === "GET" && path === "/api/v1/messaging/channels/{id}/draft") {
        return { data: { draft: null }, error: undefined, response: { status: 200 } };
      }
      unmocked.push(`${method} ${path}`);
      return { data: undefined, error: { message: "unmocked" }, response: { status: 500 } };
    };
    const api = {
      GET: vi.fn((path: string) => Promise.resolve(answer("GET", path))),
      POST: vi.fn((path: string) => Promise.resolve(answer("POST", path))),
    };
    render(
      <MemoryRouter>
        <ApiClientProvider client={api as unknown as ApiClient}>
          <ConversationThread
            channel={{
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
            }}
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
    fireEvent.click(await screen.findByRole("button", { name: "Open thread, 1 reply" }));
    const panel = await screen.findByRole("complementary", { name: "Thread" });
    await within(panel).findByText("reply body");
    expect(within(panel).getAllByText(/^Edited/)).toHaveLength(1);
    const replyRow = within(panel).getByText("reply body").closest("article") as HTMLElement;
    expect(within(replyRow).getByText(/^Edited/)).toBeTruthy();
    const rootRow = within(panel).getByText("root body").closest("article") as HTMLElement;
    expect(within(rootRow).queryByText(/^Edited/)).toBeNull();
    await waitFor(() => expect(api.POST).toHaveBeenCalled());
    expect(unmocked, `unmocked API call: ${unmocked.join(", ")}`).toEqual([]);
  });
});
