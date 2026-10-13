/**
 * WP 2.5 server drafts in the web client: restore on open, debounced autosave, discard on empty, thread-root scoping,
 * and the cross-device merge prompt (keep mine / use theirs / combine) with keyboard focus.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { DraftConflictPrompt, escapeKeepsMine } from "./draft-conflict-prompt";
import type { MessageReferenceInput } from "./messaging-types";
import {
  DRAFT_SAVE_DEBOUNCE_MS,
  MAX_SAVE_ATTEMPTS,
  mergeDraftBodies,
  useServerDraft,
} from "./use-server-draft";

const DRAFT_PATH = "/api/v1/messaging/channels/{id}/draft";
const serverDraft = (over: Record<string, unknown> = {}) => ({
  channelId: "ch-1",
  parentMessageId: null,
  body: "from the server",
  references: [],
  revision: 4,
  deviceId: "other-device",
  updatedAt: "2026-10-12T10:00:00.000Z",
  ...over,
});

function makeApi(initial: Record<string, unknown> | null = null) {
  let current = initial;
  const api = {
    GET: vi.fn(async () => ({
      data: { draft: current },
      error: undefined,
      response: { status: 200 },
    })),
    PUT: vi.fn(async (_p: string, init: Record<string, any>): Promise<any> => {
      current = serverDraft({
        body: init.body.body,
        revision: init.body.baseRevision + 1,
        deviceId: init.body.deviceId,
      });
      return { data: { draft: current }, error: undefined, response: { status: 200 } };
    }),
    DELETE: vi.fn(async () => {
      current = null;
      return { data: undefined, error: undefined, response: { status: 204 } };
    }),
  };
  return api;
}

const NO_REFS: MessageReferenceInput[] = [];
interface HookProps {
  text: string;
  refs?: MessageReferenceInput[];
  parent?: string | null;
  suspended?: boolean;
}

/** The session the wrapper provides; a test swaps it to model an in-page identity change. */
let sessionNow: Session | null = null;
const sessionOf = (userId: string): Session => ({
  userId,
  organizationId: "org-1",
  organizationName: "Org",
});

function setup(api: ReturnType<typeof makeApi>, initialText = "") {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={api as unknown as ApiClient}>
      <SessionProvider session={sessionNow}>{children}</SessionProvider>
    </ApiClientProvider>
  );
  const hydrate = vi.fn();
  const view = renderHook<ReturnType<typeof useServerDraft>, HookProps>(
    (props) =>
      useServerDraft({
        channelId: "ch-1",
        parentMessageId: props.parent ?? null,
        text: props.text,
        references: props.refs ?? NO_REFS,
        suspended: props.suspended,
        hydrate,
      }),
    { wrapper, initialProps: { text: initialText } },
  );
  return { view, hydrate };
}
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  sessionNow = null;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("mergeDraftBodies", () => {
  it("appends theirs after mine and shifts their references", () => {
    const merged = mergeDraftBodies(
      {
        body: "mine",
        references: [{ kind: "staff", entityId: "a", start: 0, end: 2, displayLabel: "a" }],
      },
      {
        body: "@b theirs",
        references: [{ kind: "staff", entityId: "b", start: 0, end: 2, displayLabel: "b" }],
      },
    );
    expect(merged.body).toBe("mine\n\n@b theirs");
    expect(merged.references).toEqual([
      { kind: "staff", entityId: "a", start: 0, end: 2, displayLabel: "a" },
      { kind: "staff", entityId: "b", start: 6, end: 8, displayLabel: "b" },
    ]);
  });
  it("returns the other side when one is blank", () => {
    expect(
      mergeDraftBodies({ body: " ", references: [] }, { body: "x", references: [] }).body,
    ).toBe("x");
  });
});

describe("useServerDraft", () => {
  it("restores the server draft into an empty composer", async () => {
    const api = makeApi(serverDraft());
    const { hydrate } = setup(api);
    await flush();
    expect(api.GET).toHaveBeenCalledWith(
      DRAFT_PATH,
      expect.objectContaining({ params: expect.anything() }),
    );
    expect(hydrate).toHaveBeenCalledWith("from the server", []);
  });

  it("does not overwrite text the user already has", async () => {
    const api = makeApi(serverDraft());
    const { hydrate } = setup(api, "typed already");
    await flush();
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("autosaves once after the debounce, not on every keystroke", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    view.rerender({ text: "h" });
    await tick(500);
    view.rerender({ text: "hello" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS - 1);
    expect(api.PUT).not.toHaveBeenCalled();
    await tick(2);
    expect(api.PUT).toHaveBeenCalledTimes(1);
    expect(api.PUT.mock.calls[0]?.[1].body).toMatchObject({ body: "hello", baseRevision: 0 });
    expect(api.PUT.mock.calls[0]?.[1].body.deviceId).toBeTruthy();
    // the next save is based on the revision the server returned
    view.rerender({ text: "hello there" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT.mock.calls[1]?.[1].body).toMatchObject({ body: "hello there", baseRevision: 1 });
  });

  it("discards the server draft as soon as the composer is emptied (e.g. after a send)", async () => {
    const api = makeApi(serverDraft());
    const { view } = setup(api, "text");
    await flush();
    view.rerender({ text: "" });
    await flush();
    expect(api.DELETE).toHaveBeenCalledTimes(1);
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("scopes a thread draft by its root", async () => {
    const api = makeApi();
    const { view } = setup(api);
    view.rerender({ text: "reply", parent: "root-1" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT.mock.calls[0]?.[1].body.parentMessageId).toBe("root-1");
  });

  it("raises the merge prompt on a 409 and resolves it", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    api.PUT.mockImplementationOnce(async () => ({
      data: undefined,
      error: { error: { code: "DRAFT_CONFLICT" } },
      response: { status: 409 },
    }));
    api.GET.mockImplementation(async () => ({
      data: { draft: serverDraft() },
      error: undefined,
      response: { status: 200 },
    }));
    view.rerender({ text: "mine" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(view.result.current.conflict?.server.body).toBe("from the server");
    expect(view.result.current.conflict?.mine.body).toBe("mine");
    act(() => view.result.current.resolve("theirs"));
    expect(view.result.current.conflict).toBeNull();
  });

  it("keep-mine re-saves on top of the server revision", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    api.PUT.mockImplementationOnce(async () => ({
      data: undefined,
      error: { error: { code: "DRAFT_CONFLICT" } },
      response: { status: 409 },
    }));
    api.GET.mockImplementation(async () => ({
      data: { draft: serverDraft() },
      error: undefined,
      response: { status: 200 },
    }));
    view.rerender({ text: "mine" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    act(() => view.result.current.resolve("mine"));
    await flush();
    expect(api.PUT.mock.calls.at(-1)?.[1].body).toMatchObject({ body: "mine", baseRevision: 4 });
  });

  it("flags a failed save without losing the text, and retries on the next change", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    api.PUT.mockRejectedValueOnce(new Error("offline"));
    view.rerender({ text: "abc" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(view.result.current.saveFailed).toBe(true);
    view.rerender({ text: "abcd" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(view.result.current.saveFailed).toBe(false);
  });
});

const conflictingPut = () =>
  vi.fn(async () => ({
    data: undefined,
    error: { error: { code: "DRAFT_CONFLICT" } },
    response: { status: 409 },
  }));

describe("useServerDraft review fixes (Tranche B)", () => {
  async function openConflict(
    api: ReturnType<typeof makeApi>,
    view: ReturnType<typeof setup>["view"],
  ) {
    api.PUT.mockImplementationOnce(conflictingPut());
    api.GET.mockImplementation(async () => ({
      data: { draft: serverDraft() },
      error: undefined,
      response: { status: 200 },
    }));
    view.rerender({ text: "mine" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(view.result.current.conflict).not.toBeNull();
  }

  it("H1: emptying the composer (a send) while the merge prompt is open discards, clears the prompt, and never re-saves the sent text", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    await openConflict(api, view);
    view.rerender({ text: "" });
    await flush();
    expect(view.result.current.conflict).toBeNull();
    expect(api.DELETE).toHaveBeenCalledTimes(1);
    api.PUT.mockClear();
    act(() => view.result.current.resolve("mine"));
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("H1/M6: text typed while the prompt is open is what Keep mine saves, and the prompt shows it", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    await openConflict(api, view);
    view.rerender({ text: "mine, and more" });
    await flush();
    expect(view.result.current.conflict?.mine.body).toBe("mine, and more");
    act(() => view.result.current.resolve("mine"));
    await flush();
    expect(api.PUT.mock.calls.at(-1)?.[1].body).toMatchObject({
      body: "mine, and more",
      baseRevision: 4,
    });
  });

  it("M6: a 409 raised for older text reports the latest text as mine", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    let release: (() => void) | undefined;
    api.PUT.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ data: undefined, error: { error: {} }, response: { status: 409 } });
        }),
    );
    api.GET.mockImplementation(async () => ({
      data: { draft: serverDraft() },
      error: undefined,
      response: { status: 200 },
    }));
    view.rerender({ text: "old" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    view.rerender({ text: "old plus newer" });
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.result.current.conflict?.mine.body).toBe("old plus newer");
  });

  it("H3: nothing is saved or flushed for a send in flight", async () => {
    const api = makeApi();
    const { view } = setup(api, "");
    await flush();
    view.rerender({ text: "being sent", suspended: true });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT).not.toHaveBeenCalled();
    view.rerender({ text: "being sent", suspended: true });
    view.unmount();
    await flush();
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("H3: a pending save is not flushed on unmount while a send is in flight", async () => {
    const api = makeApi();
    const { view } = setup(api, "");
    await flush();
    view.rerender({ text: "typed" });
    view.rerender({ text: "typed", suspended: true });
    view.unmount();
    await flush();
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("I1: leaving a slot flushes its pending text when the identity is unchanged (control for I2)", async () => {
    sessionNow = sessionOf("user-a");
    const api = makeApi();
    const { view } = setup(api, "");
    await flush();
    view.rerender({ text: "typed" });
    view.rerender({ text: "", parent: "root-1" }); // the same slot-switch path as I2
    await flush();
    expect(api.PUT).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("I1b: the unmount flush is sent when the identity is unchanged", async () => {
    sessionNow = sessionOf("user-a");
    const api = makeApi();
    const { view } = setup(api, "");
    await flush();
    view.rerender({ text: "typed" });
    view.unmount();
    await flush();
    expect(api.PUT).toHaveBeenCalledTimes(1);
  });

  it("I2: the unmount flush is skipped when the session identity changed since the text was typed", async () => {
    sessionNow = sessionOf("user-a");
    const api = makeApi();
    const { view } = setup(api, "");
    await flush();
    view.rerender({ text: "user A private text" });
    sessionNow = sessionOf("user-b"); // swapped in-page: the shared client would now send as user B
    view.rerender({ text: "", parent: "root-1" }); // leaves A's slot; the next composer is empty
    await flush();
    view.unmount();
    await flush();
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("I3: a composer that stays mounted never sends its armed debounce under a different identity", async () => {
    sessionNow = sessionOf("user-a");
    const api = makeApi();
    const { view } = setup(api, "");
    await flush();
    view.rerender({ text: "user A private text" });
    sessionNow = sessionOf("user-b");
    view.rerender({ text: "user A private text" }); // same slot, no unmount
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("I4: a save queued behind an in-flight one is dropped when the identity changed meanwhile", async () => {
    sessionNow = sessionOf("user-a");
    const api = makeApi();
    let release: () => void = () => undefined;
    api.PUT.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              data: { draft: serverDraft({ body: "one", revision: 1, deviceId: "d" }) },
              error: undefined,
              response: { status: 200 },
            });
        }),
    );
    const { view } = setup(api, "");
    await flush();
    view.rerender({ text: "one" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1); // PUT #1 is in flight
    expect(api.PUT).toHaveBeenCalledTimes(1);
    view.rerender({ text: "one two" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1); // save #2 is queued behind it
    sessionNow = sessionOf("user-b");
    view.rerender({ text: "one two" });
    release();
    await flush();
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT).toHaveBeenCalledTimes(1);
  });

  it("I5: an identity unknown while the session loaded is adopted, so a legitimate draft still flushes", async () => {
    sessionNow = null; // session still loading when the slot opened
    const api = makeApi();
    const { view } = setup(api, "");
    await flush();
    sessionNow = sessionOf("user-a");
    view.rerender({ text: "typed after load" });
    view.rerender({ text: "", parent: "root-1" });
    await flush();
    expect(api.PUT).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("I6: a draft read for user A that lands after an in-page swap to B is not hydrated into the composer", async () => {
    sessionNow = sessionOf("user-a");
    const api = makeApi();
    let land: () => void = () => undefined;
    api.GET.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = () =>
            resolve({
              data: { draft: serverDraft({ body: "A's private draft" }) },
              error: undefined,
              response: { status: 200 },
            });
        }),
    );
    const { view, hydrate } = setup(api, "");
    await flush();
    sessionNow = sessionOf("user-b");
    view.rerender({ text: "" }); // same slot, still mounted
    land();
    await flush();
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("I7: a 409 whose follow-up read resolves after an in-page swap raises no merge prompt", async () => {
    sessionNow = sessionOf("user-a");
    const api = makeApi();
    api.PUT.mockImplementationOnce(async () => ({
      data: undefined,
      error: { error: { code: "CONFLICT" } },
      response: { status: 409 },
    }));
    const { view, hydrate } = setup(api, "");
    await flush();
    let land: () => void = () => undefined;
    api.GET.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = () =>
            resolve({
              data: { draft: serverDraft({ body: "A's other-device draft" }) },
              error: undefined,
              response: { status: 200 },
            });
        }),
    );
    view.rerender({ text: "A typed this" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1); // PUT 409 under A, the follow-up read is in flight
    sessionNow = sessionOf("user-b");
    view.rerender({ text: "A typed this" });
    land();
    await flush();
    expect(view.result.current.conflict).toBeNull();
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("I8: an identity that becomes known after open is adopted at once, so A then B inside one debounce sends nothing", async () => {
    sessionNow = null; // loading when the slot opened
    const api = makeApi();
    const { view } = setup(api, "");
    await flush();
    sessionNow = sessionOf("user-a");
    view.rerender({ text: "A typed this" });
    sessionNow = sessionOf("user-b");
    view.rerender({ text: "A typed this" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("M4: a 5xx on discarding the server copy is a failed save, not success", async () => {
    const api = makeApi(serverDraft());
    const { view } = setup(api, "text");
    await flush();
    api.DELETE.mockImplementationOnce((async () => ({
      data: undefined,
      error: { error: { code: "INTERNAL" } },
      response: { status: 500 },
    })) as never);
    view.rerender({ text: "" });
    await flush();
    expect(view.result.current.saveFailed).toBe(true);
  });

  it("M5: a failed autosave is retried on its own, without another keystroke", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    api.PUT.mockRejectedValueOnce(new Error("offline"));
    view.rerender({ text: "abc" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(view.result.current.saveFailed).toBe(true);
    expect(api.PUT).toHaveBeenCalledTimes(1);
    await tick(60_000);
    expect(api.PUT).toHaveBeenCalledTimes(2);
    expect(view.result.current.saveFailed).toBe(false);
  });
});

describe("DraftConflictPrompt", () => {
  const conflict = {
    server: {
      body: "theirs text",
      references: [],
      revision: 4,
      deviceId: "d2",
      updatedAt: "2026-10-12T10:00:00.000Z",
    },
    mine: { body: "mine text", references: [] },
  };
  it("is announced, focuses its first action and offers the three resolutions", () => {
    vi.useRealTimers();
    const onResolve = vi.fn();
    render(<DraftConflictPrompt conflict={conflict} onResolve={onResolve} />);
    expect(screen.getByRole("alert", { name: /changed on another device/i })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep mine" }));
    fireEvent.click(screen.getByRole("button", { name: "Use theirs" }));
    fireEvent.click(screen.getByRole("button", { name: "Combine both" }));
    expect(onResolve.mock.calls.map((c) => c[0])).toEqual(["theirs", "both"]);
  });
  it("Escape keeps the user's own text", async () => {
    vi.useRealTimers();
    const onResolve = vi.fn();
    render(<DraftConflictPrompt conflict={conflict} onResolve={onResolve} />);
    fireEvent.keyDown(screen.getByRole("alert"), { key: "Escape" });
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("mine"));
  });
  it("H2: does not steal focus from a composer the user is typing in", () => {
    vi.useRealTimers();
    const area = document.createElement("textarea");
    document.body.appendChild(area);
    area.focus();
    render(<DraftConflictPrompt conflict={conflict} onResolve={vi.fn()} />);
    expect(document.activeElement).toBe(area);
    area.remove();
  });
  it("M12: two prompts do not share element ids", () => {
    vi.useRealTimers();
    render(
      <>
        <DraftConflictPrompt conflict={conflict} onResolve={vi.fn()} />
        <DraftConflictPrompt conflict={conflict} onResolve={vi.fn()} />
      </>,
    );
    const ids = Array.from(document.querySelectorAll("[id]")).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("useServerDraft second review round", () => {
  const failing = (status: number) =>
    (async () => ({
      data: undefined,
      error: { error: { code: "X" } },
      response: { status },
    })) as never;

  it("1: a 403 is permanent: no retry, and the hook says it gave up", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    api.PUT.mockImplementation(failing(403));
    view.rerender({ text: "abc" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(view.result.current.saveFailed).toBe(true);
    expect(view.result.current.saveGaveUp).toBe(true);
    await tick(10 * 60_000);
    expect(api.PUT).toHaveBeenCalledTimes(1);
  });

  it("1: a 413 is permanent too", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    api.PUT.mockImplementation(failing(413));
    view.rerender({ text: "abc" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    await tick(10 * 60_000);
    expect(api.PUT).toHaveBeenCalledTimes(1);
    expect(view.result.current.saveGaveUp).toBe(true);
  });

  it("1: a 503 retries and then stops at the attempt cap", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    api.PUT.mockImplementation(failing(503));
    view.rerender({ text: "abc" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    await tick(60 * 60_000);
    expect(api.PUT).toHaveBeenCalledTimes(MAX_SAVE_ATTEMPTS);
    expect(view.result.current.saveGaveUp).toBe(true);
  });

  it("1: a 429 is retried and recovers", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    api.PUT.mockImplementationOnce(failing(429));
    view.rerender({ text: "abc" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(view.result.current.saveGaveUp).toBe(false);
    await tick(60_000);
    expect(api.PUT).toHaveBeenCalledTimes(2);
    expect(view.result.current.saveFailed).toBe(false);
  });

  it("1: after giving up, new typing re-arms a save", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    api.PUT.mockImplementationOnce(failing(403));
    view.rerender({ text: "abc" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(view.result.current.saveGaveUp).toBe(true);
    view.rerender({ text: "abcd" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT).toHaveBeenCalledTimes(2);
    expect(view.result.current.saveGaveUp).toBe(false);
  });

  it("2: a 404 on discarding a draft the send already removed is success, with no retry loop", async () => {
    const api = makeApi(serverDraft());
    const { view } = setup(api, "text");
    await flush();
    api.DELETE.mockImplementation(failing(404));
    view.rerender({ text: "" });
    await flush();
    await tick(10 * 60_000);
    expect(api.DELETE).toHaveBeenCalledTimes(1);
    expect(view.result.current.saveFailed).toBe(false);
  });

  it("3: resolving the merge prompt while a send is in flight saves nothing until it settles", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    api.PUT.mockImplementationOnce(conflictingPut());
    api.GET.mockImplementation(async () => ({
      data: { draft: serverDraft() },
      error: undefined,
      response: { status: 200 },
    }));
    view.rerender({ text: "mine" });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(view.result.current.conflict).not.toBeNull();
    api.PUT.mockClear();
    view.rerender({ text: "mine", suspended: true });
    act(() => view.result.current.resolve("mine"));
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT).not.toHaveBeenCalled();
  });

  it("4: switching to another thread root inside the debounce still saves the text to the OLD slot", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    view.rerender({ text: "typed for root one", parent: "root-1" });
    await flush();
    view.rerender({ text: "", parent: "root-2" });
    await flush();
    const first = api.PUT.mock.calls[0]?.[1].body;
    expect(first).toMatchObject({ body: "typed for root one", parentMessageId: "root-1" });
  });

  it("4b: the slot-switch flush sends the OLD slot's revision, not the next slot's reset one", async () => {
    const api = makeApi(serverDraft({ revision: 5, parentMessageId: null }));
    const { view } = setup(api);
    await flush();
    view.rerender({ text: "typed over revision five" });
    view.rerender({ text: "", parent: "root-2" });
    await flush();
    expect(api.PUT.mock.calls[0]?.[1].body).toMatchObject({
      body: "typed over revision five",
      baseRevision: 5,
    });
  });

  it("6: a failed send (suspended then released) keeps the text and autosaves it again", async () => {
    const api = makeApi();
    const { view } = setup(api);
    await flush();
    view.rerender({ text: "kept after a failed send", suspended: true });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT).not.toHaveBeenCalled();
    view.rerender({ text: "kept after a failed send", suspended: false });
    await tick(DRAFT_SAVE_DEBOUNCE_MS + 1);
    expect(api.PUT.mock.calls[0]?.[1].body).toMatchObject({ body: "kept after a failed send" });
  });
});

describe("5: Escape in the composer while the merge prompt is open", () => {
  const conflictValue = {
    server: { body: "t", references: [], revision: 2, deviceId: "d", updatedAt: "x" },
    mine: { body: "m", references: [] },
  };
  it("keeps the user's text and is consumed", () => {
    const resolve = vi.fn();
    const event = { key: "Escape", preventDefault: vi.fn() };
    expect(escapeKeepsMine(event, { conflict: conflictValue, resolve })).toBe(true);
    expect(resolve).toHaveBeenCalledWith("mine");
    expect(event.preventDefault).toHaveBeenCalled();
  });
  it("does nothing without an open prompt or for another key", () => {
    const resolve = vi.fn();
    const escKey = { key: "Escape", preventDefault: vi.fn() };
    const letter = { key: "a", preventDefault: vi.fn() };
    expect(escapeKeepsMine(escKey, { conflict: null, resolve })).toBe(false);
    expect(escapeKeepsMine(letter, { conflict: conflictValue, resolve })).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
});
