/**
 * WP 2.5 wired into the real composers: the channel composer restores a server draft and autosaves typing, and the
 * thread panel's reply composer does the same for its root.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";
import type { ChannelSummary } from "./messaging-types";
import { DRAFT_SAVE_DEBOUNCE_MS } from "./use-server-draft";

const DRAFT = "/api/v1/messaging/channels/{id}/draft";
const channel: ChannelSummary = {
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
};

function mount(serverDraft: unknown) {
  const api = {
    GET: vi.fn((path: string) =>
      Promise.resolve(
        path === DRAFT
          ? { data: { draft: serverDraft }, error: undefined, response: { status: 200 } }
          : { data: { messages: [] }, error: undefined },
      ),
    ),
    PUT: vi.fn(() =>
      Promise.resolve({
        data: { draft: { revision: 1, body: "x", references: [], deviceId: "d", updatedAt: "t" } },
        error: undefined,
        response: { status: 200 },
      }),
    ),
    DELETE: vi.fn(() =>
      Promise.resolve({ data: undefined, error: undefined, response: { status: 204 } }),
    ),
    POST: vi.fn(),
  };
  render(
    <MemoryRouter>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <ConversationThread
          channel={channel}
          meId="me"
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

describe("server drafts in the composer", () => {
  it("restores the draft saved on another device into the empty composer", async () => {
    mount({
      channelId: "dm-1",
      parentMessageId: null,
      body: "started on my phone",
      references: [],
      revision: 2,
      deviceId: "phone",
      updatedAt: "2026-10-12T10:00:00.000Z",
    });
    const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("started on my phone"));
  });

  it("autosaves what the user types after a quiet moment", async () => {
    const api = mount(null);
    const box = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(api.GET).toHaveBeenCalledWith(DRAFT, expect.anything()));
    vi.useFakeTimers();
    try {
      fireEvent.change(box, { target: { value: "half a thought" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DEBOUNCE_MS + 10);
      });
      expect(api.PUT).toHaveBeenCalledTimes(1);
      expect((api.PUT.mock.calls[0] as unknown[])[1]).toMatchObject({
        body: { body: "half a thought", baseRevision: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
