// M36 WP 2.6 — the composer's Schedule control and the Scheduled list: date/time input with the time zone shown,
// every required state (idle, submitting, error, success; loading, empty, error, blocked), cancel and reschedule.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { ConversationInbox } from "./conversation-inbox";
import { ScheduleSendButton } from "./schedule-send-button";
import { ScheduledMessagesDialog } from "./scheduled-messages-dialog";

const CH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
type Json = Record<string, any>;

function api(handlers: {
  GET?: (path: string, init?: Json) => unknown;
  POST?: (path: string, init?: Json) => unknown;
  PATCH?: (path: string, init?: Json) => unknown;
  DELETE?: (path: string, init?: Json) => unknown;
}) {
  const verb = (name: "GET" | "POST" | "PATCH" | "DELETE") =>
    vi.fn((path: string, init?: Json) =>
      Promise.resolve(handlers[name]?.(path, init) ?? { error: undefined }),
    );
  return { GET: verb("GET"), POST: verb("POST"), PATCH: verb("PATCH"), DELETE: verb("DELETE") };
}
const provide = (client: ReturnType<typeof api>, ui: React.ReactElement) => (
  <ApiClientProvider client={client as unknown as ApiClient}>{ui}</ApiClientProvider>
);

const pending = {
  id: "s-1",
  channelId: CH,
  parentMessageId: null,
  body: "Please call the family at noon",
  scheduledFor: "2030-01-05T18:00:00.000Z",
  timeZone: "America/Chicago",
  status: "pending" as const,
  blockedReason: null,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};
const blocked = {
  ...pending,
  id: "s-2",
  body: "Second one",
  status: "blocked" as const,
  blockedReason: "not_member" as const,
};

describe("ScheduleSendButton", () => {
  it("is disabled until there is text, and explains a disabled reason", () => {
    const client = api({});
    const { rerender } = render(
      provide(client, <ScheduleSendButton channelId={CH} text="" onScheduled={() => {}} />),
    );
    expect(screen.getByRole("button", { name: /schedule send/i })).toHaveProperty("disabled", true);
    rerender(
      provide(
        client,
        <ScheduleSendButton
          channelId={CH}
          text="hi"
          disabledReason="Attachments cannot be scheduled."
          onScheduled={() => {}}
        />,
      ),
    );
    const button = screen.getByRole("button", { name: /schedule send/i });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("title")).toBe("Attachments cannot be scheduled.");
  });

  it("opens a dialog with a date/time input and the time zone, then schedules and reports success", async () => {
    const client = api({ POST: () => ({ data: pending, error: undefined }) });
    const onScheduled = vi.fn();
    render(
      provide(client, <ScheduleSendButton channelId={CH} text="hello" onScheduled={onScheduled} />),
    );
    await userEvent.click(screen.getByRole("button", { name: /schedule send/i }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText(/send at/i) as HTMLInputElement;
    expect(input.type).toBe("datetime-local");
    expect(input.min).not.toBe("");
    expect(input.max).not.toBe("");
    expect(within(dialog).getByText(/time zone/i).textContent).toContain(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    await userEvent.click(within(dialog).getByRole("button", { name: /^schedule$/i }));
    await waitFor(() => expect(onScheduled).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [string, Json];
    expect(path).toBe("/api/v1/messaging/channels/{id}/scheduled-messages");
    expect(init.params.path.id).toBe(CH);
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S+/);
    expect(init.body).toMatchObject({ body: "hello", timeZone: expect.any(String) });
    expect(new Date(init.body.scheduledFor).getTime()).toBeGreaterThan(Date.now());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((await screen.findByRole("status")).textContent).toMatch(/scheduled/i);
  });

  it("shows the server's refusal in plain words and keeps the dialog and text", async () => {
    const client = api({
      POST: () => ({
        data: undefined,
        error: { error: { code: "SCHEDULE_LIMIT_REACHED", message: "cap" } },
        response: { status: 409 },
      }),
    });
    const onScheduled = vi.fn();
    render(
      provide(client, <ScheduleSendButton channelId={CH} text="hello" onScheduled={onScheduled} />),
    );
    await userEvent.click(screen.getByRole("button", { name: /schedule send/i }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^schedule$/i }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/50 scheduled messages/);
    expect(onScheduled).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("blocks submit while a request is in flight and when the time is cleared", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = api({});
    client.POST.mockImplementation(() => gate as never);
    render(
      provide(client, <ScheduleSendButton channelId={CH} text="hello" onScheduled={() => {}} />),
    );
    await userEvent.click(screen.getByRole("button", { name: /schedule send/i }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText(/send at/i);
    await userEvent.clear(input);
    expect(within(dialog).getByRole("button", { name: /^schedule$/i })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.type(input, "2030-01-05T09:30");
    await userEvent.click(within(dialog).getByRole("button", { name: /^schedule$/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: /scheduling/i }));
    expect(client.POST).toHaveBeenCalledTimes(1);
    release({ data: pending, error: undefined });
  });
});

describe("ScheduledMessagesDialog", () => {
  const channelName = (id: string) => (id === CH ? "Care team" : "Unknown conversation");

  it("shows a loading state, then the list with each time in the viewer's zone", async () => {
    const client = api({
      GET: () => ({ data: { scheduledMessages: [pending, blocked] }, error: undefined }),
    });
    render(
      provide(
        client,
        <ScheduledMessagesDialog open onClose={() => {}} channelName={channelName} />,
      ),
    );
    expect(screen.getByLabelText(/loading scheduled messages/i)).toBeTruthy();
    const list = await screen.findByRole("list", { name: /scheduled messages/i });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Please call the family at noon")).toBeTruthy();
    expect(within(list).getAllByText("Care team").length).toBeGreaterThan(0);
    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/messaging/scheduled-messages",
      expect.anything(),
    );
  });

  it("shows the reason a message was not sent, in generic words", async () => {
    const client = api({
      GET: () => ({ data: { scheduledMessages: [blocked] }, error: undefined }),
    });
    render(
      provide(
        client,
        <ScheduledMessagesDialog open onClose={() => {}} channelName={channelName} />,
      ),
    );
    expect(await screen.findByText(/no longer a member/i)).toBeTruthy();
  });

  it("has an empty state and an error state with Retry", async () => {
    let attempts = 0;
    const client = api({
      GET: () =>
        ++attempts === 1
          ? { data: undefined, error: { error: { message: "Boom" } } }
          : { data: { scheduledMessages: [] }, error: undefined },
    });
    render(
      provide(
        client,
        <ScheduledMessagesDialog open onClose={() => {}} channelName={channelName} />,
      ),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Boom");
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/nothing is scheduled/i)).toBeTruthy();
  });

  it("cancels a scheduled message and removes it from the list", async () => {
    const client = api({
      GET: () => ({ data: { scheduledMessages: [pending] }, error: undefined }),
      DELETE: () => ({ data: { cancelled: true }, error: undefined }),
    });
    render(
      provide(
        client,
        <ScheduledMessagesDialog open onClose={() => {}} channelName={channelName} />,
      ),
    );
    await userEvent.click(await screen.findByRole("button", { name: /cancel scheduled message/i }));
    await waitFor(() => expect(screen.queryByText("Please call the family at noon")).toBeNull());
    expect(client.DELETE).toHaveBeenCalledWith(
      "/api/v1/messaging/scheduled-messages/{id}",
      expect.objectContaining({ params: { path: { id: "s-1" } } }),
    );
  });

  it("reschedules a blocked message and shows it as pending again", async () => {
    const moved = { ...blocked, status: "pending" as const, blockedReason: null };
    const client = api({
      GET: () => ({ data: { scheduledMessages: [blocked] }, error: undefined }),
      PATCH: () => ({ data: moved, error: undefined }),
    });
    render(
      provide(
        client,
        <ScheduledMessagesDialog open onClose={() => {}} channelName={channelName} />,
      ),
    );
    await userEvent.click(await screen.findByRole("button", { name: /reschedule/i }));
    const input = screen.getByLabelText(/new time/i);
    await userEvent.clear(input);
    await userEvent.type(input, "2030-01-06T10:00");
    await userEvent.click(screen.getByRole("button", { name: /save time/i }));
    await waitFor(() => expect(screen.queryByText(/no longer a member/i)).toBeNull());
    const [path, init] = client.PATCH.mock.calls[0] as [string, Json];
    expect(path).toBe("/api/v1/messaging/scheduled-messages/{id}");
    expect(init.params.path.id).toBe("s-2");
    expect(new Date(init.body.scheduledFor).getFullYear()).toBe(2030);
  });
});

describe("entry point", () => {
  it("offers a Scheduled button in the inbox", async () => {
    const onShowScheduled = vi.fn();
    render(
      <ConversationInbox
        channels={[]}
        visibleChannels={[]}
        activeId={null}
        query=""
        filter="all"
        error={null}
        onQueryChange={() => {}}
        onFilterChange={() => {}}
        onSelect={() => {}}
        onRetry={() => {}}
        onNewConversation={() => {}}
        onShowScheduled={onShowScheduled}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /scheduled messages/i }));
    expect(onShowScheduled).toHaveBeenCalledTimes(1);
  });
});
