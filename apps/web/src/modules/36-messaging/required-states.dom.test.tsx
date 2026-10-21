import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { ConversationInbox } from "./conversation-inbox";
import { correlationIdOf } from "./messaging-utils";
import { RealtimeBanner, useRealtimeDegraded } from "./realtime-banner";
import { StaffMessaging } from "./staff-messaging";
import { TimelineState } from "./timeline-state";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

// WP 2.11 required states (06-ux-design §4): skeleton + aria-busy while loading, and a load failure that offers retry
// and quotes the correlation id instead of rendering as empty.
describe("correlationIdOf", () => {
  it("reads a flat or nested envelope and ignores anything else", () => {
    expect(correlationIdOf({ correlationId: "c-1" })).toBe("c-1");
    expect(correlationIdOf({ error: { correlationId: "c-2" } })).toBe("c-2");
    expect(correlationIdOf({ correlationId: 7 })).toBeNull();
    expect(correlationIdOf("boom")).toBeNull();
    expect(correlationIdOf(null)).toBeNull();
  });
});

describe("TimelineState", () => {
  it("shows a busy skeleton while loading, never the empty state", () => {
    render(
      <TimelineState
        loadError={null}
        correlationId={null}
        loading
        empty={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading messages").closest("[aria-busy=true]")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("shows retry and the correlation id when the load failed", () => {
    const onRetry = vi.fn();
    render(
      <TimelineState
        loadError="nope"
        correlationId="c-9"
        loading={false}
        empty
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/c-9/)).toBeTruthy();
    expect(screen.queryByText("No messages yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("ConversationInbox load states", () => {
  const base = {
    visibleChannels: [],
    activeId: null,
    query: "",
    filter: "all" as const,
    onQueryChange: vi.fn(),
    onFilterChange: vi.fn(),
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    onNewConversation: vi.fn(),
    onShowScheduled: vi.fn(),
  };

  it("shows a busy skeleton before the first load", () => {
    render(<ConversationInbox {...base} channels={null} error={null} errorCorrelationId={null} />);
    expect(screen.getByText("Loading conversations").closest("[aria-busy=true]")).toBeTruthy();
  });

  it("quotes the correlation id when the first load failed", () => {
    render(<ConversationInbox {...base} channels={null} error="down" errorCorrelationId="c-5" />);
    expect(screen.getByText(/c-5/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("degraded realtime", () => {
  it("is degraded only after the socket was up and dropped", () => {
    const { result, rerender } = renderHook(({ up }) => useRealtimeDegraded(up), {
      initialProps: { up: false },
    });
    expect(result.current).toBe(false); // never connected: polling by design, no warning
    rerender({ up: true });
    expect(result.current).toBe(false);
    rerender({ up: false });
    expect(result.current).toBe(true);
  });

  it("names the refresh interval", () => {
    render(<RealtimeBanner degraded refreshSeconds={60} />);
    expect(screen.getByText(/Live updates paused — refreshing every 60 s/)).toBeTruthy();
  });
});

describe("access ended while a conversation is open", () => {
  it("says so without leaking the title", async () => {
    const session: Session = {
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organizationName: "North Hospice",
    };
    const api = {
      GET: vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/v1/messaging/channels"
            ? {
                data: {
                  channels: [
                    {
                      channelId: "dm-1",
                      kind: "dm",
                      title: "Secret Name",
                      subjectId: null,
                      archivedAt: null,
                      unreadCount: 0,
                      participantRoles: [],
                      lastActivityAt: "2026-10-09T10:00:00.000Z",
                      lastMessage: null,
                    },
                  ],
                },
                error: undefined,
              }
            : { data: undefined, error: { message: "forbidden" } },
        ),
      ),
      POST: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={session}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText("You no longer have access to this conversation")).toBeTruthy(),
    );
    // announced and focused, so a keyboard / screen-reader user is not dropped on <body> in silence
    const notice = screen.getByRole("status", { name: /no longer have access/i });
    expect(document.activeElement).toBe(notice);
    expect(screen.queryByText(/Secret Name/)).toBeNull();
  });
});

describe("access-ended notice does not outlive the revocation", () => {
  it("clears when another conversation is opened", async () => {
    const session: Session = {
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organizationName: "North Hospice",
    };
    const row = (channelId: string, title: string, at: string) => ({
      channelId,
      kind: "dm",
      title,
      subjectId: null,
      archivedAt: null,
      unreadCount: 0,
      participantRoles: [],
      lastActivityAt: at,
      lastMessage: null,
    });
    const api = {
      GET: vi.fn((path: string, init?: { params?: { path?: { id?: string } } }) =>
        Promise.resolve(
          path === "/api/v1/messaging/channels"
            ? {
                data: {
                  channels: [
                    row("dm-1", "First", "2026-10-09T10:00:00.000Z"),
                    row("dm-2", "Second", "2026-10-09T09:00:00.000Z"),
                  ],
                },
                error: undefined,
              }
            : init?.params?.path?.id === "dm-1"
              ? { data: undefined, error: { message: "forbidden" } }
              : { data: { messages: [] }, error: undefined },
        ),
      ),
      POST: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={session}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText("You no longer have access to this conversation");
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    await screen.findByRole("region", { name: /Conversation with Second/ });
    expect(screen.queryByText("You no longer have access to this conversation")).toBeNull();
  });
});

describe("access-ended notice on narrow screens (WP 2.11 D2)", () => {
  it("keeps the active pane showing the notice, and Back returns to the inbox", async () => {
    const session: Session = {
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organizationName: "North Hospice",
    };
    const api = {
      GET: vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/v1/messaging/channels"
            ? {
                data: {
                  channels: [
                    {
                      channelId: "dm-1",
                      kind: "dm",
                      title: "First",
                      subjectId: null,
                      archivedAt: null,
                      unreadCount: 0,
                      participantRoles: [],
                      lastActivityAt: "2026-10-09T10:00:00.000Z",
                      lastMessage: null,
                    },
                  ],
                },
                error: undefined,
              }
            : { data: undefined, error: { message: "forbidden" } },
        ),
      ),
      POST: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
    } as unknown as ApiClient;
    const { container } = render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={session}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText("You no longer have access to this conversation");
    // The <768px CSS hides the inbox on `.access-ended` and the active pane only without it.
    const layout = container.querySelector(".wx-messaging-layout");
    expect(layout?.classList.contains("access-ended")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    expect(screen.queryByText("You no longer have access to this conversation")).toBeNull();
    expect(layout?.classList.contains("access-ended")).toBe(false);
    // Focus must land on a stable inbox target, not fall to <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Conversations" }));
  });

  it("sizes the inbox header actions with the Button's own size prop (inline styles beat CSS)", async () => {
    const api = {
      GET: vi.fn(() => Promise.resolve({ data: { channels: [] }, error: undefined })),
      POST: vi.fn(),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider
            session={{ userId: "u", organizationId: "o", organizationName: "N" } as Session}
          >
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    for (const name of ["New conversation", "Scheduled messages"]) {
      const button = await screen.findByRole("button", { name });
      expect(Number.parseFloat(button.style.minHeight)).toBeGreaterThanOrEqual(2.75);
    }
  });

  it("does not nest a second main landmark", () => {
    const { container } = render(
      <MemoryRouter>
        <ApiClientProvider
          client={
            {
              GET: vi.fn(() => Promise.resolve({ data: { channels: [] } })),
            } as unknown as ApiClient
          }
        >
          <SessionProvider
            session={{ userId: "u", organizationId: "o", organizationName: "N" } as Session}
          >
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    expect(container.querySelector("main")).toBeNull();
  });
});
