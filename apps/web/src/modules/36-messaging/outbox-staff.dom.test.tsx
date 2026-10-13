/**
 * The offline outbox through the REAL StaffMessaging tree (production keys: the thread is `key`ed per channel and
 * unmounts on every switch). The queue must live above it.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const MESSAGES = "/api/v1/messaging/channels/{id}/messages";
const OFFLINE = "offline" as const;
type Step = typeof OFFLINE | Record<string, unknown> | Promise<unknown>;

const channel = (channelId: string, title: string) => ({
  channelId,
  kind: "dm",
  title,
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
});
const ok = (messageId: string, channelId = "dm-1") => ({
  data: { messageId, channelId, createdAt: "2026-10-10T10:00:00.000Z" },
  error: undefined,
  response: { status: 200 },
});

function mountStaff(...steps: Step[]) {
  const queue = [...steps];
  // What the server holds: a delivered message comes back when its channel is loaded again.
  const served: Record<string, unknown>[] = [];
  const api = {
    GET: vi.fn((path: string, init?: { params?: { path?: { id?: string } } }) =>
      Promise.resolve(
        path === "/api/v1/messaging/channels"
          ? {
              data: { channels: [channel("dm-1", "Nurse One"), channel("dm-2", "Nurse Two")] },
              error: undefined,
            }
          : {
              data: { messages: served.filter((m) => m.channelId === init?.params?.path?.id) },
              error: undefined,
            },
      ),
    ),
    POST: vi.fn((path: string, init: Record<string, any>) => {
      if (path !== MESSAGES) return Promise.resolve({ data: {}, error: undefined });
      const step = queue.shift();
      if (step === OFFLINE) return Promise.reject(new TypeError("Failed to fetch"));
      const reply = Promise.resolve(step ?? ok("m-default"));
      reply.then(
        (value: any) => {
          if (!value?.data?.messageId) return;
          served.push({
            messageId: value.data.messageId,
            channelId: init.params.path.id,
            authorUserId: SESSION.userId,
            authorDisplayName: "You",
            body: init.body.body,
            bodyKind: "plain",
            createdAt: value.data.createdAt,
            parentMessageId: null,
            references: [],
            attachments: [],
          });
        },
        () => {},
      );
      return reply;
    }),
  };
  render(
    <MemoryRouter>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <SessionProvider session={SESSION}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return api;
}

const open = async (title: string) => {
  fireEvent.click(await screen.findByRole("button", { name: title }));
  await screen.findByRole("region", { name: `Conversation with ${title}` });
};
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const send = async (value: string) => {
  fireEvent.change(box(), { target: { value } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  });
};
const posts = (api: ReturnType<typeof mountStaff>) =>
  api.POST.mock.calls.filter(([path]) => path === MESSAGES) as unknown as [
    string,
    Record<string, any>,
  ][];
const guardActive = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

afterEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

describe("the outbox across channel switches (production keys)", () => {
  it("keeps a queued message when the user opens another channel and comes back, and retries it with the same key", async () => {
    const api = mountStaff(OFFLINE, ok("m-1"));
    await open("Nurse One");
    await send("hello team");
    await screen.findByText("Not sent");

    await open("Nurse Two");
    expect(screen.queryByText("Not sent")).toBeNull();
    await open("Nurse One");
    expect(await screen.findByText("Not sent")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(posts(api)).toHaveLength(2);
    expect(document.querySelector('[data-message-id="m-1"]')?.textContent).toContain("hello team");
    const [first, second] = posts(api);
    expect(second![1].params.header["Idempotency-Key"]).toBe(
      first![1].params.header["Idempotency-Key"],
    );
    expect(second![1].body.clientMessageId).toBe(first![1].body.clientMessageId);
  });

  it("drains dm-1's message on online while dm-2 is open, without merging it into dm-2", async () => {
    const api = mountStaff(OFFLINE, ok("m-A", "dm-1"));
    await open("Nurse One");
    await send("hello team");
    await screen.findByText("Not sent");
    await open("Nurse Two");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(posts(api)).toHaveLength(2));
    expect(posts(api)[1]![1].params.path.id).toBe("dm-1");
    await waitFor(() => expect(guardActive()).toBe(false));
    expect(document.querySelector('[data-message-id="m-A"]')).toBeNull();
    expect(screen.queryByText("hello team")).toBeNull();
    await open("Nurse One");
    expect(screen.queryByText("Not sent")).toBeNull();
  });

  it("keeps the beforeunload guard registered across the switch", async () => {
    mountStaff(OFFLINE);
    await open("Nurse One");
    await send("hello team");
    await screen.findByText("Not sent");
    expect(guardActive()).toBe(true);

    await open("Nurse Two");

    expect(guardActive()).toBe(true);
  });

  it("lets a retry that is in flight finish after the user left the channel", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const api = mountStaff(OFFLINE, gate);
    await open("Nurse One");
    await send("hello team");
    await screen.findByText("Not sent");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });
    await open("Nurse Two");

    await act(async () => {
      release(ok("m-1"));
    });

    await waitFor(() => expect(guardActive()).toBe(false));
    expect(posts(api)).toHaveLength(2);
    await open("Nurse One");
    expect(await screen.findByText("hello team")).toBeTruthy();
    expect(screen.queryByText("Not sent")).toBeNull();
  });

  it("queues a send that fails offline after the user already switched channel", async () => {
    let fail!: () => void;
    const gate = new Promise((_resolve, reject) => {
      fail = () => reject(new TypeError("Failed to fetch"));
    });
    const api = mountStaff(gate);
    await open("Nurse One");
    await send("hello team");
    await open("Nurse Two");
    fireEvent.change(box(), { target: { value: "draft for two" } });

    await act(async () => {
      fail();
    });

    expect(box().value).toBe("draft for two");
    expect(posts(api)).toHaveLength(1);
    await open("Nurse One");
    expect(await screen.findByText("Not sent")).toBeTruthy();
    expect(screen.getByText("hello team")).toBeTruthy();
  });

  it("keeps the queue when Back returns to the conversation list on a narrow screen", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true,
      media: "(max-width: 767px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      mountStaff(OFFLINE);
      await open("Nurse One");
      await send("hello team");
      await screen.findByText("Not sent");

      fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));

      expect(screen.queryByRole("region", { name: "Conversation with Nurse One" })).toBeNull();
      expect(guardActive()).toBe(true);
      await open("Nurse One");
      expect(await screen.findByText("Not sent")).toBeTruthy();
    } finally {
      window.matchMedia = original;
    }
  });
});
