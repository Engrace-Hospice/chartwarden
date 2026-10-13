/**
 * WP 2.5 server drafts in the web client: restore on open, debounced autosave, discard on empty, thread-root scoping,
 * and the cross-device merge prompt (keep mine / use theirs / combine) with keyboard focus.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftConflictPrompt } from "./draft-conflict-prompt";
import type { MessageReferenceInput } from "./messaging-types";
import { DRAFT_SAVE_DEBOUNCE_MS, mergeDraftBodies, useServerDraft } from "./use-server-draft";

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

interface HookProps {
  text: string;
  refs?: MessageReferenceInput[];
  parent?: string | null;
}

function setup(api: ReturnType<typeof makeApi>, initialText = "") {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={api as unknown as ApiClient}>{children}</ApiClientProvider>
  );
  const hydrate = vi.fn();
  const view = renderHook<ReturnType<typeof useServerDraft>, HookProps>(
    (props) =>
      useServerDraft({
        channelId: "ch-1",
        parentMessageId: props.parent ?? null,
        text: props.text,
        references: props.refs ?? [],
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

beforeEach(() => vi.useFakeTimers());
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
    expect(screen.getByRole("alertdialog", { name: /changed on another device/i })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep mine" }));
    fireEvent.click(screen.getByRole("button", { name: "Use theirs" }));
    fireEvent.click(screen.getByRole("button", { name: "Combine both" }));
    expect(onResolve.mock.calls.map((c) => c[0])).toEqual(["theirs", "both"]);
  });
  it("Escape keeps the user's own text", async () => {
    vi.useRealTimers();
    const onResolve = vi.fn();
    render(<DraftConflictPrompt conflict={conflict} onResolve={onResolve} />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("mine"));
  });
});
