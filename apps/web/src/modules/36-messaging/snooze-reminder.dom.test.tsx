import { readFileSync } from "node:fs";
import { join } from "node:path";
// M36 WP 4.10 (ADR-0077): the header snooze control and the message "Remind me" control. A conversation that cannot be snoozed offers no
// button and says why; presets are within the hard bounds; every write carries an Idempotency-Key; focus returns to the trigger;
// results are announced; a refusal is words; nothing polls.
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SNOOZE_MAX_MINUTES, SNOOZE_MIN_MINUTES } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageReminderButton } from "./message-reminder-button";
import { MessageRow } from "./message-row";
import { SnoozeControl } from "./snooze-control";
import {
  SNOOZE_PRESETS,
  SNOOZE_UNSNOOZABLE_SHORT,
  SNOOZE_UNSNOOZABLE_TEXT,
  reminderPresets,
} from "./snooze-reminder-wording";
import { ThreadHeader } from "./thread-header";
import { useChannelSnooze } from "./use-channel-snooze";

const SNOOZE_PATH = "/api/v1/messaging/channels/{id}/snooze";
const REMINDERS_PATH = "/api/v1/messaging/reminders";
const REMINDER_PATH = "/api/v1/messaging/messages/{id}/reminder";
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const refusal = (status: number, code: string) => ({
  error: { error: { code } },
  response: { status },
});

function mount(
  ui: React.ReactNode,
  handlers: {
    GET?: (path: string) => unknown;
    PUT?: (path: string, init: any) => unknown;
    DELETE?: (path: string, init: any) => unknown;
  },
) {
  const GET = vi.fn((path: string) => Promise.resolve(handlers.GET?.(path)));
  const PUT = vi.fn((path: string, init: unknown) => Promise.resolve(handlers.PUT?.(path, init)));
  const DELETE = vi.fn((path: string, init: unknown) =>
    Promise.resolve(handlers.DELETE?.(path, init)),
  );
  const client = { GET, PUT, DELETE } as unknown as ApiClient;
  const view = render(<ApiClientProvider client={client}>{ui}</ApiClientProvider>);
  return { GET, PUT, DELETE, ...view };
}

afterEach(() => vi.restoreAllMocks());

describe("SnoozeControl", () => {
  const ready = (over: Record<string, unknown> = {}) => ({
    data: { channel_id: "c1", snoozed_until: null, snoozable: true, ...over },
  });

  it("renders nothing while the tenant has the feature off (404)", async () => {
    const { GET, container } = mount(<SnoozeControl channelId="c1" />, {
      GET: () => ({ error: {}, response: { status: 404 } }),
    });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("offers no snooze button for an urgent or response-required conversation, and explains why", async () => {
    const { PUT } = mount(<SnoozeControl channelId="c1" />, {
      GET: () => ready({ snoozable: false }),
    });
    expect(await screen.findByText(SNOOZE_UNSNOOZABLE_SHORT, { exact: false })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /snooze/i })).toBeNull();
    expect(document.body.textContent).toContain(SNOOZE_UNSNOOZABLE_TEXT);
    expect(PUT).not.toHaveBeenCalled();
  });

  it("every preset is within the hard bounds", () => {
    for (const preset of SNOOZE_PRESETS) {
      expect(preset.minutes).toBeGreaterThanOrEqual(SNOOZE_MIN_MINUTES);
      expect(preset.minutes).toBeLessThanOrEqual(SNOOZE_MAX_MINUTES);
    }
  });

  it("snoozes with the chosen length and an Idempotency-Key, announces it, and hands focus to the control", async () => {
    const until = iso(240 * 60_000);
    const { PUT } = mount(<SnoozeControl channelId="c1" />, {
      GET: () => ready(),
      PUT: () => ({ data: { channel_id: "c1", snoozed_until: until, snoozable: true } }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Snooze" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.body.textContent).toContain("urgent items always notify you");
    await userEvent.click(screen.getByRole("button", { name: "4 hours" }));
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    const [path, init] = PUT.mock.calls[0] as [string, any];
    expect(path).toBe(SNOOZE_PATH);
    expect(init.body).toEqual({ duration_minutes: 240 });
    expect(init.params.path).toEqual({ id: "c1" });
    expect(String(init.params.header["Idempotency-Key"]).length).toBeGreaterThan(8);
    expect(await screen.findByText(/Snoozed until/)).toBeTruthy();
    expect(await screen.findByText("Notifications snoozed.")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "End snooze" })),
    );
  });

  it("a typed refusal closes the dialog, keeps the words on screen and moves focus to the note (GET now says not snoozable)", async () => {
    const answers = [ready(), ready({ snoozable: false })];
    const { GET } = mount(<SnoozeControl channelId="c1" />, {
      GET: () => answers.shift() ?? ready({ snoozable: false }),
      PUT: () => refusal(409, "SNOOZE_URGENT_NOT_ALLOWED"),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Snooze" }));
    await userEvent.click(screen.getByRole("button", { name: "1 hour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(GET.mock.calls.length).toBeGreaterThanOrEqual(2));
    // the explanation survives the re-read in the live region and the visible text, and focus is on a real element
    expect(await screen.findByText(SNOOZE_UNSNOOZABLE_SHORT, { exact: false })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /snooze/i })).toBeNull();
    const live = document.querySelector("output[aria-live=polite]");
    expect(live?.textContent).toBe(SNOOZE_UNSNOOZABLE_TEXT);
    await waitFor(() =>
      expect(document.activeElement?.textContent ?? "").toContain(SNOOZE_UNSNOOZABLE_SHORT),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("a write that succeeds while a re-read overtook it still shows its result", async () => {
    let resolvePut: (v: unknown) => void = () => undefined;
    const putPromise = new Promise((r) => {
      resolvePut = r;
    });
    const until = iso(3_600_000);
    const GET = vi.fn(() => Promise.resolve(ready()));
    const PUT = vi.fn(() => putPromise);
    const client = { GET, PUT, DELETE: vi.fn() } as unknown as ApiClient;
    const { result } = renderHook(() => useChannelSnooze("c1"), {
      wrapper: ({ children }) => <ApiClientProvider client={client}>{children}</ApiClientProvider>,
    });
    await waitFor(() => expect(result.current.view.status).toBe("ready"));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.snooze(60, "k");
    });
    act(() => result.current.reload()); // a re-read starts (and bumps the generation) while the write is in flight
    await waitFor(() => expect(GET.mock.calls.length).toBeGreaterThanOrEqual(2));
    GET.mockResolvedValue({
      data: { channel_id: "c1", snoozed_until: until, snoozable: true },
    } as never);
    await act(async () => {
      resolvePut({ data: { channel_id: "c1", snoozed_until: until, snoozable: true } });
      await done;
    });
    await waitFor(() => {
      const v = result.current.view;
      expect(v.status === "ready" && v.snooze.snoozed_until).toBe(until);
    });
  });

  it("a failed re-read keeps the last good view (the control is not unmounted by a reload)", async () => {
    const answers: unknown[] = [ready(), { error: {}, response: { status: 500 } }];
    mount(<SnoozeControl channelId="c1" />, {
      GET: () => answers.shift() ?? { error: {}, response: { status: 500 } },
      PUT: () => refusal(422, "SNOOZE_DURATION_INVALID"),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Snooze" }));
    await userEvent.click(screen.getByRole("button", { name: "1 hour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Snooze" })).toBeTruthy();
    expect(document.querySelector("output[aria-live=polite]")?.textContent).toBe(
      "That did not work. Try again.",
    );
  });

  it("a rapid double click sends one request, and a retry of the same choice reuses its key", async () => {
    const keysSeen: string[] = [];
    const answers = [
      refusal(500, "X"),
      { data: { channel_id: "c1", snoozed_until: iso(3_600_000), snoozable: true } },
    ];
    const { PUT } = mount(<SnoozeControl channelId="c1" />, {
      GET: () => ready(),
      PUT: (_p, init) => {
        keysSeen.push(init.params.header["Idempotency-Key"]);
        return answers.shift();
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Snooze" }));
    const one = screen.getByRole("button", { name: "1 hour" });
    await userEvent.dblClick(one);
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // reopening is a new dialog: a new key
    await userEvent.click(await screen.findByRole("button", { name: "Snooze" }));
    await userEvent.click(screen.getByRole("button", { name: "1 hour" }));
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(2));
    expect(keysSeen[0]).not.toBe(keysSeen[1]);
  });

  it("a rejected client call renders nothing and does not throw", async () => {
    const GET = vi.fn(() => Promise.reject(new Error("network")));
    const client = { GET, PUT: vi.fn(), DELETE: vi.fn() } as unknown as ApiClient;
    const { container } = render(
      <ApiClientProvider client={client}>
        <SnoozeControl channelId="c1" />
      </ApiClientProvider>,
    );
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("a snooze that has already run out reads as not snoozed; an active one can be ended", async () => {
    const expired = mount(<SnoozeControl channelId="c1" />, {
      GET: () => ready({ snoozed_until: iso(-60_000) }),
    });
    expect(await screen.findByRole("button", { name: "Snooze" })).toBeTruthy();
    expect(screen.queryByText(/Snoozed until/)).toBeNull();
    expired.unmount();

    const { DELETE } = mount(<SnoozeControl channelId="c1" />, {
      GET: () => ready({ snoozed_until: iso(3_600_000) }),
      DELETE: () => ({ data: { cleared: true } }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "End snooze" }));
    await waitFor(() => expect(DELETE).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Snooze ended.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Snooze" })).toBeTruthy();
  });

  it("closes with Escape and returns focus; makes one read", async () => {
    const { GET } = mount(<SnoozeControl channelId="c1" />, { GET: () => ready() });
    const trigger = await screen.findByRole("button", { name: "Snooze" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(GET).toHaveBeenCalledTimes(1);
  });

  it("a failed read renders nothing (fail closed, no stray retry control in the header)", async () => {
    const { GET, container } = mount(<SnoozeControl channelId="c1" />, {
      GET: () => ({ error: {}, response: { status: 500 } }),
    });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
    expect(container.textContent).toBe("");
    // Not the snooze shape either (a harness that answers every path alike): nothing is shown.
    const odd = mount(<SnoozeControl channelId="c2" />, {
      GET: () => ({ data: { messages: [] } }),
    });
    await waitFor(() => expect(odd.GET).toHaveBeenCalledTimes(1));
    expect(odd.container.textContent).toBe("");
  });
});

describe("MessageReminderButton", () => {
  const list = (reminders: unknown[] = []) => ({ data: { reminders, max_pending: 25 } });

  it("renders nothing while reminders are off (404) and makes one list read", async () => {
    const { GET, container } = mount(<MessageReminderButton messageId="m1" />, {
      GET: () => ({ error: {}, response: { status: 404 } }),
    });
    await waitFor(() => expect(GET).toHaveBeenCalledWith(REMINDERS_PATH));
    expect(container.textContent).toBe("");
  });

  it("sets a reminder at the chosen time with an Idempotency-Key, announces it, and re-reads the list", async () => {
    const { PUT, GET } = mount(<MessageReminderButton messageId="m1" authorName="Nora" />, {
      GET: () => list(),
      PUT: () => ({
        data: { id: "r1", channel_id: "c1", message_id: "m1", remind_at: iso(3_600_000) },
      }),
    });
    const trigger = await screen.findByRole("button", { name: "Remind me, message from Nora" });
    await userEvent.click(trigger);
    expect(document.body.textContent).toContain("does not repeat the message");
    const before = Date.now();
    await userEvent.click(screen.getByRole("button", { name: "In 1 hour" }));
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    const [path, init] = PUT.mock.calls[0] as [string, any];
    expect(path).toBe(REMINDER_PATH);
    expect(init.params.path).toEqual({ id: "m1" });
    expect(String(init.params.header["Idempotency-Key"]).length).toBeGreaterThan(8);
    const at = Date.parse(init.body.remind_at);
    expect(at - before).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(at - before).toBeLessThanOrEqual(3_600_000 + 5_000);
    expect(init.body.remind_at).toMatch(/Z$/); // an absolute instant with an offset
    expect(await screen.findByText("Reminder set.")).toBeTruthy();
    await waitFor(() => expect(GET.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("shows an existing reminder and cancels it", async () => {
    const { DELETE } = mount(<MessageReminderButton messageId="m1" authorName="Nora" />, {
      GET: () =>
        list([{ id: "r1", channel_id: "c1", message_id: "m1", remind_at: iso(3_600_000) }]),
      DELETE: () => ({ data: { cleared: true } }),
    });
    expect(await screen.findByText(/^Reminder [A-Z][a-z]{2} \d/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel reminder, message from Nora" }),
    );
    await waitFor(() => expect(DELETE).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Reminder cancelled.")).toBeTruthy();
  });

  it("says in words why a reminder was refused", async () => {
    mount(<MessageReminderButton messageId="m1" />, {
      GET: () => list(),
      PUT: () => refusal(409, "REMINDER_URGENT_NOT_ALLOWED"),
    });
    await userEvent.click(await screen.findByRole("button", { name: /Remind me/ }));
    await userEvent.click(screen.getByRole("button", { name: "In 3 hours" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "A reminder cannot be set on an urgent or response-required message.",
    );
  });

  it("presets are all in the future, within 30 days, and 'tomorrow morning' is tomorrow", () => {
    const now = new Date(2026, 9, 18, 14, 30);
    const presets = reminderPresets(now);
    for (const preset of presets) {
      const ahead = preset.at.getTime() - now.getTime();
      expect(ahead).toBeGreaterThanOrEqual(60_000);
      expect(ahead).toBeLessThanOrEqual(30 * 24 * 3_600_000);
    }
    const tomorrow = presets.find((p) => p.id === "tomorrow")?.at as Date;
    expect([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([19, 9, 0]);
    // 08:59 the next morning is still before 09:00 tomorrow: the preset never lands in the past.
    expect(
      reminderPresets(new Date(2026, 9, 18, 23, 59))
        .find((p) => p.id === "tomorrow")
        ?.at.getDate(),
    ).toBe(19);
  });
});

describe("MessageReminderButton: a failed re-read after a successful write", () => {
  it("keeps the last good index (only a 404 means off)", async () => {
    const answers: unknown[] = [
      { data: { reminders: [], max_pending: 25 } },
      { error: {}, response: { status: 500 } },
    ];
    mount(<MessageReminderButton messageId="m1" authorName="Nora" />, {
      GET: () => answers.shift() ?? { error: {}, response: { status: 500 } },
      PUT: () => ({
        data: { id: "r1", channel_id: "c1", message_id: "m1", remind_at: iso(3_600_000) },
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: /Remind me/ }));
    await userEvent.click(screen.getByRole("button", { name: "In 1 hour" }));
    expect(await screen.findByText("Reminder set.")).toBeTruthy();
    // the re-read failed: the trigger is still there
    expect(screen.getByRole("button", { name: /Remind me/ })).toBeTruthy();
  });
});

describe("MessageReminderButton: optimistic fallback", () => {
  it("shows the chip from the known result when the re-read after a set fails", async () => {
    const answers: unknown[] = [
      { data: { reminders: [], max_pending: 25 } },
      { error: {}, response: { status: 500 } },
    ];
    mount(<MessageReminderButton messageId="m1" authorName="Nora" />, {
      GET: () => answers.shift() ?? { error: {}, response: { status: 500 } },
      PUT: () => ({
        data: { id: "r1", channel_id: "c1", message_id: "m1", remind_at: iso(3_600_000) },
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: /Remind me/ }));
    await userEvent.click(screen.getByRole("button", { name: "In 1 hour" }));
    expect(await screen.findByText(/^Reminder [A-Z][a-z]{2} \d/)).toBeTruthy();
  });
});

describe("where the controls appear (real renders)", () => {
  const baseMessage = {
    messageId: "m-1",
    channelId: "c-1",
    authorUserId: "u-2",
    authorDisplayName: "Nurse Two",
    body: "Situation: pain",
    bodyKind: "plain",
    createdAt: "2026-10-10T10:00:00.000Z",
    parentMessageId: null,
    references: [],
  };
  const row = (over: Record<string, unknown>) =>
    mount(
      <MemoryRouter>
        <MessageRow
          message={{ ...baseMessage, ...over } as never}
          previous={undefined}
          meId="u-1"
          anchorMessageId={null}
        />
      </MemoryRouter>,
      {
        GET: (path) =>
          path === REMINDERS_PATH
            ? { data: { reminders: [], max_pending: 25 } }
            : { error: {}, response: { status: 404 } },
      },
    );

  it("a routine message offers Remind me; an urgent or important one does not", async () => {
    const routine = row({});
    expect(await screen.findByRole("button", { name: /Remind me/ })).toBeTruthy();
    routine.unmount();
    for (const urgency of ["urgent", "important"]) {
      const view = row({ urgency });
      await waitFor(() => expect(view.GET).toHaveBeenCalled());
      expect(screen.queryByRole("button", { name: /Remind me/ })).toBeNull();
      view.unmount();
    }
  });

  it("the conversation header carries the snooze control for its channel", async () => {
    const { GET } = mount(
      <MemoryRouter>
        <ThreadHeader
          channel={{
            channelId: "c-9",
            kind: "dm",
            title: "T",
            subjectId: null,
            archivedAt: null,
            unreadCount: 0,
            mentionCount: 0,
            participantRoles: [],
            lastActivityAt: "2026-10-10T10:00:00.000Z",
            lastMessage: null,
          }}
          title="T"
          subtitle="s"
          patient={null}
          contextOpen={false}
          onBack={() => undefined}
          onToggleContext={() => undefined}
        />
      </MemoryRouter>,
      { GET: () => ({ data: { channel_id: "c-9", snoozed_until: null, snoozable: true } }) },
    );
    expect(await screen.findByRole("button", { name: "Snooze" })).toBeTruthy();
    expect(GET).toHaveBeenCalledWith(SNOOZE_PATH, { params: { path: { id: "c-9" } } });
  });

  it("nothing polls: no interval or timeout in the snooze or reminder code", () => {
    for (const file of [
      "use-channel-snooze.ts",
      "snooze-control.tsx",
      "message-reminder-button.tsx",
    ]) {
      expect(readFileSync(join(__dirname, file), "utf8"), file).not.toMatch(
        /setInterval|setTimeout|useLatestPolling/,
      );
    }
  });
});
