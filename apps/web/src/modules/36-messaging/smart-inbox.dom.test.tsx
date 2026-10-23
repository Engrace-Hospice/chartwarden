// M36 WP 6.1 (ADR-0091) - the work inbox screen: loading, rows in the server's band order with the server's reason, restricted rows with no
// link, flag off, empty, error with retry, a missing source and an incomplete urgent list said in words, no write controls, axe clean.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SmartInboxItemDto, SmartInboxResponse } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmartInbox } from "./smart-inbox";
import {
  INBOX_DENIED,
  INBOX_EMPTY_TITLE,
  INBOX_LOAD_FAILED,
  INBOX_OFF_TITLE,
  INBOX_INCOMPLETE,
  INBOX_STALE,
  INBOX_URGENT_INCOMPLETE,
  SOURCE_UNAVAILABLE,
} from "./smart-inbox-wording";

const item = (over: Partial<SmartInboxItemDto>): SmartInboxItemDto => ({
  key: "ack:1",
  band: "urgent_ack",
  rank: 1,
  title: "Acknowledgment request",
  reasons: [{ code: "ack_overdue", text: "Past its deadline by 10 min." }],
  since: "2026-10-23T11:00:00.000Z",
  due_at: "2026-10-23T11:50:00.000Z",
  channel_id: "c1",
  target: "acknowledgment_request",
  target_id: "a1",
  restricted: false,
  count: null,
  ...over,
});

const inbox = (over: Partial<SmartInboxResponse> = {}): SmartInboxResponse => ({
  enabled: true,
  items: [
    item({}),
    item({
      key: "task:1",
      band: "task_assigned",
      rank: 2,
      title: "Task assigned to you",
      reasons: [{ code: "task_open", text: "Assigned to you and still open." }],
      target: "task",
    }),
  ],
  band_counts: {
    urgent_ack: 1,
    handoff_awaiting: 0,
    task_assigned: 1,
    mention: 0,
    care_team_unread: 0,
  },
  complete: true,
  urgent_complete: true,
  unavailable_sources: [],
  ...over,
});

const EMPTY_COUNTS = { urgent_ack: 0, handoff_awaiting: 0, task_assigned: 0, mention: 0, care_team_unread: 0 };

function mount(handler: () => unknown) {
  const GET = vi.fn((..._args: unknown[]) => Promise.resolve(handler()));
  const writes = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const view = render(
    <MemoryRouter>
      <ApiClientProvider
        client={
          { GET, POST: writes[0], PUT: writes[1], PATCH: writes[2], DELETE: writes[3] } as unknown as ApiClient
        }
      >
        <main>
          <SmartInbox />
        </main>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, writes, ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SmartInbox", () => {
  it("shows rows in the server's band order, each with its reason, and no write control", async () => {
    const { GET, writes } = mount(() => ({ data: inbox() }));
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(await screen.findByText("Past its deadline by 10 min.")).toBeTruthy();
    expect(screen.getByText("Assigned to you and still open.")).toBeTruthy();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toContain("Urgent");
    expect(headings[1]).toContain("Tasks");
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/messaging/inbox",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /acknowledge|accept|complete/i })).toBeNull();
  });

  it("gives a restricted request no link", async () => {
    mount(() => ({
      data: inbox({
        items: [item({ restricted: true, channel_id: null, target_id: null })],
        band_counts: { urgent_ack: 1, handoff_awaiting: 0, task_assigned: 0, mention: 0, care_team_unread: 0 },
      }),
    }));
    await screen.findByText(/cannot open this conversation/i);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says the feature is off, never an empty list", async () => {
    mount(() => ({ data: inbox({ enabled: false, items: [] }) }));
    expect(await screen.findByText(INBOX_OFF_TITLE)).toBeTruthy();
  });

  it("says nothing is waiting only when every source was read", async () => {
    mount(() => ({ data: inbox({ items: [], band_counts: { urgent_ack: 0, handoff_awaiting: 0, task_assigned: 0, mention: 0, care_team_unread: 0 } }) }));
    expect(await screen.findByText(INBOX_EMPTY_TITLE)).toBeTruthy();
  });

  it("names a source that failed to read instead of showing a quiet inbox", async () => {
    mount(() => ({
      data: inbox({ items: [], unavailable_sources: ["urgent_ack"], urgent_complete: false }),
    }));
    expect(await screen.findByText(SOURCE_UNAVAILABLE("urgent_ack"))).toBeTruthy();
    expect(screen.getByText(INBOX_URGENT_INCOMPLETE)).toBeTruthy();
    expect(screen.queryByText(INBOX_EMPTY_TITLE)).toBeNull();
  });

  it("shows an error with a retry that reads again", async () => {
    let calls = 0;
    const { GET } = mount(() => {
      calls += 1;
      return calls === 1 ? { error: {}, response: { status: 500 } } : { data: inbox() };
    });
    expect(await screen.findByText(INBOX_LOAD_FAILED)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Past its deadline by 10 min.");
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("fails closed on 403 with no retry", async () => {
    const { GET } = mount(() => ({ error: {}, response: { status: 403 } }));
    expect(await screen.findByText(INBOX_DENIED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
  });

  it("never reads a partial or failed read as an empty queue", async () => {
    const cases: Array<[string, Partial<SmartInboxResponse>, string]> = [
      ["not complete", { complete: false }, INBOX_INCOMPLETE],
      ["urgent not complete", { urgent_complete: false }, INBOX_URGENT_INCOMPLETE],
      [
        "a source unavailable",
        { unavailable_sources: ["task_assigned"] },
        SOURCE_UNAVAILABLE("task_assigned"),
      ],
    ];
    for (const [, over, warning] of cases) {
      const view = mount(() => ({ data: inbox({ items: [], band_counts: EMPTY_COUNTS, ...over }) }));
      expect(await screen.findByText(warning)).toBeTruthy();
      expect(screen.queryByText(INBOX_EMPTY_TITLE)).toBeNull();
      view.unmount();
    }
  });

  it("gives each open link the row's title and the conversation it carries", async () => {
    mount(() => ({
      data: inbox({
        items: [
          item({ key: "a", title: "First request", channel_id: "chan 1" }),
          item({ key: "b", band: "handoff_awaiting", rank: 2, title: "A handoff", channel_id: null, target: "handoff" }),
        ],
      }),
    }));
    const first = await screen.findByRole("link", { name: "Open in Messaging First request" });
    expect(first.getAttribute("href")).toBe("/messaging?channelId=chan+1");
    const second = screen.getByRole("link", { name: "Open in Messaging A handoff" });
    expect(second.getAttribute("href")).toBe("/messaging");
    expect(screen.getAllByText("Rank")).toHaveLength(2);
  });

  it("keeps the last answer and says it may be stale when a refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let calls = 0;
    mount(() => (++calls === 1 ? { data: inbox() } : { error: {}, response: { status: 500 } }));
    await act(async () => {});
    expect(screen.getByText("Past its deadline by 10 min.")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText(INBOX_STALE)).toBeTruthy();
    expect(screen.getByText("Past its deadline by 10 min.")).toBeTruthy();
    vi.useRealTimers();
  });

  it("drops an older read that lands after a newer one", async () => {
    const pending: Array<(v: unknown) => void> = [];
    const GET = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    render(
      <MemoryRouter>
        <ApiClientProvider client={{ GET } as unknown as ApiClient}>
          <SmartInbox />
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => window.dispatchEvent(new Event("focus"))); // a second read starts while the first is in flight
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]?.({ data: inbox({ items: [item({ title: "Newer answer" })] }) });
    });
    await act(async () => {
      pending[0]?.({ data: inbox({ items: [item({ title: "Older answer" })] }) });
    });
    expect(screen.getAllByText("Newer answer").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Older answer")).toHaveLength(0);
  });

  it("stops the poll and aborts the read on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal: AbortSignal | undefined;
    const GET = vi.fn((_p: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return Promise.resolve({ data: inbox() });
    });
    const view = render(
      <MemoryRouter>
        <ApiClientProvider client={{ GET } as unknown as ApiClient}>
          <SmartInbox />
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await act(async () => {});
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(GET).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("clears the previous user's inbox and a 403 when the API client changes", async () => {
    const first = { GET: vi.fn(() => Promise.resolve({ error: {}, response: { status: 403 } })) };
    let release: (v: unknown) => void = () => {};
    const second = { GET: vi.fn(() => new Promise((resolve) => { release = resolve; })) };
    const tree = (c: unknown) => (
      <MemoryRouter>
        <ApiClientProvider client={c as ApiClient}>
          <SmartInbox />
        </ApiClientProvider>
      </MemoryRouter>
    );
    const view = render(tree(first));
    expect(await screen.findByText(INBOX_DENIED)).toBeTruthy();
    view.rerender(tree(second));
    expect(screen.queryByText(INBOX_DENIED)).toBeNull(); // the old denial is gone while the new read is pending
    await waitFor(() => expect(second.GET).toHaveBeenCalledTimes(1)); // and the new client is actually read
    await act(async () => release({ data: inbox() }));
    expect(await screen.findByText("Past its deadline by 10 min.")).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { container } = mount(() => ({ data: inbox() }));
    await screen.findByText("Past its deadline by 10 min.");
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});
