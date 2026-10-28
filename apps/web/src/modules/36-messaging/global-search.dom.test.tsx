import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
/**
 * WP 2.7b in the web client: org-wide search. Every state (loading, empty, refine, capped, 503, 429, 403, 422, offline),
 * plain-text rendering, "Load more", abort-on-change, the query never reaching a URL or storage, and the keyboard walk.
 * The API mock is strict: any call other than the search route fails the test, and nothing may reject unhandled.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSearch } from "./global-search";

const SEARCH = "/api/v1/messaging/search";

const hit = (id: string, body: string, over: Record<string, unknown> = {}) => ({
  messageId: id,
  channelId: "ch-1",
  authorUserId: "u-2",
  authorDisplayName: "Other Nurse",
  body,
  bodyKind: "plain",
  createdAt: "2026-10-10T09:00:00.000Z",
  parentMessageId: null,
  references: [],
  archived: false,
  ...over,
});

interface Reply {
  data?: unknown;
  error?: unknown;
  response: { status: number; headers: Headers };
}
const reply = (status: number, data?: unknown, headers: Record<string, string> = {}): Reply => ({
  data: status < 400 ? data : undefined,
  error: status >= 400 ? (data ?? { error: { code: "X", message: "m" } }) : undefined,
  response: { status, headers: new Headers(headers) },
});
const page = (results: unknown[], over: Record<string, unknown> = {}) =>
  reply(200, { results, scanned: results.length, scanCapped: false, refine: false, ...over });

type SearchInit = { params: { query: Record<string, unknown> }; signal: AbortSignal };

function mount(
  search: (init: SearchInit) => Promise<Reply> | Reply,
  onOpenHit: (c: string, m: string) => Promise<boolean> = () => Promise.resolve(true),
) {
  const GET = vi.fn((path: string, init: SearchInit) => {
    if (path !== SEARCH) throw new Error(`unexpected GET ${path}`);
    return Promise.resolve(search(init));
  });
  const client = { GET } as unknown as ApiClient;
  const utils = render(
    <ApiClientProvider client={client}>
      <GlobalSearch
        channelName={(id) => (id === "ch-1" ? "Care Team Alpha" : null)}
        onOpenHit={onOpenHit}
      />
    </ApiClientProvider>,
  );
  return { GET, onOpenHit, ...utils };
}

const open = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Search all conversations" }));
  return screen.findByRole("searchbox", { name: "Search all conversations" });
};
const typeAndWait = async (box: HTMLElement, value: string) => {
  fireEvent.change(box, { target: { value } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
};
const alertText = () => screen.getByRole("alert").textContent;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

describe("global search panel", () => {
  it("renders nothing but the entry point until opened, and says plainly what it matches", async () => {
    mount(() => page([]));
    expect(screen.queryByRole("search")).toBeNull();
    const box = await open();
    expect(screen.getByRole("search", { name: "Search all conversations" })).toBeTruthy();
    expect(box.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.body.textContent).toMatch(/whole words and the beginning of a word only/);
    expect(document.body.textContent).toMatch(/does not find letters from the middle of a word/);
  });

  it("does not search under 3 characters and says so", async () => {
    const { GET } = mount(() => page([]));
    const box = await open();
    await typeAndWait(box, "ab");
    expect(GET).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Type at least 3 characters to search.");
  });

  it("shows a skeleton while loading, then results with channel, sender, time and the snippet as plain text", async () => {
    let resolve: (r: Reply) => void = () => {};
    const { container, GET } = mount(
      () =>
        new Promise<Reply>((r) => {
          resolve = r;
        }),
    );
    const box = await open();
    fireEvent.change(box, { target: { value: "hosp" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Searching…"));
    expect(container.querySelector(".wx-gsearch-skeleton")).not.toBeNull();
    await waitFor(() => expect(GET).toHaveBeenCalled());
    await act(async () => {
      resolve(page([hit("m1", "<img src=x onerror=alert(1)> hospice <b>bold</b>")]));
    });
    const list = await screen.findByRole("list", { name: "Search results" });
    const link = within(list).getByRole("link");
    expect(link.textContent).toContain("Care Team Alpha");
    expect(link.textContent).toContain("Other Nurse");
    expect(link.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-10T09:00:00.000Z");
    expect(link.textContent).toContain("<img src=x onerror=alert(1)> hospice <b>bold</b>");
    expect(container.querySelector("img, b")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("1 match");
    expect(container.querySelector(".wx-gsearch-skeleton")).toBeNull();
  });

  it("falls back to a neutral channel name and marks an archived conversation in words", async () => {
    mount(() => page([hit("m1", "hospice", { channelId: "gone", archived: true })]));
    await typeAndWait(await open(), "hosp");
    const link = await screen.findByRole("link");
    expect(link.textContent).toContain("A conversation you can no longer open");
    expect(link.textContent).toContain("Archived");
  });

  it("says 'No matches.' for an empty page", async () => {
    mount(() => page([]));
    await typeAndWait(await open(), "hosp");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("No matches."));
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("asks for a more specific word when the server says refine", async () => {
    mount(() => page([], { refine: true }));
    await typeAndWait(await open(), "hosp");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Too many matches - try a more specific word.",
      ),
    );
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("keeps results and says the search stopped early when the scan was capped", async () => {
    mount(() => page([hit("m1", "hospice")], { scanCapped: true }));
    await typeAndWait(await open(), "hosp");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "1 match. Search stopped early; refine to see more.",
      ),
    );
    expect(screen.getByRole("link")).toBeTruthy();
  });

  it("loads the next page with the cursor and appends", async () => {
    const { GET } = mount((init) =>
      init.params.query.cursor
        ? page([hit("m2", "second hospice")])
        : page([hit("m1", "first hospice")], { nextCursor: "CUR" }),
    );
    await typeAndWait(await open(), "hosp");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByText("second hospice");
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(GET.mock.calls[1]![1].params.query.cursor).toBe("CUR");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps loaded results and shows an inline error when Load more fails", async () => {
    mount((init) =>
      init.params.query.cursor
        ? reply(503)
        : page([hit("m1", "first hospice")], { nextCursor: "C" }),
    );
    await typeAndWait(await open(), "hosp");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(alertText()).toBe("Search is temporarily unavailable."));
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it.each([
    [503, undefined, "Search is temporarily unavailable.", true],
    [403, undefined, "Search is not turned on for your organisation.", false],
    [
      429,
      { "Retry-After": "12" },
      "Too many searches, wait a moment. Try again in 12 seconds.",
      true,
    ],
  ])("status %i shows its message (retry offered: %s)", async (status, headers, text, retry) => {
    mount(() => reply(status, undefined, headers));
    await typeAndWait(await open(), "hosp");
    await waitFor(() => expect(alertText()).toContain(text));
    expect(!!screen.queryByRole("button", { name: "Retry" })).toBe(retry);
  });

  it("429 without Retry-After still says to wait", async () => {
    mount(() => reply(429));
    await typeAndWait(await open(), "hosp");
    await waitFor(() => expect(alertText()).toContain("Too many searches, wait a moment."));
  });

  it("403 gives no reason, and stops asking on later keystrokes", async () => {
    const { GET } = mount(() =>
      reply(403, { error: { code: "GLOBAL_SEARCH_DISABLED", message: "admin must enable it" } }),
    );
    const box = await open();
    await typeAndWait(box, "hosp");
    await waitFor(() => expect(alertText()).toBe("Search is not turned on for your organisation."));
    expect(document.body.textContent).not.toMatch(/admin|enable|why/i);
    await typeAndWait(box, "hospi");
    expect(GET).toHaveBeenCalledTimes(1);
    expect(alertText()).toBe("Search is not turned on for your organisation.");
  });

  it("422 shows the server's validation message", async () => {
    mount(() =>
      reply(422, { error: { code: "INVALID_SEARCH_QUERY", message: "Use at most 8 words." } }),
    );
    await typeAndWait(await open(), "hosp");
    await waitFor(() => expect(alertText()).toBe("Use at most 8 words."));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offline: shows a message and Retry re-issues the search", async () => {
    let calls = 0;
    const { GET } = mount(() => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return page([hit("m1", "hospice")]);
    });
    await typeAndWait(await open(), "hosp");
    await waitFor(() => expect(alertText()).toMatch(/offline/));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await screen.findByRole("link");
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("aborts the in-flight request when the query changes, and never shows the stale reply", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(r: Reply) => void> = [];
    mount((init) => {
      signals.push(init.signal);
      return new Promise<Reply>((r) => resolvers.push(r));
    });
    const box = await open();
    await typeAndWait(box, "hosp");
    expect(signals).toHaveLength(1);
    await typeAndWait(box, "hospi");
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    await act(async () => {
      resolvers[0]!(page([hit("old", "stale hospice")]));
      resolvers[1]!(page([hit("new", "fresh hospice")]));
    });
    await screen.findByText("fresh hospice");
    expect(screen.queryByText("stale hospice")).toBeNull();
  });

  it("aborts on close", async () => {
    const signals: AbortSignal[] = [];
    mount((init) => {
      signals.push(init.signal);
      return new Promise<Reply>(() => {});
    });
    const box = await open();
    await typeAndWait(box, "hosp");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(signals[0]!.aborted).toBe(true);
  });

  it("never puts the query in the URL or in browser storage, and sends it only as the request", async () => {
    const before = window.location.href;
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const { GET } = mount(() => page([hit("m1", "secretword here")]));
    await typeAndWait(await open(), "secretword");
    await screen.findByRole("link");
    expect(window.location.href).toBe(before);
    expect(window.location.href).not.toContain("secretword");
    const written = [...setItem.mock.calls, ...pushState.mock.calls, ...replaceState.mock.calls];
    expect(JSON.stringify(written)).not.toContain("secretword");
    expect(GET.mock.calls[0]![1].params.query.q).toBe("secretword");
    expect(screen.getByRole("link").getAttribute("href")).not.toContain("secretword");
  });

  it("clears the query on close", async () => {
    mount(() => page([]));
    const box = await open();
    await typeAndWait(box, "hosp");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(((await open()) as HTMLInputElement).value).toBe("");
  });

  it("opens the hit through the handler, preventing navigation, and closes", async () => {
    const onOpenHit = vi.fn(() => Promise.resolve(true));
    mount(() => page([hit("m1", "hospice")]), onOpenHit);
    await typeAndWait(await open(), "hosp");
    fireEvent.click(await screen.findByRole("link"));
    expect(onOpenHit).toHaveBeenCalledWith("ch-1", "m1");
    await waitFor(() => expect(screen.queryByRole("search")).toBeNull());
  });

  it("stays open with a message when the conversation cannot be opened", async () => {
    mount(
      () => page([hit("m1", "hospice")]),
      () => Promise.resolve(false),
    );
    await typeAndWait(await open(), "hosp");
    fireEvent.click(await screen.findByRole("link"));
    await waitFor(() =>
      expect(alertText()).toBe("That conversation is no longer available to you."),
    );
    expect(screen.getByRole("search")).toBeTruthy();
  });
});

describe("global search paging, refusal and click hardening", () => {
  afterEach(() => vi.restoreAllMocks());

  const withMore = (over: (init: SearchInit) => Promise<Reply> | Reply) => (init: SearchInit) =>
    init.params.query.cursor ? over(init) : page([hit("m1", "first hospice")], { nextCursor: "C" });

  it("aborts an in-flight Load more when the query changes", async () => {
    const signals: AbortSignal[] = [];
    mount(
      withMore((init) => {
        signals.push(init.signal);
        return new Promise<Reply>(() => {});
      }),
    );
    const box = await open();
    await typeAndWait(box, "hosp");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.change(box, { target: { value: "hospi" } });
    expect(signals[0]!.aborted).toBe(true);
  });

  it("aborts an in-flight Load more on close", async () => {
    const signals: AbortSignal[] = [];
    mount(
      withMore((init) => {
        signals.push(init.signal);
        return new Promise<Reply>(() => {});
      }),
    );
    const box = await open();
    await typeAndWait(box, "hosp");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.keyDown(box, { key: "Escape" });
    expect(signals[0]!.aborted).toBe(true);
  });

  it("shows the not-turned-on message when Load more is refused with 403", async () => {
    mount(withMore(() => reply(403)));
    await typeAndWait(await open(), "hosp");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(alertText()).toContain("Search is not turned on for your organisation."),
    );
  });

  it("forgets a 403 when the panel is closed, so reopening asks the server again", async () => {
    let calls = 0;
    const { GET } = mount(() => {
      calls += 1;
      return calls === 1 ? reply(403) : page([hit("m1", "hospice")]);
    });
    const box = await open();
    await typeAndWait(box, "hosp");
    await waitFor(() => expect(alertText()).toContain("not turned on"));
    fireEvent.keyDown(box, { key: "Escape" });
    await typeAndWait(await open(), "hosp");
    await screen.findByRole("link");
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("drops a message repeated on a later page", async () => {
    mount(withMore(() => page([hit("m1", "first hospice"), hit("m2", "second hospice")])));
    await typeAndWait(await open(), "hosp");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByText("second hospice");
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it.each([
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["middle", { button: 1 }],
  ])("leaves a %s-click to the browser", async (_name, init) => {
    const onOpenHit = vi.fn(() => Promise.resolve(true));
    mount(() => page([hit("m1", "hospice")]), onOpenHit);
    await typeAndWait(await open(), "hosp");
    const link = await screen.findByRole("link");
    let prevented = true;
    const record = (event: Event): void => {
      prevented = event.defaultPrevented;
      event.preventDefault(); // keep jsdom from attempting a real navigation
    };
    document.addEventListener("click", record);
    fireEvent.click(link, init);
    document.removeEventListener("click", record);
    expect(prevented).toBe(false);
    expect(onOpenHit).not.toHaveBeenCalled();
  });

  it("opens a hit once when it is clicked twice quickly", async () => {
    let finish: (v: boolean) => void = () => {};
    const onOpenHit = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          finish = r;
        }),
    );
    mount(() => page([hit("m1", "hospice")]), onOpenHit);
    await typeAndWait(await open(), "hosp");
    const link = await screen.findByRole("link");
    fireEvent.click(link);
    fireEvent.click(link);
    expect(onOpenHit).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
  });
});

describe("global search keyboard and accessibility", () => {
  it("walks input -> results -> input with arrows, Escape closes and returns focus to the entry point", async () => {
    mount(() => page([hit("m1", "one hospice"), hit("m2", "two hospice")]));
    const box = await open();
    expect(document.activeElement).toBe(box);
    await typeAndWait(box, "hosp");
    const links = await screen.findAllByRole("link");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(links[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[1]);
    fireEvent.keyDown(links[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(links[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Search all conversations" }),
    );
  });

  it("announces results in a polite live region", async () => {
    mount(() => page([hit("m1", "hospice")]));
    await open();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("has no axe violations with results showing (contrast is covered elsewhere)", async () => {
    const { container } = mount(() => page([hit("m1", "hospice")], { nextCursor: "C" }));
    await typeAndWait(await open(), "hosp");
    await screen.findByRole("link");
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});
