/**
 * Regression: the first click on "Patient context" did nothing (aria-expanded stayed false). The thread's
 * channel-reset effect also closes the panel, so any dependency that changed identity on a render re-ran it and undid
 * the toggle. Opening the panel must survive the re-render it causes, and must not re-read the conversation.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationThread } from "./conversation-thread";
import type { ChannelSummary } from "./messaging-types";

const ME = "11111111-1111-4111-8111-111111111111";
const LIST = "/api/v1/messaging/channels/{id}/messages";

const channel: ChannelSummary = {
  channelId: "ct-1",
  kind: "care_team",
  title: "Care team",
  subjectId: "p-1",
  archivedAt: null,
  unreadCount: 0,
  mentionCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("patient context toggle", () => {
  it("opens on the first click and does not re-read the conversation", async () => {
    const get = vi.fn((path: string) => {
      if (path === LIST)
        return Promise.resolve({ data: { messages: [] }, response: { status: 200 } });
      if (path === "/api/v1/patients/{id}") {
        return Promise.resolve({
          data: { id: "p-1", firstName: "Margaret", lastName: "Brandt", mrn: "MRN-1" },
          response: { status: 200 },
        });
      }
      return Promise.resolve({ data: { patient_id: "p-1", tiles: {} }, response: { status: 200 } });
    });
    const api = {
      GET: get,
      POST: vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } }),
      PUT: vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } }),
      DELETE: vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } }),
    };
    const tree = (client: unknown) => (
      <MemoryRouter>
        <ApiClientProvider client={client as ApiClient}>
          <ConversationThread
            channel={channel}
            meId={ME}
            meDisplayName="Me"
            onBack={() => {}}
            onReadConfirmed={() => {}}
            onMessageSent={() => {}}
            onAccessRevoked={() => {}}
          />
        </ApiClientProvider>
      </MemoryRouter>
    );
    const view = render(tree(api));
    const toggle = await screen.findByRole("button", { name: /Patient context/ });
    await waitFor(() => expect(get.mock.calls.some((c) => c[0] === LIST)).toBe(true));
    const listReads = () => get.mock.calls.filter((c) => c[0] === LIST).length;
    const before = listReads();

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(listReads()).toBe(before);

    // A new client identity (token refresh) re-runs the load effect; it must not close the panel the user opened.
    view.rerender(tree({ ...api }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
