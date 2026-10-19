// M36 WP 4.2 - the acknowledgment-request card and its loader: text+icon status, buttons only from viewer_actions, one POST per
// click, indeterminate/definitive failure wording, a late answer for a left channel ignored, a transient load error with retry,
// and no request at all from opening, reading or focusing.
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { AckRequestDto } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AckForMessage, AckRequestsProvider } from "./ack-request-card";
import {
  ACK_CHANGED_TEXT,
  ACK_CLOSE_LABEL,
  ACK_CLOSE_NOT_QUALIFIED_TEXT,
  ACK_ESCALATED_TO_YOU_NOTICE,
  ACK_GONE_TEXT,
  ACK_INDETERMINATE_TEXT,
  ACK_INVALID_TEXT,
  ACK_NOTE_TEXT,
  ACK_NOTICE,
  ACK_NOT_PERMITTED_TEXT,
  ACK_NOT_QUALIFIED_TEXT,
  ACK_PASSED_ON_NOTICE,
  ACK_REASSIGNED_AWAY_NOTICE,
  ACK_SAVED_TAKEN_TEXT,
  ACK_SIGN_IN_TEXT,
  ACK_STALE_TEXT,
  ACK_STATUS_TEXT,
  ACK_TAKE_LABEL,
  ACK_TOO_MANY_TEXT,
  ACK_UNREACHABLE_NOTICE,
  ACK_UNREACHABLE_TEXT,
} from "./ack-wording";
import { ACK_POLL_MS, ACK_RELOAD_TIMEOUT_MS, useAckRequests } from "./use-ack-requests";

// The fixtures hold absolute instants (deadline 2026-10-15T13:00Z); pin the clock before them so "Respond by" never turns into
// "Overdue" as the real date passes. Date is faked in every test; the timer functions only where a test advances time.
const FIXED_NOW = new Date("2026-10-15T12:10:00.000Z");
const TIMER_FUNCTIONS = ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] as const;
const FAKE_CLOCK = {
  now: FIXED_NOW,
  toFake: [...TIMER_FUNCTIONS, "Date"] as ("Date" | (typeof TIMER_FUNCTIONS)[number])[],
};
beforeEach(() => {
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const LIST = "/api/v1/messaging/channels/{id}/escalations";
const request = (over: Partial<AckRequestDto> = {}): AckRequestDto => ({
  id: "r-1",
  message_id: "m-1",
  channel_id: "c-1",
  patient_id: "p-1",
  ack_class: "important",
  status: "pending",
  requester_user_id: "u-1",
  assigned_user_id: "u-2",
  requested_at: "2026-10-15T12:00:00.000Z",
  window_started_at: "2026-10-15T12:00:00.000Z",
  deadline_at: "2026-10-15T13:00:00.000Z",
  current_tier: 0,
  acknowledged_at: null,
  acknowledged_by_user_id: null,
  resolved_at: null,
  cancelled_at: null,
  version: 0,
  viewer_actions: { can_acknowledge: true, can_reassign: true, can_resolve: false },
  ...over,
});
const takeButton = () => screen.findByRole("button", { name: /^Take responsibility/ });
const ok = (requests: AckRequestDto[]) => ({ data: { requests }, response: { status: 200 } });

function mount(opts: {
  get?: (path: string, channel: string) => unknown;
  post?: ReturnType<typeof vi.fn>;
  channelId?: string;
  refreshKey?: string | null;
  landOnMessageId?: string | null;
  onLanded?: () => void;
}) {
  const GET = vi.fn((path: string, init: { params: { path: { id: string } } }) =>
    Promise.resolve(opts.get ? opts.get(path, init.params.path.id) : ok([request()])),
  );
  const POST = opts.post ?? vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } });
  const client = { GET, POST } as unknown as ApiClient;
  const tree = (channelId: string, refreshKey: string | null = opts.refreshKey ?? null) => (
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <main>
          <AckRequestsProvider
            channelId={channelId}
            enabled
            refreshKey={refreshKey}
            landOnMessageId={opts.landOnMessageId ?? null}
            onLanded={opts.onLanded}
          >
            <AckForMessage messageId="m-1" />
          </AckRequestsProvider>
        </main>
      </ApiClientProvider>
    </MemoryRouter>
  );
  const view = render(tree(opts.channelId ?? "c-1"));
  return { GET, POST, view, tree };
}

describe("ack request card", () => {
  it("shows the status as words with an icon, the deadline, and the fixed notice wired to the button", async () => {
    mount({});
    const take = await takeButton();

    expect(take.getAttribute("aria-label")).toMatch(/^Take responsibility for the message sent /);
    expect(screen.getByRole("group", { name: ACK_STATUS_TEXT.pending })).toBeTruthy();
    expect(screen.getByText(ACK_STATUS_TEXT.pending)).toBeTruthy();
    expect(screen.getByText(/Waiting for you/)).toBeTruthy();
    expect(screen.getByText(/Respond by/)).toBeTruthy();
    expect(document.querySelector(".wx-ack-status svg")).not.toBeNull();
    const notice = screen.getByText(ACK_NOTICE);
    expect(take.getAttribute("aria-describedby")).toBe(notice.id);
    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
  });

  it.each([
    [
      "pending",
      { can_acknowledge: false, can_reassign: true, can_resolve: false },
      [],
      /person it was sent to/,
    ],
    [
      "pending",
      { can_acknowledge: true, can_reassign: true, can_resolve: false },
      [ACK_TAKE_LABEL],
      /Waiting for you/,
    ],
    [
      "acknowledged",
      { can_acknowledge: false, can_reassign: true, can_resolve: true },
      [ACK_CLOSE_LABEL],
      null,
    ],
    ["resolved", { can_acknowledge: false, can_reassign: false, can_resolve: false }, [], null],
  ] as const)(
    "offers only the controls viewer_actions allows (%s)",
    async (status, viewer_actions, labels, waiting) => {
      mount({ get: () => ok([request({ status, viewer_actions })]) });
      await screen.findByText(ACK_STATUS_TEXT[status]);

      const buttons = screen.queryAllByRole("button").map((b) => b.textContent);
      expect(buttons).toEqual([...labels]);
      if (waiting) expect(screen.getByText(waiting)).toBeTruthy();
    },
  );

  it("sends exactly one acknowledge POST for a double click, then reloads", async () => {
    let resolvePost: (v: unknown) => void = () => undefined;
    const post = vi.fn(
      () =>
        new Promise((r) => {
          resolvePost = r;
        }),
    );
    const { GET } = mount({ post });
    const take = await takeButton();

    fireEvent.click(take);
    fireEvent.click(take);
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls as unknown[][])[0]?.[0]).toBe(
      "/api/v1/messaging/escalations/{id}/acknowledge",
    );
    expect(take.getAttribute("aria-disabled")).toBe("true");
    expect(take.getAttribute("aria-label")).toMatch(/^Saving/);
    await act(async () => resolvePost({ data: {}, response: { status: 200 } }));

    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });

  it("tells the person it may not have been saved when no answer came, and reloads", async () => {
    const post = vi.fn().mockRejectedValue(new Error("network"));
    const { GET } = mount({ post });

    fireEvent.click(await takeButton());

    expect(await screen.findByText(ACK_INDETERMINATE_TEXT)).toBeTruthy();
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });

  it("says plainly when the role cannot take the message", async () => {
    const post = vi.fn().mockResolvedValue({
      error: { error: { code: "ACK_NOT_QUALIFIED" } },
      response: { status: 403 },
    });
    mount({ post });

    fireEvent.click(await takeButton());

    expect(await screen.findByText(ACK_NOT_QUALIFIED_TEXT)).toBeTruthy();
  });

  it("a 409 reloads and shows the current state", async () => {
    let calls = 0;
    const post = vi.fn().mockResolvedValue({ error: {}, response: { status: 409 } });
    mount({
      post,
      get: () => {
        calls += 1;
        return ok([
          request(
            calls > 1
              ? {
                  status: "acknowledged",
                  viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: true },
                }
              : {},
          ),
        ]);
      },
    });

    fireEvent.click(await takeButton());

    expect(await screen.findByText(ACK_STATUS_TEXT.acknowledged)).toBeTruthy();
  });

  it("ignores a late answer for a channel the person has left", async () => {
    let releaseA: (v: unknown) => void = () => undefined;
    const { view, tree } = mount({
      get: (_p, channel) =>
        channel === "c-1"
          ? new Promise((r) => {
              releaseA = r;
            })
          : ok([
              request({
                channel_id: "c-2",
                status: "resolved",
                viewer_actions: { can_acknowledge: false, can_reassign: false, can_resolve: false },
              }),
            ]),
    });

    view.rerender(tree("c-2"));
    await screen.findByText(ACK_STATUS_TEXT.resolved);
    await act(async () => releaseA(ok([request()])));

    expect(screen.queryByText(ACK_STATUS_TEXT.pending)).toBeNull();
    expect(screen.getByText(ACK_STATUS_TEXT.resolved)).toBeTruthy();
  });

  it("a transient load error shows a retry; a definitive one shows nothing", async () => {
    const first = mount({ get: () => ({ error: {}, response: { status: 503 } }) });
    expect(await screen.findByText(/Could not load requests/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    first.view.unmount();

    mount({ get: () => ({ error: {}, response: { status: 404 } }) });
    await waitFor(() => expect(screen.queryByText(/Could not load requests/)).toBeNull());
    expect(screen.queryByText(ACK_STATUS_TEXT.pending)).toBeNull();
  });

  it("opening, focusing and scrolling to the card sends nothing", async () => {
    const { POST } = mount({});
    const take = await takeButton();

    take.focus();
    take.scrollIntoView?.();
    fireEvent.focus(take);
    fireEvent.mouseOver(take);

    expect(POST).not.toHaveBeenCalled();
  });
});

const deferred = () => {
  let resolve: (v: unknown) => void = () => undefined;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("ack request card - action failures", () => {
  it.each([
    ["undefined answer", undefined, {}, ACK_INDETERMINATE_TEXT],
    ["408", 408, {}, ACK_INDETERMINATE_TEXT],
    ["500", 500, {}, ACK_INDETERMINATE_TEXT],
    ["503", 503, {}, ACK_INDETERMINATE_TEXT],
    ["429", 429, {}, ACK_TOO_MANY_TEXT],
    ["401", 401, {}, ACK_SIGN_IN_TEXT],
    ["403 not qualified", 403, { error: { code: "ACK_NOT_QUALIFIED" } }, ACK_NOT_QUALIFIED_TEXT],
    ["403 other", 403, { error: { code: "FORBIDDEN" } }, ACK_NOT_PERMITTED_TEXT],
    ["404", 404, {}, ACK_GONE_TEXT],
    ["409", 409, {}, ACK_CHANGED_TEXT],
    ["422", 422, {}, ACK_INVALID_TEXT],
  ] as const)("take: %s", async (_name, status, error, text) => {
    const post = vi.fn().mockResolvedValue({ error, response: status ? { status } : undefined });
    mount({ post });

    fireEvent.click(await takeButton());

    expect(await screen.findByText(text)).toBeTruthy();
    expect(document.querySelector(".wx-ack-alert")?.textContent ?? "").toContain(text);
  });

  it("close: a 403 not-qualified says the role cannot CLOSE the message", async () => {
    const post = vi.fn().mockResolvedValue({
      error: { error: { code: "ACK_NOT_QUALIFIED" } },
      response: { status: 403 },
    });
    mount({
      post,
      get: () =>
        ok([
          request({
            status: "acknowledged",
            viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: true },
          }),
        ]),
    });

    fireEvent.click(await screen.findByRole("button", { name: /^Close this request/ }));

    expect(await screen.findByText(ACK_CLOSE_NOT_QUALIFIED_TEXT)).toBeTruthy();
  });
});

describe("ack request card - busy, stale, focus, refresh", () => {
  it("stays busy until the reload settles: a click while the reload is held sends no second POST", async () => {
    const reload = deferred();
    let gets = 0;
    const { POST } = mount({
      get: () => {
        gets += 1;
        return gets === 1 ? ok([request()]) : reload.promise;
      },
    });
    const take = await takeButton();

    fireEvent.click(take);
    await waitFor(() => expect(gets).toBe(2));
    fireEvent.click(take);
    expect(POST).toHaveBeenCalledTimes(1);
    expect(take.getAttribute("aria-disabled")).toBe("true");
    await act(async () => reload.resolve(ok([request()])));
    await waitFor(() => expect(take.getAttribute("aria-disabled")).toBeNull());
  });

  it("keeps the card and shows a may-be-out-of-date banner when the reload after a saved POST fails", async () => {
    let gets = 0;
    mount({
      get: () => {
        gets += 1;
        return gets === 1 ? ok([request()]) : { error: {}, response: { status: 503 } };
      },
    });

    fireEvent.click(await takeButton());

    expect(await screen.findByText(new RegExp(ACK_STALE_TEXT.slice(0, 20)))).toBeTruthy();
    expect(screen.getByText(ACK_STATUS_TEXT.pending)).toBeTruthy();
    expect(document.querySelector(".wx-ack-live")?.textContent ?? "").toContain(
      ACK_SAVED_TAKEN_TEXT,
    );
  });

  it("announces success in a live region that was already mounted, and moves focus to the card status", async () => {
    let gets = 0;
    mount({
      get: () => {
        gets += 1;
        return ok([
          request(
            gets > 1
              ? {
                  status: "acknowledged",
                  acknowledged_at: "2026-10-15T12:05:00.000Z",
                  viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: true },
                }
              : {},
          ),
        ]);
      },
    });
    const region = document.querySelector("output.wx-ack-live");
    expect(region).not.toBeNull();

    fireEvent.click(await takeButton());

    await waitFor(() => expect(region?.textContent).toBe(ACK_SAVED_TAKEN_TEXT));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(ACK_STATUS_TEXT.acknowledged),
    );
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("shows the fixed notice once per thread, not once per card", async () => {
    const GET = vi.fn(() =>
      Promise.resolve(ok([request(), request({ id: "r-2", message_id: "m-2" })])),
    );
    const client = { GET, POST: vi.fn() } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <AckRequestsProvider channelId="c-1" enabled>
            <AckForMessage messageId="m-1" />
            <AckForMessage messageId="m-2" />
          </AckRequestsProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await screen.findAllByRole("button", { name: /^Take responsibility/ });

    expect(screen.getAllByText(ACK_NOTICE)).toHaveLength(1);
  });

  it("disables every action button while any action is in flight", async () => {
    const hold = deferred();
    const GET = vi.fn(() =>
      Promise.resolve(ok([request(), request({ id: "r-2", message_id: "m-2" })])),
    );
    const POST = vi.fn(() => hold.promise);
    const client = { GET, POST } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <main>
            <AckRequestsProvider channelId="c-1" enabled>
              <AckForMessage messageId="m-1" />
              <AckForMessage messageId="m-2" />
            </AckRequestsProvider>
          </main>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const buttons = await screen.findAllByRole("button", { name: /^Take responsibility/ });

    fireEvent.click(buttons[0] as HTMLElement);
    fireEvent.click(buttons[1] as HTMLElement);

    expect(POST).toHaveBeenCalledTimes(1);
    for (const b of buttons) expect(b.getAttribute("aria-disabled")).toBe("true");
    await act(async () => hold.resolve({ data: {}, response: { status: 200 } }));
  });

  it("re-reads when a newer message id arrives, and when the window regains focus", async () => {
    const { GET, view, tree } = mount({ refreshKey: "msg-1" });
    await takeButton();
    expect(GET).toHaveBeenCalledTimes(1);

    view.rerender(tree("c-1", "msg-2"));
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(3));
  });

  it("a load 401 and 403 get their own banner; only 404 stays hidden; 429 says wait", async () => {
    const run = async (status: number, text: RegExp | null) => {
      const m = mount({ get: () => ({ error: {}, response: { status } }) });
      if (text) expect(await screen.findByText(text)).toBeTruthy();
      else await waitFor(() => expect(m.GET).toHaveBeenCalled());
      m.view.unmount();
    };
    await run(401, /Sign in again to see/);
    await run(403, /not permitted to see/);
    await run(429, /Wait a moment/);
    await run(404, null);
    expect(document.querySelector(".wx-ack-banner")).toBeNull();
  });
});

describe("useAckRequests - stale channel", () => {
  const wrapper =
    (client: ApiClient) =>
    ({ children }: { children: React.ReactNode }) => (
      <ApiClientProvider client={client}>{children}</ApiClientProvider>
    );

  it("a POST finishing after a channel switch leaves no notice on the new channel and does not reload the old one", async () => {
    const hold = deferred();
    const GET = vi.fn(() => Promise.resolve(ok([request()])));
    const POST = vi.fn(() => hold.promise);
    const client = { GET, POST } as unknown as ApiClient;
    const { result, rerender } = renderHook(({ channel }) => useAckRequests(channel, true), {
      wrapper: wrapper(client),
      initialProps: { channel: "c-1" },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let acting: Promise<void> = Promise.resolve();
    act(() => {
      acting = result.current.act("r-1", "acknowledge");
    });
    expect(result.current.busyId).toBe("r-1");
    rerender({ channel: "c-2" });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    expect(result.current.busyId).toBeNull();
    const before = GET.mock.calls.length;
    await act(async () => {
      hold.resolve({ data: {}, response: { status: 200 } });
      await acting;
    });

    expect(result.current.notice).toBeNull();
    expect(GET).toHaveBeenCalledTimes(before);
  });

  it("c-1 -> c-2 -> c-1: the old visit's notice is dropped but the current list is re-read", async () => {
    const hold = deferred();
    const GET = vi.fn(() => Promise.resolve(ok([request()])));
    const POST = vi.fn(() => hold.promise);
    const client = { GET, POST } as unknown as ApiClient;
    const { result, rerender } = renderHook(({ channel }) => useAckRequests(channel, true), {
      wrapper: wrapper(client),
      initialProps: { channel: "c-1" },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let acting: Promise<void> = Promise.resolve();
    act(() => {
      acting = result.current.act("r-1", "acknowledge");
    });

    rerender({ channel: "c-2" });
    rerender({ channel: "c-1" });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(3));
    const before = GET.mock.calls.length;
    await act(async () => {
      hold.resolve({ data: {}, response: { status: 200 } });
      await acting;
    });

    // No notice (it belongs to the old visit), but the list the person is looking at again is re-read once.
    expect(result.current.notice).toBeNull();
    expect(GET).toHaveBeenCalledTimes(before + 1);
    expect(result.current.busyId).toBeNull();
  });

  it("the render right after a switch never shows the old channel's requests", async () => {
    const GET = vi.fn(() => Promise.resolve(ok([request()])));
    const client = { GET, POST: vi.fn() } as unknown as ApiClient;
    const { result, rerender } = renderHook(({ channel }) => useAckRequests(channel, true), {
      wrapper: wrapper(client),
      initialProps: { channel: "c-1" },
    });
    await waitFor(() => expect(result.current.requests).toHaveLength(1));

    rerender({ channel: "c-2" });

    expect(result.current.requests).toHaveLength(0);
    expect(result.current.status).toBe("loading");
  });
});

describe("ack hook - background reads, focus, timeouts", () => {
  const BG = { "x-wardenx-background": "1" };
  const hookClient = (get: () => unknown, post?: unknown) => {
    const GET = vi.fn((_p: string, _i: unknown) => Promise.resolve(get()));
    const POST = post ?? vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } });
    return { GET, POST, client: { GET, POST } as unknown as ApiClient };
  };
  const wrap =
    (client: ApiClient) =>
    ({ children }: { children: React.ReactNode }) => (
      <ApiClientProvider client={client}>{children}</ApiClientProvider>
    );
  const headersOf = (GET: { mock: { calls: unknown[][] } }, i: number) =>
    (GET.mock.calls[i]?.[1] as { headers?: unknown }).headers;

  it("the interval poll is a BACKGROUND read, the first read and a focus read are not, and it skips a hidden tab", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      const { GET, client } = hookClient(() => ok([request()]));
      renderHook(() => useAckRequests("c-1", true), { wrapper: wrap(client) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(GET).toHaveBeenCalledTimes(1);
      expect(headersOf(GET, 0)).toBeUndefined();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ACK_POLL_MS);
      });
      expect(GET).toHaveBeenCalledTimes(2);
      expect(headersOf(GET, 1)).toEqual(BG);

      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ACK_POLL_MS);
      });
      expect(GET).toHaveBeenCalledTimes(2);
      hidden.mockRestore();

      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(GET).toHaveBeenCalledTimes(3);
      expect(headersOf(GET, 2)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets no timer when no request is open", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      const { GET, client } = hookClient(() =>
        ok([
          request({
            status: "resolved",
            viewer_actions: { can_acknowledge: false, can_reassign: false, can_resolve: false },
          }),
        ]),
      );
      renderHook(() => useAckRequests("c-1", true), { wrapper: wrap(client) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ACK_POLL_MS * 3);
      });
      expect(GET).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a new-message refresh is a background read, and exactly one GET happens per open (the first id is not news)", async () => {
    const { GET, client } = hookClient(() => ok([request()]));
    const { rerender } = renderHook(
      ({ key }: { key: string | null }) => useAckRequests("c-1", true, key),
      { wrapper: wrap(client), initialProps: { key: null as string | null } },
    );
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));

    rerender({ key: "m-1" });
    rerender({ key: "m-1" });
    await act(async () => undefined);
    expect(GET).toHaveBeenCalledTimes(1);

    rerender({ key: "m-2" });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    expect(headersOf(GET, 1)).toEqual(BG);
  });

  it("an empty LOADED thread whose first message arrives refreshes once in the background; a still-loading list does not", async () => {
    const { GET, client } = hookClient(() => ok([]));
    const { rerender } = renderHook(
      ({ key }: { key: string | null }) => useAckRequests("c-1", true, key),
      { wrapper: wrap(client), initialProps: { key: null as string | null } },
    );
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));

    rerender({ key: "" });
    await act(async () => undefined);
    expect(GET).toHaveBeenCalledTimes(1);

    rerender({ key: "m-1" });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    expect(headersOf(GET, 1)).toEqual(BG);
  });

  it("the post-action reload is a foreground read and its 15 s timer is cleared", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      const done = {
        status: "resolved" as const,
        viewer_actions: { can_acknowledge: false, can_reassign: false, can_resolve: false },
      };
      const { GET, client } = hookClient(() => ok([request(done)]));
      const { result } = renderHook(() => useAckRequests("c-1", true), { wrapper: wrap(client) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        await result.current.act("r-1", "acknowledge");
      });

      expect(GET).toHaveBeenCalledTimes(2);
      expect(headersOf(GET, 1)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hung reload cannot hold the busy state forever", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      let gets = 0;
      const { client } = hookClient(() => {
        gets += 1;
        return gets === 1 ? ok([request()]) : new Promise(() => undefined);
      });
      const { result } = renderHook(() => useAckRequests("c-1", true), { wrapper: wrap(client) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      act(() => {
        void result.current.act("r-1", "acknowledge");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.busyId).toBe("r-1");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ACK_RELOAD_TIMEOUT_MS);
      });

      expect(result.current.busyId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ack card - focus and keyboard", () => {
  const acknowledgedAfterFirstRead = () => {
    let gets = 0;
    return () => {
      gets += 1;
      return ok([
        request(
          gets > 1
            ? {
                status: "acknowledged",
                acknowledged_at: "2026-10-15T12:05:00.000Z",
                viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: true },
              }
            : {},
        ),
      ]);
    };
  };

  it("does not steal focus from the composer when the action finishes", async () => {
    const holder = document.createElement("textarea");
    document.body.appendChild(holder);
    const hold = deferred();
    mount({ get: acknowledgedAfterFirstRead(), post: vi.fn(() => hold.promise) });
    fireEvent.click(await takeButton());
    holder.focus();

    await act(async () => hold.resolve({ data: {}, response: { status: 200 } }));
    await screen.findByText(ACK_STATUS_TEXT.acknowledged);

    expect(document.activeElement).toBe(holder);
    holder.remove();
  });

  it("a background poll or refresh never moves focus", async () => {
    const holder = document.createElement("textarea");
    document.body.appendChild(holder);
    const { GET, view, tree } = mount({ refreshKey: "m-1" });
    await takeButton();
    holder.focus();

    view.rerender(tree("c-1", "m-2"));
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));

    expect(document.activeElement).toBe(holder);
    holder.remove();
  });

  it("Enter and Space on a busy (aria-disabled) button send nothing", async () => {
    const hold = deferred();
    const post = vi.fn(() => hold.promise);
    mount({ post });
    const take = await takeButton();
    fireEvent.click(take);
    expect(post).toHaveBeenCalledTimes(1);

    take.focus();
    fireEvent.keyDown(take, { key: "Enter" });
    fireEvent.keyUp(take, { key: " " });
    fireEvent.click(take);

    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => hold.resolve({ data: {}, response: { status: 200 } }));
  });

  it("announces a failure assertively (role=alert) and a success politely", async () => {
    const post = vi.fn().mockResolvedValue({ error: {}, response: { status: 409 } });
    mount({ post });
    fireEvent.click(await takeButton());

    const alert = document.querySelector('[role="alert"]');
    await waitFor(() => expect(alert?.textContent).toBe(ACK_CHANGED_TEXT));
    expect(document.querySelector("output.wx-ack-live")?.textContent).toBe("");
  });
});

// WP 4.4 (ADR-0070): an escalated request, and an overdue one the server could not pass on. The clock is fixed (FIXED_NOW).
describe("ack request card - escalation (WP 4.4)", () => {
  const PAST = "2026-10-15T12:05:00.000Z"; // before FIXED_NOW (12:10)
  const escalated = (over: Partial<AckRequestDto> = {}) =>
    request({
      status: "escalated",
      current_tier: 1,
      deadline_at: "2026-10-15T12:30:00.000Z",
      ...over,
    });

  it("says an escalated request was escalated to the viewer, takes the same one explicit action, and has no a11y violations", async () => {
    mount({ get: () => ok([escalated()]) });

    expect(await takeButton()).toBeTruthy();
    expect(screen.getByRole("group", { name: ACK_STATUS_TEXT.escalated })).toBeTruthy();
    expect(screen.getByText(/Escalated to you because it was not taken in time/)).toBeTruthy();
    expect(screen.getByText(/Respond by/)).toBeTruthy();
    expect((await axe.run(document.body)).violations).toEqual([]);
  });

  it("tells another viewer, without a button, that it was escalated to the next responsible person", async () => {
    mount({
      get: () =>
        ok([
          escalated({
            viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: false },
          }),
        ]),
    });

    expect(await screen.findByText(/Escalated to the next responsible person/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Take responsibility/ })).toBeNull();
  });

  it("marks an overdue escalated request as overdue, not as 'Respond by'", async () => {
    mount({ get: () => ok([escalated({ deadline_at: PAST })]) });

    expect(await screen.findByText(/Overdue: was due/)).toBeTruthy();
  });

  it.each(["route_unavailable", "ladder_exhausted"] as const)(
    "says honestly that an overdue request which %s is still open, and keeps its controls",
    async (note) => {
      mount({ get: () => ok([request({ deadline_at: PAST, escalation_note: note })]) });

      expect(await screen.findByText(ACK_NOTE_TEXT[note])).toBeTruthy();
      expect(screen.getByText(/Overdue: was due/)).toBeTruthy();
      expect(screen.getByText(ACK_STATUS_TEXT.pending)).toBeTruthy();
      expect(await takeButton()).toBeTruthy();
      expect((await axe.run(document.body)).violations).toEqual([]);
    },
  );

  it("shows no note when the server sent none, null, or the request is no longer waiting", async () => {
    mount({
      get: () =>
        ok([
          request({ deadline_at: PAST }),
          request({ id: "r-2", message_id: "m-2", deadline_at: PAST, escalation_note: null }),
          request({
            id: "r-3",
            message_id: "m-3",
            status: "acknowledged",
            acknowledged_at: PAST,
            escalation_note: "route_unavailable",
            viewer_actions: { can_acknowledge: false, can_reassign: false, can_resolve: false },
          }),
        ]),
    });
    await takeButton();

    expect(screen.queryByText(ACK_NOTE_TEXT.route_unavailable)).toBeNull();
    expect(screen.queryByText(ACK_NOTE_TEXT.ladder_exhausted)).toBeNull();
  });
});

// WP 4.5: a request nobody could be reached for says so plainly, never claims anyone received it, and still lets the assignee act.
describe("ack request card - failed_unreachable (WP 4.5)", () => {
  const unreachable = (over: Partial<AckRequestDto> = {}) =>
    request({ status: "failed_unreachable", ...over });

  it("shows the honest status and detail, no 'Respond by' line, and the one explicit action for the assignee", async () => {
    mount({ get: () => ok([unreachable()]) });

    expect(await takeButton()).toBeTruthy();
    expect(screen.getByRole("group", { name: ACK_STATUS_TEXT.failed_unreachable })).toBeTruthy();
    expect(screen.getByText(ACK_UNREACHABLE_TEXT)).toBeTruthy();
    expect(screen.queryByText(/Respond by|Overdue/)).toBeNull();
    expect((await axe.run(document.body)).violations).toEqual([]);
  });

  it("the rendered card never implies anyone was reached, notified, paged or alerted", async () => {
    mount({ get: () => ok([unreachable()]) });
    await takeButton();

    const text = document.querySelector(".wx-ack-card")?.textContent ?? "";

    expect(text).toContain(ACK_STATUS_TEXT.failed_unreachable);
    expect(text).toMatch(/It may still be seen in the app/);
    expect(text).toMatch(/Nobody is known to have received it/);
    expect(text).not.toMatch(/\b(reached|notified|paged|alerted)\b/i);
  });

  it("the sender (can_resolve only) sees the status and no Take button, only Close when it applies", async () => {
    mount({
      get: () =>
        ok([
          unreachable({
            viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: true },
          }),
        ]),
    });

    expect(await screen.findByText(ACK_UNREACHABLE_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Take responsibility/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Close this request/ })).toBeTruthy();
  });

  it("taking responsibility on a failed_unreachable card calls acknowledge and shows the request as taken", async () => {
    let gets = 0;
    const { POST } = mount({
      get: () => {
        gets += 1;
        return ok([
          gets > 1
            ? request({
                status: "acknowledged",
                acknowledged_at: "2026-10-15T12:05:00.000Z",
                viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: true },
              })
            : unreachable(),
        ]);
      },
    });

    fireEvent.click(await takeButton());

    await screen.findByText(ACK_STATUS_TEXT.acknowledged);
    expect(POST).toHaveBeenCalledTimes(1);
    expect(String(POST.mock.calls[0]?.[0])).toMatch(/acknowledge/);
    expect(screen.queryByText(ACK_UNREACHABLE_TEXT)).toBeNull();
  });

  it("offers no button to someone who is not the assignee", async () => {
    mount({
      get: () =>
        ok([
          unreachable({
            viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: false },
          }),
        ]),
    });

    expect(await screen.findByText(ACK_UNREACHABLE_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Take responsibility/ })).toBeNull();
  });
});

// WP 4.4: a poll or focus re-read that shows the request moved on is announced ONCE, politely (never role=alert), and not again.
describe("ack request card - moved-on announcement (WP 4.4)", () => {
  const polite = () => document.querySelector("output.wx-ack-live")?.textContent ?? "";
  const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? "";
  const NO_ACTIONS = { can_acknowledge: false, can_reassign: true, can_resolve: false };
  const tick = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACK_POLL_MS);
    });
  };

  it("the new assignee: a poll turns pending into escalated, the button appears and exactly one polite announcement is made", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    let phase = 0;
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const text = polite();
      if (text && seen.at(-1) !== text) seen.push(text);
    });
    try {
      mount({
        get: () =>
          ok([
            phase === 0
              ? request({ viewer_actions: NO_ACTIONS })
              : request({ status: "escalated", current_tier: 1, assigned_user_id: "u-3" }),
          ]),
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      expect(screen.queryByRole("button", { name: /^Take responsibility/ })).toBeNull();
      expect(polite()).toBe("");

      phase = 1;
      await tick();
      expect(screen.getByRole("button", { name: /^Take responsibility/ })).toBeTruthy();
      expect(polite()).toBe(ACK_ESCALATED_TO_YOU_NOTICE);
      expect(alertText()).toBe("");

      await tick(); // nothing changed: the announcement is not repeated and is cleared
      expect(polite()).toBe("");
      await tick();
      expect(seen).toEqual([ACK_ESCALATED_TO_YOU_NOTICE]);
    } finally {
      observer.disconnect();
      vi.useRealTimers();
    }
  });

  it.each(["pending", "escalated"] as const)(
    "a poll that turns %s into failed_unreachable is announced politely once, never as an alert, and not on first load",
    async (before) => {
      vi.useFakeTimers(FAKE_CLOCK);
      try {
        let phase = 0;
        mount({
          get: () =>
            ok([
              phase === 0 ? request({ status: before }) : request({ status: "failed_unreachable" }),
            ]),
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(polite()).toBe("");

        await tick(); // unchanged read: nothing
        expect(polite()).toBe("");

        phase = 1;
        await tick();
        expect(polite()).toBe(ACK_UNREACHABLE_NOTICE);
        expect(alertText()).toBe("");

        await tick(); // unchanged again: cleared, not repeated
        expect(polite()).toBe("");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("the old assignee: a poll shows the request passed on, the button goes, one polite announcement, and no notice paragraph", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      let phase = 0;
      mount({
        get: () =>
          ok([
            phase === 0
              ? request()
              : request({ status: "escalated", current_tier: 1, viewer_actions: NO_ACTIONS }),
          ]),
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("button", { name: /^Take responsibility/ })).toBeTruthy();

      phase = 1;
      await tick();

      expect(screen.queryByRole("button", { name: /^Take responsibility/ })).toBeNull();
      expect(polite()).toBe(ACK_PASSED_ON_NOTICE);
      expect(screen.queryByText(ACK_NOTICE)).toBeNull();
      expect(screen.getByText(/Nobody has taken responsibility yet/)).toBeTruthy();
      expect(alertText()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reassign away (the request is still pending, not escalated) is announced neutrally, once", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      let phase = 0;
      mount({
        get: () =>
          ok([
            phase === 0
              ? request()
              : request({ assigned_user_id: "u-9", viewer_actions: NO_ACTIONS }),
          ]),
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      phase = 1;
      await tick();

      expect(polite()).toBe(ACK_REASSIGNED_AWAY_NOTICE);
      expect(polite()).not.toMatch(/next person/);
      expect(alertText()).toBe("");
      await tick();
      expect(polite()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes no announcement on the first load, nor when only the deadline text changes", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      let n = 0;
      mount({
        get: () => {
          n += 1;
          return ok([
            request({
              status: "escalated",
              current_tier: 1,
              version: n,
              deadline_at: "2026-10-15T13:00:00.000Z",
            }),
          ]);
        },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(polite()).toBe("");
      await tick();
      expect(polite()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a requester viewing the escalated request sees no buttons and no response notice", async () => {
    mount({
      get: () =>
        ok([request({ status: "escalated", current_tier: 1, viewer_actions: NO_ACTIONS })]),
    });

    expect(await screen.findByText(/Nobody has taken responsibility yet/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(ACK_NOTICE)).toBeNull();
  });
});

describe("ack request card - notification-link landing (WP 4.8)", () => {
  it("focuses the card of the linked message once it loads, and sends nothing", async () => {
    const { POST } = mount({ landOnMessageId: "m-1" });

    const status = await screen.findByText(ACK_STATUS_TEXT.pending);
    await waitFor(() => expect(document.activeElement).toBe(status.closest("p")));

    expect(POST).not.toHaveBeenCalled();
  });

  it("reports the landing exactly once, and never for another message", async () => {
    const onLanded = vi.fn();
    mount({ landOnMessageId: "m-1", onLanded });
    const status = await screen.findByText(ACK_STATUS_TEXT.pending);
    await waitFor(() => expect(document.activeElement).toBe(status.closest("p")));
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it("does not focus again after the person moves on, and not for another message", async () => {
    const first = mount({ landOnMessageId: "m-1" });
    const status = await screen.findByText(ACK_STATUS_TEXT.pending);
    await waitFor(() => expect(document.activeElement).toBe(status.closest("p")));
    (document.activeElement as HTMLElement).blur();
    first.view.rerender(first.tree("c-1", "m-2"));
    await first.view.findByText(ACK_STATUS_TEXT.pending);
    expect(document.activeElement).toBe(document.body);
    first.view.unmount();

    mount({ landOnMessageId: "m-other" });
    await screen.findByText(ACK_STATUS_TEXT.pending);
    expect(document.activeElement).toBe(document.body);
  });
});
