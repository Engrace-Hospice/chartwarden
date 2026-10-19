// M36 WP 4.9 (ADR-0076) - the supervisor's unacknowledged queue screen: loading, empty, error-with-retry, denied, a flat list with
// words for every state, a restricted row with no link or patient, filters that only narrow (the total stays), "show more", the
// safety-net poll (and its cleanup on unmount), no write of any kind, axe clean.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AckQueueItemDto, AckQueueResponse } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnacknowledgedQueue, threadLink } from "./unacknowledged-queue";
import {
  QUEUE_DENIED,
  QUEUE_EMPTY_TITLE,
  QUEUE_FILTER_EMPTY_TITLE,
  QUEUE_LOAD_FAILED,
  QUEUE_MORE_LABEL,
  QUEUE_NOTE_TEXT,
  QUEUE_OPEN_LABEL,
  QUEUE_RESTRICTED_TEXT,
  QUEUE_SIGN_IN,
  QUEUE_SPAN_CAPPED,
  QUEUE_STALE,
  QUEUE_UNREACHABLE_TEXT,
} from "./unacknowledged-wording";
import { MAX_SPAN_PAGES, SHOW_MORE_TIMEOUT_MS } from "./use-unacknowledged-queue";

const PATH = "/api/v1/messaging/escalations/unacknowledged";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const MSG = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";

const item = (over: Partial<AckQueueItemDto> = {}): AckQueueItemDto => ({
  restricted: false,
  id: "cccccccc-cccc-4ccc-8ccc-000000000001",
  channel_id: CH,
  message_id: MSG,
  patient_id: "99999999-9999-4999-8999-000000000001",
  ack_class: "urgent",
  status: "pending",
  assigned_user_id: "dddddddd-dddd-4ddd-8ddd-000000000001",
  assigned_display_name: "Nina Nurse",
  requested_at: "2026-10-18T11:30:00.000Z",
  deadline_at: "2026-10-18T11:45:00.000Z",
  overdue: true,
  overdue_seconds: 12 * 60,
  current_tier: 0,
  escalation_note: null,
  delivery_failed: false,
  ...over,
});
const RESTRICTED: AckQueueItemDto = item({
  restricted: true,
  id: null,
  channel_id: null,
  message_id: null,
  patient_id: null,
  assigned_user_id: null,
  status: "escalated",
  current_tier: 1,
  escalation_note: "ladder_exhausted",
  assigned_display_name: "Rae Responder",
});
const FAILED = item({
  id: "cccccccc-cccc-4ccc-8ccc-000000000003",
  status: "failed_unreachable",
  delivery_failed: true,
  overdue: false,
  overdue_seconds: 0,
  deadline_at: "2099-01-01T00:00:00.000Z",
});

const page = (
  items: AckQueueItemDto[],
  over: Partial<AckQueueResponse> = {},
): { data: AckQueueResponse } => ({
  data: {
    items,
    next_cursor: null,
    audit_request_id: null,
    complete: true,
    filtered: false,
    counts: { unfiltered: items.length, matching: items.length, overdue: 2, failed_unreachable: 1 },
    ...over,
  },
});

function mount(handler: (query: Record<string, unknown>) => unknown) {
  const GET = vi.fn((path: string, init?: { params?: { query?: Record<string, unknown> } }) => {
    expect(path).toBe(PATH);
    return Promise.resolve(handler(init?.params?.query ?? {}));
  });
  const POST = vi.fn();
  const PUT = vi.fn();
  const PATCH = vi.fn();
  const DELETE = vi.fn();
  const view = render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST, PUT, PATCH, DELETE } as unknown as ApiClient}>
        <main>
          <UnacknowledgedQueue />
        </main>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, writes: [POST, PUT, PATCH, DELETE], ...view };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UnacknowledgedQueue", () => {
  it("shows a loading state, then every row with words for its state, overdue time, assignee and a thread link", async () => {
    // the screen derives "overdue by" from the deadline and its own clock: pin the clock 12 minutes after the fixture's deadline
    vi.useFakeTimers({ now: new Date("2026-10-18T11:57:00.000Z"), toFake: ["Date"] });
    const { GET, writes } = mount(() => page([item(), RESTRICTED, FAILED]));
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("Waiting")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Overdue by 12 min")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Urgent")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Assigned to Nina Nurse.")).toBeTruthy();
    const link = within(rows[0] as HTMLElement).getByRole("link");
    expect(link.getAttribute("href")).toBe(`/messaging?channelId=${CH}&messageId=${MSG}`);
    expect(within(rows[2] as HTMLElement).getByText("Could not be delivered")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText(QUEUE_UNREACHABLE_TEXT)).toBeTruthy();
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET.mock.calls[0]?.[1]).toEqual({ params: { query: { limit: 50 } } });
    for (const w of writes) expect(w).not.toHaveBeenCalled();
  });

  it("lists a restricted row with its note and assignee but no link, no patient and no message", async () => {
    mount(() => page([RESTRICTED]));
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("Escalated")).toBeTruthy();
    expect(within(row).getByText(QUEUE_NOTE_TEXT.ladder_exhausted)).toBeTruthy();
    expect(within(row).getByText("Assigned to Rae Responder.")).toBeTruthy();
    expect(within(row).getByText(QUEUE_RESTRICTED_TEXT)).toBeTruthy();
    expect(within(row).queryByRole("link")).toBeNull();
    expect(row.textContent).not.toMatch(/99999999|aaaaaaaa|bbbbbbbb/);
    expect(threadLink(RESTRICTED)).toBeNull();
  });

  it("states the total beside the list, and 'showing x of y' when a filter narrows it, with the unfiltered total unchanged", async () => {
    const { GET } = mount((query) =>
      query.status === "failed_unreachable"
        ? page([FAILED], {
            filtered: true,
            counts: { unfiltered: 5, matching: 1, overdue: 2, failed_unreachable: 1 },
          })
        : page([item(), RESTRICTED, FAILED], {
            counts: { unfiltered: 3, matching: 3, overdue: 2, failed_unreachable: 1 },
          }),
    );
    expect(
      await screen.findByText(/3 waiting, 2 overdue, 1 could not be delivered\. Showing 3 of 3\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Could not be delivered" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(
      screen.getByText(/5 waiting, 2 overdue.*Showing 1 of 1 that match the filters\./),
    ).toBeTruthy();
    expect(GET.mock.calls.at(-1)?.[1]).toEqual({
      params: { query: { limit: 50, status: "failed_unreachable" } },
    });
    expect(
      screen.getByRole("button", { name: "Could not be delivered" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("never shows the other filter's rows while a new filter loads, and 'overdue only' sends overdue=true", async () => {
    let release: (value: unknown) => void = () => undefined;
    const { GET } = mount((query) =>
      query.overdue === true
        ? new Promise((resolve) => {
            release = resolve;
          })
        : page([item(), FAILED]),
    );
    await screen.findAllByRole("listitem");
    fireEvent.click(screen.getByRole("button", { name: "Overdue only" }));
    await waitFor(() => expect(screen.queryAllByRole("listitem")).toHaveLength(0));
    expect(GET.mock.calls.at(-1)?.[1]).toEqual({ params: { query: { limit: 50, overdue: true } } });
    await act(async () => release(page([item()], { filtered: true })));
    expect(await screen.findAllByRole("listitem")).toHaveLength(1);
  });

  it("explains an empty list and, for an empty filter, offers to show everything that is waiting", async () => {
    const { unmount } = mount(() =>
      page([], { counts: { unfiltered: 0, matching: 0, overdue: 0, failed_unreachable: 0 } }),
    );
    expect(await screen.findByText(QUEUE_EMPTY_TITLE)).toBeTruthy();
    expect(screen.getByText("Nothing is waiting.")).toBeTruthy();
    unmount();

    mount((query) =>
      query.status === "escalated"
        ? page([], {
            filtered: true,
            counts: { unfiltered: 4, matching: 0, overdue: 1, failed_unreachable: 0 },
          })
        : page([item()], {
            counts: { unfiltered: 4, matching: 4, overdue: 1, failed_unreachable: 0 },
          }),
    );
    await screen.findAllByRole("listitem");
    fireEvent.click(screen.getByRole("button", { name: "Escalated" }));
    expect(await screen.findByText(QUEUE_FILTER_EMPTY_TITLE)).toBeTruthy();
    expect(screen.getByText("4 waiting in all.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show everything waiting" }));
    expect(await screen.findAllByRole("listitem")).toHaveLength(1);
  });

  it("shows an error with Retry when the first load fails, and recovers", async () => {
    let fail = true;
    const { GET } = mount(() => (fail ? { error: {}, response: { status: 500 } } : page([item()])));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(QUEUE_LOAD_FAILED)).toBeTruthy();
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByRole("listitem")).toHaveLength(1);
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, QUEUE_DENIED],
    [401, QUEUE_SIGN_IN],
    [404, QUEUE_DENIED],
  ])("fails closed on a %i with no list and no retry", async (status, text) => {
    mount(() => ({ error: {}, response: { status } }));
    expect((await screen.findByRole("alert")).textContent).toBe(text);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryAllByRole("listitem")).toEqual([]);
  });

  it("keeps the last list and says it may be stale when a refresh fails", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    let fail = false;
    mount(() => (fail ? { error: {}, response: { status: 503 } } : page([item()])));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(QUEUE_STALE)).toBeTruthy();
  });

  it("polls on a timer and stops when the screen unmounts", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const { GET, unmount } = mount(() => page([item()]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(GET).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(GET).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("appends the next page on 'Show more' with the server's cursor and keeps the rows already shown", async () => {
    const second = item({
      id: "cccccccc-cccc-4ccc-8ccc-000000000002",
      assigned_display_name: "Sam Second",
    });
    const { GET } = mount((query) =>
      query.cursor === "CUR"
        ? page([second], {
            counts: { unfiltered: 2, matching: 2, overdue: 2, failed_unreachable: 0 },
          })
        : page([item()], {
            next_cursor: "CUR",
            complete: false,
            counts: { unfiltered: 2, matching: 2, overdue: 2, failed_unreachable: 0 },
          }),
    );
    await screen.findAllByRole("listitem");
    expect(screen.getByText(/Showing 1 of 2\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(GET.mock.calls.at(-1)?.[1]).toEqual({ params: { query: { limit: 50, cursor: "CUR" } } });
    expect(screen.getByText(/Showing 2 of 2\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: QUEUE_MORE_LABEL })).toBeNull();
  });

  it("renders names as text, never as markup", async () => {
    mount(() => page([item({ assigned_display_name: "<img src=x onerror=alert(1)>" })]));
    const row = await screen.findByRole("listitem");
    expect(row.querySelector("img")).toBeNull();
    expect(row.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("has no accessibility violations with a mixed list, a filter row and a live summary", async () => {
    mount(() => page([item(), RESTRICTED, FAILED], { next_cursor: "CUR", complete: false }));
    await screen.findAllByRole("listitem");
    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
    expect(screen.getAllByRole("link", { name: new RegExp(QUEUE_OPEN_LABEL) })).toHaveLength(2);
  });

  describe("races, focus and states", () => {
    const deferred = <T,>() => {
      let resolve: (value: T) => void = () => undefined;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const FIRST = item({
      id: "cccccccc-cccc-4ccc-8ccc-0000000000f1",
      assigned_display_name: "First Person",
    });
    const OLD_ONLY = item({
      id: "cccccccc-cccc-4ccc-8ccc-0000000000f2",
      assigned_display_name: "Old Filter Person",
    });
    const SECOND = item({
      id: "cccccccc-cccc-4ccc-8ccc-0000000000f3",
      assigned_display_name: "Second Person",
    });
    const withMore = (items: AckQueueItemDto[]) =>
      page(items, {
        next_cursor: "CUR",
        complete: false,
        counts: { unfiltered: 2, matching: 2, overdue: 2, failed_unreachable: 0 },
      });

    it("ignores a late answer for the OLD filter after the new filter's rows are shown", async () => {
      const old = deferred<unknown>();
      mount((query) => {
        if (query.overdue === true) return page([SECOND], { filtered: true });
        return query.status === "pending" ? old.promise : page([FIRST]);
      });
      await screen.findByText("Assigned to First Person.");
      fireEvent.click(screen.getByRole("button", { name: "Waiting" }));
      fireEvent.click(screen.getByRole("button", { name: "Overdue only" }));
      await screen.findByText("Assigned to Second Person.");
      await act(async () => old.resolve(page([OLD_ONLY])));
      expect(screen.queryByText("Assigned to Old Filter Person.")).toBeNull();
      expect(screen.getByText("Assigned to Second Person.")).toBeTruthy();
    });

    it("clicking the already-active filter is a no-op: no read and no spinner", async () => {
      const { GET } = mount(() => page([item()]));
      await screen.findAllByRole("listitem");
      const reads = GET.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Everything waiting" }));
      expect(screen.queryByLabelText("Loading")).toBeNull();
      expect(GET.mock.calls.length).toBe(reads);
    });

    it("shows an alert when Show more fails and keeps the rows already shown", async () => {
      mount((query) =>
        query.cursor === "CUR" ? { error: {}, response: { status: 500 } } : withMore([FIRST]),
      );
      await screen.findAllByRole("listitem");
      fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
      expect((await screen.findByRole("alert")).textContent).toContain("Could not load more");
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
    });

    it("keeps the appended rows through the next poll (the refresh re-reads the whole loaded span)", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      const { GET } = mount((query) =>
        query.cursor === "CUR"
          ? page([SECOND], {
              counts: { unfiltered: 2, matching: 2, overdue: 2, failed_unreachable: 0 },
            })
          : withMore([FIRST]),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      const before = GET.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(GET.mock.calls.length).toBeGreaterThan(before);
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    it("does not poll while Show more is in flight, and drops nothing when it lands", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      const more = deferred<unknown>();
      const { GET } = mount((query) => (query.cursor === "CUR" ? more.promise : withMore([FIRST])));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
      const during = GET.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(GET.mock.calls.length).toBe(during);
      await act(async () => more.resolve(page([SECOND])));
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    it("drops a Show more page that belongs to the previous filter", async () => {
      const more = deferred<unknown>();
      mount((query) => {
        if (query.cursor === "CUR") return more.promise;
        return query.status === "escalated"
          ? page([SECOND], { filtered: true })
          : withMore([FIRST]);
      });
      await screen.findAllByRole("listitem");
      fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
      fireEvent.click(screen.getByRole("button", { name: "Escalated" }));
      await screen.findByText("Assigned to Second Person.");
      await act(async () => more.resolve(page([OLD_ONLY])));
      expect(screen.queryByText("Assigned to Old Filter Person.")).toBeNull();
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
      // the busy state belonged to the old filter: the new list's Show more (none here) is not stuck disabled
      expect(screen.queryByRole("button", { name: QUEUE_MORE_LABEL })).toBeNull();
    });

    it("unmounting with a request in flight raises no React warning", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const slow = deferred<unknown>();
      const { unmount, GET } = mount(() => slow.promise);
      unmount();
      await act(async () =>
        slow.resolve(page([item(), item({ id: "cccccccc-cccc-4ccc-8ccc-0000000000e1" })])),
      );
      expect(spy).not.toHaveBeenCalled();
      expect(GET).toHaveBeenCalledTimes(1); // the late answer started nothing (no chained page, no retry)
      expect(document.body.textContent).not.toContain("Assigned to");
    });

    it("moves focus to the first appended row when Show more disappears, and to the list after a Retry", async () => {
      mount((query) => (query.cursor === "CUR" ? page([SECOND]) : withMore([FIRST])));
      await screen.findAllByRole("listitem");
      const more = screen.getByRole("button", { name: QUEUE_MORE_LABEL });
      more.focus();
      fireEvent.click(more);
      await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
      await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole("listitem")[1]));
    });

    it("moves focus to the list section after a successful Retry removed the button", async () => {
      let fail = true;
      mount(() => (fail ? { error: {}, response: { status: 500 } } : page([item()])));
      const retry = await screen.findByRole("button", { name: "Retry" });
      fail = false;
      retry.focus();
      fireEvent.click(retry);
      await screen.findAllByRole("listitem");
      await waitFor(() => expect(document.activeElement?.tagName).toBe("SECTION"));
    });

    it("clears the stale alert on a later successful refresh and stops polling after a 403", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      let mode: "ok" | "fail" | "denied" = "ok";
      const { GET } = mount(() =>
        mode === "ok"
          ? page([item()])
          : { error: {}, response: { status: mode === "fail" ? 503 : 403 } },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      mode = "fail";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(screen.getByText(QUEUE_STALE)).toBeTruthy();
      mode = "ok";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.queryByText(QUEUE_STALE)).toBeNull();
      mode = "denied";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByText(QUEUE_DENIED)).toBeTruthy();
      const reads = GET.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000);
      });
      expect(GET.mock.calls.length).toBe(reads);
    });

    it("has no accessibility violations in the error, stale, denied and empty states", async () => {
      const first = mount(() => ({ error: {}, response: { status: 500 } }));
      await screen.findByRole("alert");
      expect((await axe.run(document.body)).violations).toEqual([]);
      first.unmount();

      const empty = mount(() =>
        page([], { counts: { unfiltered: 0, matching: 0, overdue: 0, failed_unreachable: 0 } }),
      );
      await screen.findByText(QUEUE_EMPTY_TITLE);
      expect((await axe.run(document.body)).violations).toEqual([]);
      empty.unmount();

      const denied = mount(() => ({ error: {}, response: { status: 403 } }));
      await screen.findByText(QUEUE_DENIED);
      expect((await axe.run(document.body)).violations).toEqual([]);
      denied.unmount();
    });

    it("after a denied answer, changing the filter asks again and resolves (no stuck spinner)", async () => {
      let mode: "denied" | "ok" = "denied";
      const { GET } = mount(() =>
        mode === "denied" ? { error: {}, response: { status: 403 } } : page([SECOND]),
      );
      await screen.findByText(QUEUE_DENIED);
      const reads = GET.mock.calls.length;
      mode = "ok";
      fireEvent.click(screen.getByRole("button", { name: "Escalated" }));
      expect(await screen.findByText("Assigned to Second Person.")).toBeTruthy();
      expect(GET.mock.calls.length).toBe(reads + 1);
      expect(screen.queryByLabelText("Loading")).toBeNull();
    });

    it("a poll already in flight cannot overwrite the rows Show more appended", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      const poll = deferred<unknown>();
      let firstRead = true;
      mount((query) => {
        if (query.cursor === "CUR") return page([SECOND]);
        if (firstRead) {
          firstRead = false;
          return withMore([FIRST]);
        }
        return poll.promise;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000); // the poll starts and hangs
      });
      fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      await act(async () => poll.resolve(withMore([FIRST])));
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    it("never hides a server-overdue row, whatever the client clock says", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-18T09:00:00.000Z"), toFake: ["Date"] }); // hours BEHIND the deadline
      mount(() => page([item()]));
      expect(await screen.findByText("Overdue by 12 min")).toBeTruthy();
      expect(screen.queryByText(/^Due /)).toBeNull();
    });

    it("moves no focus when the person has moved on, and none when Show more failed", async () => {
      mount((query) =>
        query.cursor === "CUR" ? { error: {}, response: { status: 500 } } : withMore([FIRST]),
      );
      await screen.findAllByRole("listitem");
      const more = screen.getByRole("button", { name: QUEUE_MORE_LABEL });
      more.focus();
      fireEvent.click(more);
      await screen.findByRole("alert");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
    });

    it("hands focus on only when it was still on the clicked control", async () => {
      mount((query) => (query.cursor === "CUR" ? page([SECOND]) : withMore([FIRST])));
      await screen.findAllByRole("listitem");
      const filterButton = screen.getByRole("button", { name: "Overdue only" });
      const more = screen.getByRole("button", { name: QUEUE_MORE_LABEL });
      more.focus();
      fireEvent.mouseDown(more);
      filterButton.focus(); // the person moved on before the click handler ran
      fireEvent.click(more);
      await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
      expect(document.activeElement).toBe(filterButton);
    });

    it("a filter change while Show more is in flight leaves the new filter's own Show more working", async () => {
      const slow = deferred<unknown>();
      mount((query) => {
        if (query.cursor === "CUR") return slow.promise;
        if (query.cursor === "CUR2") return page([OLD_ONLY], { filtered: true });
        return query.status === "escalated"
          ? page([SECOND], { filtered: true, next_cursor: "CUR2", complete: false })
          : withMore([FIRST]);
      });
      await screen.findAllByRole("listitem");
      fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
      fireEvent.click(screen.getByRole("button", { name: "Escalated" }));
      await screen.findByText("Assigned to Second Person.");
      const more = screen.getByRole("button", { name: QUEUE_MORE_LABEL });
      expect((more as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(more);
      expect(await screen.findByText("Assigned to Old Filter Person.")).toBeTruthy();
      await act(async () => slow.resolve(page([FIRST])));
      expect(screen.queryByText("Assigned to First Person.")).toBeNull();
    });

    it("says so when a refresh could not rebuild a very long list, after at most MAX_SPAN_PAGES requests", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      let n = 0;
      const hundred = () =>
        Array.from({ length: 100 }, () => {
          n += 1;
          return item({ id: `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}` });
        });
      const { GET } = mount(() => page(hundred(), { next_cursor: `C${n}`, complete: false }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (let i = 0; i < 10; i += 1) {
        fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      expect(screen.getAllByRole("listitem")).toHaveLength(1100);
      const before = GET.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(GET.mock.calls.length - before).toBe(MAX_SPAN_PAGES);
      expect(screen.getByText(QUEUE_SPAN_CAPPED)).toBeTruthy();
      expect(screen.getAllByRole("listitem")).toHaveLength(MAX_SPAN_PAGES * 100);
      // the list now sits at the cap with more remaining: the note stays through the next refreshes
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(screen.getByText(QUEUE_SPAN_CAPPED)).toBeTruthy();
    });

    const FAKE: Parameters<typeof vi.useFakeTimers>[0] = {
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    };

    it("gives up on a Show more that never answers: the alert shows, the button returns and polling resumes", async () => {
      vi.useFakeTimers(FAKE);
      const { GET } = mount((query) =>
        query.cursor === "CUR" ? new Promise(() => undefined) : withMore([FIRST]),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SHOW_MORE_TIMEOUT_MS + 1);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("alert").textContent).toContain("Could not load more");
      expect(
        (screen.getByRole("button", { name: QUEUE_MORE_LABEL }) as HTMLButtonElement).disabled,
      ).toBe(false);
      const before = GET.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(GET.mock.calls.length).toBeGreaterThan(before); // the poll is back
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
    });

    it("queues a Retry clicked during Show more and refreshes once when it settles", async () => {
      vi.useFakeTimers(FAKE);
      const more = deferred<unknown>();
      let reads = 0;
      let mode: "ok" | "fail" = "ok";
      let moreCalls = 0;
      const { GET } = mount((query) => {
        if (query.cursor === "CUR") {
          moreCalls += 1;
          return moreCalls === 1 ? more.promise : page([SECOND]);
        }
        reads += 1;
        return mode === "fail" ? { error: {}, response: { status: 503 } } : withMore([FIRST]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      mode = "fail";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000); // a refresh fails: stale banner with Retry
      });
      fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
      mode = "ok";
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      const during = GET.mock.calls.length;
      expect(reads).toBeGreaterThan(1);
      await act(async () => more.resolve(page([SECOND])));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(GET.mock.calls.length).toBe(during + 2); // one queued refresh (two chained pages for the two rows held), after Show more settled
      expect(screen.queryByText(QUEUE_STALE)).toBeNull();
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    it("Show more first, then a poll tick: the tick waits and nothing appended is lost", async () => {
      vi.useFakeTimers(FAKE);
      const more = deferred<unknown>();
      const { GET } = mount((query) => (query.cursor === "CUR" ? more.promise : withMore([FIRST])));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL }));
      const during = GET.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(GET.mock.calls.length).toBe(during);
      await act(async () => more.resolve(page([SECOND])));
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    it("hands focus on when a mouse click did not focus the button (Safari, Firefox)", async () => {
      mount((query) => (query.cursor === "CUR" ? page([SECOND]) : withMore([FIRST])));
      await screen.findAllByRole("listitem");
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.click(screen.getByRole("button", { name: QUEUE_MORE_LABEL })); // focus stays on the page
      await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole("listitem")[1]));
    });
  });
});
