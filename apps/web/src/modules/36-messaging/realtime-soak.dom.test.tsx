import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";

// WP 5.2 soak: the socket drops and returns 50 times while the server keeps appending. Hints are never
// consulted for content; only the REST reads decide what the timeline shows.
const sockets = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: unknown) => void>(),
}));
vi.mock("socket.io-client", () => ({
  io: () => ({
    on: (event: string, fn: (payload?: unknown) => void) => sockets.handlers.set(event, fn),
    off: (event: string) => sockets.handlers.delete(event),
    close: () => {},
  }),
}));

const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const CHANNEL_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PAGE = 50;
const CYCLES = 50;

afterEach(() => vi.useRealTimers());

const row = (n: number) => ({
  messageId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  channelId: CHANNEL_ID,
  authorUserId: "22222222-2222-4222-8222-222222222222",
  authorDisplayName: "Nurse Two",
  body: `soak-${String(n).padStart(4, "0")}`,
  bodyKind: "plain",
  createdAt: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(),
  parentMessageId: null,
  references: [],
});

/** A server whose backward pages are keyed by an opaque cursor (the exclusive end index). */
function fakeServer() {
  const all: ReturnType<typeof row>[] = [];
  const append = (count: number) => {
    for (let i = 0; i < count; i += 1) all.push(row(all.length + 1));
  };
  const GET = vi.fn((path: string, init?: { params?: { query?: { cursor?: string } } }) => {
    if (path === "/api/v1/messaging/channels") {
      return Promise.resolve({
        data: {
          channels: [
            {
              channelId: CHANNEL_ID,
              kind: "dm",
              title: "Soak",
              subjectId: null,
              archivedAt: null,
              unreadCount: 0,
              participantRoles: [],
              lastActivityAt: "2026-10-09T10:00:00.000Z",
              lastMessage: null,
            },
          ],
        },
      });
    }
    const end = init?.params?.query?.cursor ? Number(init.params.query.cursor) : all.length;
    const start = Math.max(0, end - PAGE);
    return Promise.resolve({
      data: {
        messages: all.slice(start, end),
        ...(start > 0 ? { nextCursor: String(start) } : {}),
      },
    });
  });
  return {
    all,
    append,
    api: { GET, POST: vi.fn(() => Promise.resolve({ data: {} })) } as unknown as ApiClient,
  };
}

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(10)));
const emit = (event: string) => act(async () => void sockets.handlers.get(event)?.());
const shownBodies = () => screen.queryAllByText(/^soak-\d{4}$/).map((node) => node.textContent);

describe("realtime reconnect soak (WP 5.2)", () => {
  it("converges to the server set across 50 connect/disconnect cycles without moving focus", async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    server.append(5);
    render(
      <MemoryRouter>
        <ApiClientProvider client={server.api}>
          <SessionProvider session={SESSION}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await settle();
    await emit("connect");
    await settle();
    const composer = screen.getByRole("textbox", { name: "Message" });
    composer.focus();
    expect(document.activeElement).toBe(composer);

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      await emit("disconnect");
      // Most outages miss a few messages; every tenth misses more than one page, forcing a multi-page catch-up.
      server.append(cycle % 10 === 9 ? PAGE + 10 : (cycle % 4) + 1);
      await emit("connect");
      await settle();
      await settle();
    }
    await settle();

    const expected = server.all.map((message) => message.body);
    expect(shownBodies()).toEqual(expected); // same set, same order, no duplicates, no holes
    expect(screen.queryByText(/Some messages may be missing/)).toBeNull();
    expect(document.activeElement).toBe(composer);
  });
});
