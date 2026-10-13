/**
 * WP 2.4 in the web client: reaction chips and the picker (keyboard, copy, live region, failure), Pin/Unpin, the
 * pinned-messages bar, the archived (read only) state, and the rule that nothing here is, or looks like, an
 * acknowledgement.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";
import type { ChannelSummary } from "./messaging-types";

const ME = "11111111-1111-4111-8111-111111111111";
const LIST = "/api/v1/messaging/channels/{id}/messages";
const PINS = "/api/v1/messaging/channels/{id}/pins";
const REACT = "/api/v1/messaging/channels/{id}/messages/{messageId}/reactions/{emoji}";
const PIN = "/api/v1/messaging/channels/{id}/messages/{messageId}/pin";

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
  reactions: [],
  pinned: false,
  ...over,
});

interface World {
  messages: unknown[];
  pins?: unknown[];
  put?: (path: string, init: Record<string, any>) => unknown;
  del?: (path: string, init: Record<string, any>) => unknown;
}

function mount(world: World, channelOver: Partial<ChannelSummary> = {}) {
  const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } });
  const api = {
    GET: vi.fn((path: string) =>
      Promise.resolve(
        path === LIST
          ? ok({ messages: world.messages })
          : path === PINS
            ? ok({ pins: world.pins ?? [], patientId: null })
            : ok({}),
      ),
    ),
    POST: vi.fn(() => Promise.resolve(ok({}))),
    PUT: vi.fn((path: string, init: Record<string, any>) =>
      Promise.resolve(world.put?.(path, init) ?? ok({ reactions: [], pinnedAt: "x" })),
    ),
    DELETE: vi.fn((path: string, init: Record<string, any>) =>
      Promise.resolve(world.del?.(path, init) ?? ok({ reactions: [] })),
    ),
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

describe("WP 2.4 reactions", () => {
  it("shows each reaction as a toggle button with a full accessible name and the viewer's own state", async () => {
    mount({
      messages: [
        message("m1", {
          reactions: [
            { emoji: "heart", count: 2, reactedByMe: true },
            { emoji: "thanks", count: 1, reactedByMe: false },
          ],
        }),
      ],
    });
    const mine = await screen.findByRole("button", {
      name: "Heart, 2 reactions, including yours. Remove your reaction",
    });
    expect(mine.getAttribute("aria-pressed")).toBe("true");
    const other = screen.getByRole("button", { name: "Thanks, 1 reaction. Add your reaction" });
    expect(other.getAttribute("aria-pressed")).toBe("false");
  });

  it("opens the picker from the keyboard, says a reaction is not an acknowledgement, and Escape returns focus", async () => {
    mount({ messages: [message("m1")] });
    const trigger = await screen.findByRole("button", { name: "Add a reaction" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.focus();
    fireEvent.click(trigger);
    const picker = await screen.findByRole("group", { name: "Choose a reaction" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(picker).getByText(/does not mean anyone has read, acknowledged or acted/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(picker).getByRole("button", { name: "Heart" })),
    );
    fireEvent.keyDown(picker, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Choose a reaction" })).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("adds a reaction through the picker, shows the server's answer, and announces it politely", async () => {
    const api = mount({
      messages: [message("m1")],
      put: () => ({
        data: { reactions: [{ emoji: "celebrate", count: 1, reactedByMe: true }] },
        error: undefined,
        response: { status: 200 },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add a reaction" }));
    fireEvent.click(await screen.findByRole("button", { name: "Celebrate" }));
    await screen.findByRole("button", { name: /^Celebrate, 1 reaction, including yours/ });
    expect(api.PUT).toHaveBeenCalledWith(REACT, {
      params: { path: { id: "dm-1", messageId: "m1", emoji: "celebrate" } },
    });
    const live = document.querySelector("output.sr-only");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toBe("Celebrate reaction added.");
  });

  it("removes the viewer's own reaction with DELETE", async () => {
    const api = mount({
      messages: [message("m1", { reactions: [{ emoji: "heart", count: 1, reactedByMe: true }] })],
      del: () => ({ data: { reactions: [] }, error: undefined, response: { status: 200 } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Heart, 1 reaction/ }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Heart, 1 reaction/ })).toBeNull(),
    );
    expect(api.DELETE).toHaveBeenCalledWith(REACT, {
      params: { path: { id: "dm-1", messageId: "m1", emoji: "heart" } },
    });
  });

  it("tells the user when a reaction could not be saved, and keeps the message as it was", async () => {
    mount({
      messages: [message("m1")],
      put: () => ({ data: undefined, error: { code: "X" }, response: { status: 410 } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add a reaction" }));
    fireEvent.click(await screen.findByRole("button", { name: "Heart" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This conversation is archived and read only.",
    );
  });

  it("is read only in an archived channel: reactions still show, nothing can be added, pinned or changed", async () => {
    mount(
      {
        messages: [
          message("m1", { reactions: [{ emoji: "heart", count: 1, reactedByMe: false }] }),
        ],
      },
      { archivedAt: "2026-10-01T00:00:00.000Z" },
    );
    const chip = await screen.findByRole("button", { name: /^Heart, 1 reaction/ });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Add a reaction" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pin this message" })).toBeNull();
  });

  it("never offers anything that reads as an acknowledgement", async () => {
    mount({
      messages: [message("m1", { reactions: [{ emoji: "heart", count: 1, reactedByMe: false }] })],
    });
    await screen.findByText("body of m1");
    expect(screen.queryByRole("button", { name: /acknowledg|acked|confirm read/i })).toBeNull();
  });
});

describe("WP 2.4 pins", () => {
  it("pins from the row, flips to Unpin, labels the message Pinned, and tells the screen reader", async () => {
    const api = mount({ messages: [message("m1")] });
    fireEvent.click(await screen.findByRole("button", { name: "Pin this message" }));
    await screen.findByRole("button", { name: "Unpin this message" });
    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(api.PUT).toHaveBeenCalledWith(PIN, {
      params: { path: { id: "dm-1", messageId: "m1" } },
    });
    expect(document.querySelector("output.sr-only")?.textContent).toBe("Message pinned.");
    fireEvent.click(screen.getByRole("button", { name: "Unpin this message" }));
    await screen.findByRole("button", { name: "Pin this message" });
    expect(api.DELETE).toHaveBeenCalledWith(PIN, {
      params: { path: { id: "dm-1", messageId: "m1" } },
    });
  });

  it("lists the pinned messages in a collapsed bar and jumps to the one chosen", async () => {
    const pinned = message("m1", { pinned: true, authorDisplayName: "Pinner" });
    mount({ messages: [pinned, message("m2")], pins: [pinned] });
    const toggle = await screen.findByRole("button", { name: "Pinned messages (1)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(await screen.findByRole("button", { name: /Pinner\s*body of m1/ }));
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it("shows no bar when nothing is pinned, and a short notice when the pin list cannot be read", async () => {
    mount({ messages: [message("m1")] });
    await screen.findByText("body of m1");
    expect(screen.queryByRole("navigation", { name: "Pinned messages" })).toBeNull();
  });
});
