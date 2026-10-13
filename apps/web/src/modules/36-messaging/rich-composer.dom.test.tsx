// M36 WP 2.1 - the rich composer and the stored/reflected paths through the real thread (jsdom): markdown shortcuts
// send a structured body, keyboard shortcuts behave and never trap focus, a stored rich message renders from its
// document, and hostile text in a message, an error message or a hostile document never becomes live DOM.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sanitizeRichBody } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";

vi.mock("@wardenx/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wardenx/types")>();
  return { ...actual, sanitizeRichBody: vi.fn(actual.sanitizeRichBody) };
});
vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const SENT = {
  messageId: "message-1",
  channelId: "dm-1",
  createdAt: "2026-10-10T10:00:00.000Z",
};
const CHANNEL = {
  channelId: "dm-1",
  kind: "dm",
  title: "Nurse Two",
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
};
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, ...marks: unknown[]) =>
  marks.length ? { type: "text", text: value, marks } : { type: "text", text: value };
const docOf = (...content: unknown[]) => ({ schemaVersion: 1, doc: { type: "doc", content } });

interface Mock {
  readonly messages?: unknown[];
  readonly post?: () => Promise<unknown>;
}

function mountThread({ messages = [], post }: Mock = {}) {
  const POST = vi.fn(post ?? (() => Promise.resolve({ data: SENT, error: undefined })));
  const api = {
    GET: vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/v1/messaging/channels"
          ? { data: { channels: [CHANNEL] }, error: undefined }
          : { data: { messages }, error: undefined },
      ),
    ),
    POST,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={api}>
        <SessionProvider session={SESSION}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { POST };
}

const composer = async () =>
  (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;

function type(box: HTMLTextAreaElement, value: string, start = value.length, end = start) {
  fireEvent.change(box, { target: { value } });
  box.setSelectionRange(start, end);
}

describe("rich composer", () => {
  it("sends a formatted draft as a structured body and shows it formatted", async () => {
    const { POST } = mountThread();
    const box = await composer();
    type(box, "**urgent**: see [guide](https://example.com/g)");
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(POST).toHaveBeenCalled());
    const sent = (POST.mock.calls[0] as unknown[])[1] as { body: Record<string, unknown> };
    expect(sent.body).toMatchObject({
      bodyDoc: {
        schemaVersion: 1,
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "urgent", marks: [{ type: "bold" }] },
                { type: "text", text: ": see " },
                {
                  type: "text",
                  text: "guide",
                  marks: [{ type: "link", href: "https://example.com/g" }],
                },
              ],
            },
          ],
        },
      },
    });
    expect(sent.body).not.toHaveProperty("body");
    expect(sent.body).not.toHaveProperty("references");
    expect((await screen.findByText("urgent")).tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: /^guide/ });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps an unformatted draft on the plain path, unchanged", async () => {
    const { POST } = mountThread();
    const box = await composer();
    type(box, "hello there");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(((POST.mock.calls[0] as unknown[])[1] as { body: unknown }).body).toEqual({
      body: "hello there",
      references: [],
      clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("Shift+Enter inserts a newline instead of sending", async () => {
    const { POST } = mountThread();
    const box = await composer();
    type(box, "line one");
    const notPrevented = fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(notPrevented).toBe(true);
    expect(POST).not.toHaveBeenCalled();
  });

  it("Ctrl+B wraps the selection synchronously (selection restored at once), a second press unwraps", async () => {
    mountThread();
    const box = await composer();
    type(box, "say hello now", 4, 9);
    fireEvent.keyDown(box, { code: "KeyB", key: "b", ctrlKey: true });
    expect(box.value).toBe("say **hello** now");
    expect([box.selectionStart, box.selectionEnd]).toEqual([6, 11]);
    fireEvent.keyDown(box, { code: "KeyB", key: "b", ctrlKey: true });
    expect(box.value).toBe("say hello now");
    type(box, "say hello now", 4, 9);
    fireEvent.keyDown(box, { code: "KeyI", key: "\u0448", ctrlKey: true });
    expect(box.value).toBe("say *hello* now");
  });

  it("L5: the edit is built from the textarea's live value, not from possibly stale React state", async () => {
    mountThread();
    const box = await composer();
    type(box, "abc");
    // A programmatic change that React has not seen yet (autofill, extension, paste handler).
    box.value = "abcdef";
    box.setSelectionRange(3, 6);
    fireEvent.keyDown(box, { code: "KeyB", key: "b", ctrlKey: true });
    expect(box.value).toBe("abc**def**");
  });

  it("Cmd is not the format key off macOS", async () => {
    mountThread();
    const box = await composer();
    type(box, "say hello now", 4, 9);
    fireEvent.keyDown(box, { code: "KeyB", key: "b", metaKey: true });
    expect(box.value).toBe("say hello now");
  });

  it("a shortcut edit goes through the input path, so the mention query is recomputed (W7)", async () => {
    mountThread();
    const box = await composer();
    type(box, "hello @Nu");
    expect(box.getAttribute("aria-controls")).toBe("messaging-mention-suggestions");
    box.setSelectionRange(0, 9);
    fireEvent.keyDown(box, { code: "KeyB", key: "b", ctrlKey: true });
    expect(box.value).toBe("**hello @Nu**");
    expect(box.getAttribute("aria-controls")).toBeNull();
  });

  it("never carries aria-expanded (invalid on a textbox; axe aria-allowed-attr)", async () => {
    mountThread();
    const box = await composer();
    type(box, "hello @Nu");
    expect(box.hasAttribute("aria-expanded")).toBe(false);
  });

  it("Escape closes the mention popup first and does not blur", async () => {
    mountThread();
    const box = await composer();
    box.focus();
    type(box, "hello @Nu");
    expect(box.getAttribute("aria-controls")).toBe("messaging-mention-suggestions");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.getAttribute("aria-controls")).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it("Escape with text in the composer keeps focus and the draft; with an empty composer it leaves", async () => {
    mountThread();
    const box = await composer();
    box.focus();
    type(box, "draft stays");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe("draft stays");
    type(box, "");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(document.activeElement).not.toBe(box);
  });

  it("nothing in the composer is a keyboard trap: Tab is never prevented", async () => {
    mountThread();
    const box = await composer();
    type(box, "text");
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
  });

  it("IME composition: Enter, Escape-for-popup and format keys are ignored while composing (W6)", async () => {
    const { POST } = mountThread();
    const box = await composer();
    type(box, "hello @Nu");
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Escape", isComposing: true });
    expect(POST).not.toHaveBeenCalled();
    expect(box.getAttribute("aria-controls")).toBe("messaging-mention-suggestions");
    box.setSelectionRange(0, 5);
    fireEvent.keyDown(box, { code: "KeyB", key: "b", ctrlKey: true, isComposing: true });
    expect(box.value).toBe("hello @Nu");
  });

  it("labels the composer for assistive technology and advertises the shortcuts", async () => {
    mountThread();
    const box = await composer();
    expect(box.getAttribute("aria-label")).toBe("Message");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.getByText(/Enter to send/)).toBeTruthy();
  });
});

describe("stored and reflected hostile content in the real thread", () => {
  const BASE = {
    channelId: "dm-1",
    authorUserId: "22222222-2222-4222-8222-222222222222",
    authorDisplayName: "Nurse Two",
    createdAt: "2026-10-10T09:00:00.000Z",
    parentMessageId: null,
    references: [],
  };

  it("renders a stored rich message from its document and never as raw markup", async () => {
    mountThread({
      messages: [
        {
          ...BASE,
          messageId: "m-rich",
          body: "<img src=x onerror=window.__xss=1> docs",
          bodyKind: "rich",
          bodyDoc: docOf(
            para(
              text("<img src=x onerror=window.__xss=1> "),
              text("docs", { type: "link", href: "https://example.com/" }),
            ),
          ),
        },
      ],
    });
    expect(await screen.findByRole("link", { name: /^docs/ })).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=window.__xss=1>/)).toBeTruthy();
    expect((window as unknown as Record<string, unknown>).__xss).toBeUndefined();
  });

  it("a hostile document that skipped the server degrades to the projection, no anchors", async () => {
    mountThread({
      messages: [
        {
          ...BASE,
          messageId: "m-hostile",
          body: "click me",
          bodyKind: "rich",
          bodyDoc: docOf(
            para(text("click me", { type: "link", href: "javascript:window.__xss=1" })),
          ),
        },
      ],
    });
    expect(await screen.findByText("click me")).toBeTruthy();
    expect(document.querySelectorAll("a[href^='javascript']")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "click me" })).toBeNull();
  });

  it("legacy plain and markdown rows render exactly as before: markup stays literal text", async () => {
    mountThread({
      messages: [
        { ...BASE, messageId: "m-plain", body: "**not bold** <b>x</b>", bodyKind: "plain" },
        { ...BASE, messageId: "m-md", body: "# [a](javascript:1)", bodyKind: "markdown" },
      ],
    });
    expect(await screen.findByText("**not bold** <b>x</b>")).toBeTruthy();
    expect(screen.getByText("# [a](javascript:1)")).toBeTruthy();
    expect(
      document.querySelector(
        ".wx-message-bubble b, .wx-message-bubble strong, .wx-message-bubble a, .wx-message-bubble h1",
      ),
    ).toBeNull();
  });

  it("an error message that echoes markup is shown as text, never parsed", async () => {
    mountThread({
      post: () =>
        Promise.resolve({
          data: undefined,
          error: { error: { message: '<img src=x onerror="window.__xss=1">' } },
          response: { status: 422 },
        }),
    });
    const box = await composer();
    type(box, "**x**");
    fireEvent.keyDown(box, { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('<img src=x onerror="window.__xss=1">');
    expect(alert.querySelector("img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xss).toBeUndefined();
  });

  it("typing in the composer does not re-sanitise rendered messages (W1)", async () => {
    mountThread({
      messages: [
        {
          ...BASE,
          messageId: "m-memo",
          body: "hello",
          bodyKind: "rich",
          bodyDoc: docOf(para(text("hello", { type: "bold" }))),
        },
      ],
    });
    await screen.findByText("hello");
    const box = await composer();
    const before = vi.mocked(sanitizeRichBody).mock.calls.length;
    for (const value of ["a", "ab", "abc", "abcd", "abcde"]) type(box, value);
    expect(box.value).toBe("abcde");
    expect(vi.mocked(sanitizeRichBody).mock.calls.length).toBe(before);
  });

  it("an unreadable stored rich body says so instead of 'Message deleted' (S4)", async () => {
    mountThread({
      messages: [{ ...BASE, messageId: "m-bad", body: "", bodyKind: "rich", bodyUnreadable: true }],
    });
    expect(await screen.findByText("Message could not be displayed")).toBeTruthy();
    expect(screen.queryByText("Message deleted")).toBeNull();
  });

  it("the fallback text keeps its line breaks (W5)", async () => {
    mountThread({
      messages: [
        {
          ...BASE,
          messageId: "m-fb",
          body: "line one\nline two",
          bodyKind: "rich",
          bodyDoc: { schemaVersion: 1, doc: { type: "doc", content: [{ type: "html" }] } },
        },
      ],
    });
    const fallback = (await screen.findByText(/line one/)) as HTMLElement;
    expect(fallback.className).toContain("wx-rich-fallback");
    expect(fallback.textContent).toBe("line one\nline two");
  });
});
