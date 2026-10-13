// M36 WP 2.6 — the composer's Schedule control and the Scheduled list: date/time input with the time zone shown,
// every required state (idle, submitting, error, success; loading, empty, error, blocked), cancel and reschedule.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { ConversationInbox } from "./conversation-inbox";
import { ScheduleSendButton } from "./schedule-send-button";
import { ScheduledMessagesDialog } from "./scheduled-messages-dialog";
import { toLocalInputValue } from "./scheduled-send-utils";

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

// Dates are relative to now: the picker only offers the next 30 days, so a fixed calendar date goes stale.
const DAY_MS = 86_400_000;
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);
const inputIn = (days: number): string => toLocalInputValue(inDays(days));

const pending = {
  id: "s-1",
  channelId: CH,
  parentMessageId: null,
  body: "Please call the family at noon",
  scheduledFor: inDays(5).toISOString(),
  timeZone: "America/Chicago",
  status: "pending" as const,
  blockedReason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const blocked = {
  ...pending,
  id: "s-2",
  body: "Second one",
  status: "blocked" as const,
  blockedReason: "not_member" as const,
};

describe("ScheduleSendButton", () => {
  it("is at least 44px tall through the Button size (inline styles beat any stylesheet rule)", () => {
    render(
      provide(api({}), <ScheduleSendButton channelId={CH} text="hi" onScheduled={() => {}} />),
    );
    const button = screen.getByRole("button", { name: /schedule send/i });
    expect(Number.parseFloat(button.style.minHeight)).toBeGreaterThanOrEqual(2.75);
  });

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
    expect(within(dialog).getByText(/pick a date and time/i)).toBeTruthy();
    await userEvent.type(input, inputIn(3));
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
    expect(client.DELETE).not.toHaveBeenCalled(); // an inline confirm comes first
    await userEvent.click(screen.getByRole("button", { name: /yes, cancel it/i }));
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
    await userEvent.type(input, inputIn(6));
    await userEvent.click(screen.getByRole("button", { name: /save time/i }));
    await waitFor(() => expect(screen.queryByText(/no longer a member/i)).toBeNull());
    const [path, init] = client.PATCH.mock.calls[0] as [string, Json];
    expect(path).toBe("/api/v1/messaging/scheduled-messages/{id}");
    expect(init.params.path.id).toBe("s-2");
    expect(new Date(init.body.scheduledFor).getTime()).toBeGreaterThan(Date.now());
  });
});

const POST_REFUSED = (status: number, code = "X") => ({
  data: undefined,
  error: { error: { code, message: "no" } },
  response: { status },
});

async function openDialog(client: ReturnType<typeof api>, extra: Json = {}) {
  render(
    provide(
      client,
      <ScheduleSendButton channelId={CH} text="hello" onScheduled={() => {}} {...extra} />,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: /schedule send/i }));
  return screen.getByRole("dialog");
}
const keyOf = (client: ReturnType<typeof api>, call: number): string =>
  (client.POST.mock.calls[call] as [string, Json])[1].params.header["Idempotency-Key"];

describe("fix round 1: schedule dialog", () => {
  it("M2: warns that mentions will not notify when the draft carries mentions", async () => {
    const dialog = await openDialog(api({}), { hasMentions: true });
    expect(within(dialog).getByText(/mentions won't notify/i)).toBeTruthy();
  });

  it("M2: no mention warning without mentions", async () => {
    const dialog = await openDialog(api({}));
    expect(within(dialog).queryByText(/mentions won't notify/i)).toBeNull();
  });

  it("M5: the idempotency key is reused after a 502 and rotated after a 422", async () => {
    const answers = [POST_REFUSED(502), POST_REFUSED(502), POST_REFUSED(422), POST_REFUSED(422)];
    const client = api({ POST: () => answers.shift() });
    const dialog = await openDialog(client);
    const submit = () =>
      userEvent.click(within(dialog).getByRole("button", { name: /^schedule$/i }));
    await submit();
    await screen.findByRole("alert");
    await submit();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(keyOf(client, 1)).toBe(keyOf(client, 0));
    await submit(); // third: 422
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(3));
    expect(keyOf(client, 2)).toBe(keyOf(client, 0)); // the 502 did not rotate it
    await submit(); // fourth, after the definite refusal
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(4));
    expect(keyOf(client, 3)).not.toBe(keyOf(client, 2));
  });

  it("M6: a past time is refused with a message and nothing is sent", async () => {
    const client = api({});
    const dialog = await openDialog(client);
    const input = within(dialog).getByLabelText(/send at/i);
    await userEvent.clear(input);
    await userEvent.type(input, toLocalInputValue(new Date(Date.now() - 3_600_000)));
    expect(within(dialog).getByText(/at least a couple of minutes/i)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: /^schedule$/i }));
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("M6: more than 30 days ahead is refused with a message", async () => {
    const dialog = await openDialog(api({}));
    const input = within(dialog).getByLabelText(/send at/i);
    await userEvent.clear(input);
    await userEvent.type(input, inputIn(45));
    expect(within(dialog).getByText(/within the next 30 days/i)).toBeTruthy();
  });

  it("M6: a time that went stale while the dialog sat open is refused at submit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = api({});
      const dialog = await openDialog(client);
      vi.setSystemTime(Date.now() + 2 * 3_600_000); // the suggested hour-ahead default is now in the past
      await userEvent.click(within(dialog).getByRole("button", { name: /^schedule$/i }));
      expect(await within(dialog).findByText(/at least a couple of minutes/i)).toBeTruthy();
      expect(client.POST).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("M8: after scheduling, focus returns to the composer", async () => {
    const client = api({ POST: () => ({ data: pending, error: undefined }) });
    render(
      provide(
        client,
        <>
          <textarea aria-label="Message" id="messaging-composer" />
          <ScheduleSendButton
            channelId={CH}
            text="hello"
            onScheduled={() => {}}
            focusTargetId="messaging-composer"
          />
        </>,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /schedule send/i }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^schedule$/i }),
    );
    await waitFor(() => expect(document.activeElement?.id).toBe("messaging-composer"));
  });
});

describe("fix round 1: scheduled list", () => {
  const channelName = (id: string) => (id === CH ? "Care team" : "Unknown conversation");
  const list = (items: unknown[], extra: Json = {}) =>
    api({ GET: () => ({ data: { scheduledMessages: items }, error: undefined }), ...extra });
  const mount = (client: ReturnType<typeof api>) =>
    render(
      provide(
        client,
        <ScheduledMessagesDialog open onClose={() => {}} channelName={channelName} />,
      ),
    );

  it("M7: rescheduling a blocked (past-time) row seeds a valid future time", async () => {
    const past = { ...blocked, scheduledFor: new Date(Date.now() - 3_600_000).toISOString() };
    mount(list([past]));
    await userEvent.click(await screen.findByRole("button", { name: /reschedule to retry/i }));
    const input = screen.getByLabelText(/new time/i) as HTMLInputElement;
    expect(input.value >= input.min && input.value <= input.max).toBe(true);
  });

  it("M8: row buttons name the conversation and the time", async () => {
    mount(list([pending]));
    const button = await screen.findByRole("button", { name: /^reschedule/i });
    expect(button.getAttribute("aria-label")).toMatch(/Care team/);
    const cancel = screen.getByRole("button", { name: /cancel scheduled message/i });
    expect(cancel.getAttribute("aria-label")).toMatch(/Care team/);
  });

  it("M8: Keep it leaves the row, and after a confirmed cancel focus moves to the next row", async () => {
    const second = { ...pending, id: "s-9", body: "Another" };
    mount(
      list([pending, second], { DELETE: () => ({ data: { cancelled: true }, error: undefined }) }),
    );
    await userEvent.click(
      (await screen.findAllByRole("button", { name: /cancel scheduled message/i }))[0]!,
    );
    await userEvent.click(screen.getByRole("button", { name: /keep it/i }));
    expect(screen.getByText("Please call the family at noon")).toBeTruthy();
    await userEvent.click(screen.getAllByRole("button", { name: /cancel scheduled message/i })[0]!);
    await userEvent.click(screen.getByRole("button", { name: /yes, cancel it/i }));
    await waitFor(() => expect(screen.queryByText("Please call the family at noon")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.closest("li")?.textContent).toContain("Another"),
    );
  });

  it("M8: after Keep current time focus returns to the row's Reschedule button", async () => {
    mount(list([pending]));
    await userEvent.click(await screen.findByRole("button", { name: /^reschedule/i }));
    await userEvent.click(screen.getByRole("button", { name: /keep current time/i }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Reschedule/),
    );
  });
});

describe("fix round 2: scheduled UI", () => {
  const channelName = (id: string) => (id === CH ? "Care team" : "Unknown conversation");
  const list = (items: unknown[], extra: Json = {}) =>
    api({ GET: () => ({ data: { scheduledMessages: items }, error: undefined }), ...extra });
  const mount = (client: ReturnType<typeof api>) =>
    render(
      provide(
        client,
        <ScheduledMessagesDialog open onClose={() => {}} channelName={channelName} />,
      ),
    );

  it("R1: entering the cancel confirm focuses 'Yes, cancel it'; entering edit focuses the time input", async () => {
    mount(list([pending]));
    await userEvent.click(await screen.findByRole("button", { name: /cancel scheduled message/i }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /yes, cancel it/i }));
    await userEvent.click(screen.getByRole("button", { name: /keep it/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^reschedule/i }));
    expect(document.activeElement).toBe(screen.getByLabelText(/new time/i));
  });

  it("round 3: leaving the confirm (Keep it) or the editor (Save time) lands on the row's Reschedule button, not body", async () => {
    const moved = { ...pending, scheduledFor: inDays(6).toISOString() };
    mount(list([pending], { PATCH: () => ({ data: moved, error: undefined }) }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel scheduled message/i }));
    await userEvent.click(screen.getByRole("button", { name: /keep it/i }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Reschedule/),
    );
    await userEvent.click(screen.getByRole("button", { name: /^reschedule/i }));
    const input = screen.getByLabelText(/new time/i);
    await userEvent.clear(input);
    await userEvent.type(input, inputIn(6));
    await userEvent.click(screen.getByRole("button", { name: /save time/i }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Reschedule/),
    );
  });

  it("round 3: saving a time that moves the row down the list keeps focus on that row's Reschedule button", async () => {
    const other = {
      ...pending,
      id: "s-7",
      body: "Later one",
      scheduledFor: inDays(7).toISOString(),
    };
    const moved = { ...pending, scheduledFor: inDays(20).toISOString() };
    mount(list([pending, other], { PATCH: () => ({ data: moved, error: undefined }) }));
    const first = (await screen.findAllByRole("button", { name: /^reschedule/i }))[0]!;
    await userEvent.click(first);
    const input = screen.getByLabelText(/new time/i);
    await userEvent.clear(input);
    await userEvent.type(input, inputIn(20));
    await userEvent.click(screen.getByRole("button", { name: /save time/i }));
    await waitFor(() => {
      const active = document.activeElement as HTMLElement;
      expect(active.getAttribute("aria-label")).toMatch(/^Reschedule/);
      expect(active.closest("li")?.textContent).toContain("Please call the family");
    });
  });

  it("R2/R4: a stale time at Save is reported as an alert, and a past time shows its reason on the input", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = list([pending], { PATCH: () => ({ data: pending, error: undefined }) });
      mount(client);
      await userEvent.click(await screen.findByRole("button", { name: /^reschedule/i }));
      const input = screen.getByLabelText(/new time/i);
      expect(input.getAttribute("aria-describedby")).toBeNull();
      await userEvent.clear(input);
      await userEvent.type(input, toLocalInputValue(new Date(Date.now() - 3_600_000)));
      expect((await screen.findByRole("alert")).textContent).toMatch(
        /at least a couple of minutes/i,
      );
      expect(input.getAttribute("aria-describedby")).toBeTruthy();
      // Valid now, stale by the time Save is pressed.
      await userEvent.clear(input);
      await userEvent.type(input, inputIn(1));
      vi.setSystemTime(Date.now() + 2 * DAY_MS);
      await userEvent.click(screen.getByRole("button", { name: /save time/i }));
      expect((await screen.findByRole("alert")).textContent).toMatch(
        /at least a couple of minutes/i,
      );
      expect(client.PATCH).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R3: closing and reopening the dialog after an ambiguous 502 reuses the Idempotency-Key", async () => {
    const answers = [POST_REFUSED(502), POST_REFUSED(502)];
    const client = api({ POST: () => answers.shift() });
    const dialog = await openDialog(client);
    await userEvent.click(within(dialog).getByRole("button", { name: /^schedule$/i }));
    await screen.findByRole("alert");
    await userEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await userEvent.click(screen.getByRole("button", { name: /schedule send/i }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^schedule$/i }),
    );
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(keyOf(client, 1)).toBe(keyOf(client, 0));
  });

  it("R4: a submit-time refusal is announced as an alert in the create dialog", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const dialog = await openDialog(api({}));
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      await userEvent.click(within(dialog).getByRole("button", { name: /^schedule$/i }));
      expect((await within(dialog).findByRole("alert")).textContent).toMatch(
        /at least a couple of minutes/i,
      );
    } finally {
      vi.useRealTimers();
    }
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
        errorCorrelationId={null}
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
