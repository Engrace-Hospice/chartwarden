import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_ID,
  STORE_PATHS,
  attach,
  authorizedWith,
  calls,
  channel,
  chipList,
  completed,
  envelope,
  mountThread,
  pdf,
  sendButton,
  status,
} from "./attachments-test-support";

const inList = () => within(chipList()!);
const flush = () => act(async () => {});
const setDraft = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value } });
const textbox = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
// Sorted: the queue runs two uploads at once, so which of them reaches the server first depends on hashing speed.
const uploadNames = (api: Parameters<typeof calls>[0]) =>
  calls(api, STORE_PATHS.uploads)
    .map(([, init]) => init.body.fileName as string)
    .sort();
const idOf = (init: Record<string, unknown>) => (init.params as { path: { id: string } }).path.id;

describe("WP 1.5 recheck after a refused send", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const refusedSend = (statusReply: (id: string) => unknown) =>
    mountThread({
      POST: (path, init) => {
        if (path === STORE_PATHS.uploads) {
          const name = (init.body as { fileName: string }).fileName;
          return authorizedWith(name === "a.pdf" ? "id-a" : "id-b");
        }
        if (path === STORE_PATHS.complete) return completed("available");
        if (path === STORE_PATHS.messages) return envelope("ATTACHMENT_NOT_BINDABLE", "x", 422);
        return undefined;
      },
      GET: (path, init) => (path === STORE_PATHS.status ? statusReply(idOf(init)) : undefined),
    });

  async function sendRefused() {
    await attach([pdf("a.pdf"), pdf("b.pdf")]);
    await waitFor(() => expect(inList().getAllByText("Ready")).toHaveLength(2));
    setDraft("keep me");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await screen.findByText(/can no longer be attached/);
  }

  it.each([401, 403, 408, 429, 500, 503])(
    "leaves the chips alone when the status read is answered %i",
    async (httpStatus) => {
      const { api } = refusedSend(() => ({
        data: undefined,
        error: { error: { code: "X" } },
        response: { status: httpStatus },
      }));
      await sendRefused();
      await waitFor(() =>
        expect(api.GET.mock.calls.filter(([p]) => p === STORE_PATHS.status)).toHaveLength(2),
      );
      await flush();
      expect(inList().getAllByText("Ready")).toHaveLength(2);
      expect(inList().queryByText("Blocked")).toBeNull();
      expect(textbox().value).toBe("keep me");
    },
  );

  it("leaves the chips alone when the status read throws", async () => {
    const { api } = mountThread({
      POST: (path, init) => {
        if (path === STORE_PATHS.uploads) {
          return authorizedWith((init.body as { fileName: string }).fileName);
        }
        if (path === STORE_PATHS.complete) return completed("available");
        if (path === STORE_PATHS.messages) return envelope("ATTACHMENT_NOT_BINDABLE", "x", 422);
        return undefined;
      },
    });
    api.GET.mockImplementation((path: string) =>
      path === STORE_PATHS.status
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ data: { messages: [] }, error: undefined }),
    );
    await sendRefused();
    await flush();
    expect(inList().getAllByText("Ready")).toHaveLength(2);
  });

  it.each([404, 410])("marks a chip Blocked when its file is gone (%i)", async (httpStatus) => {
    refusedSend((id) =>
      id === "id-a"
        ? { data: undefined, error: { error: {} }, response: { status: httpStatus } }
        : { data: status("available"), error: undefined },
    );
    await sendRefused();
    await waitFor(() => expect(inList().getByText("Blocked")).toBeTruthy());
    expect(inList().getAllByText("Ready")).toHaveLength(1);
    expect(inList().getByText(/no longer available/)).toBeTruthy();
  });

  it("keeps polling a scanning file through a 403 instead of failing it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = mountThread({
      POST: (path) =>
        path === STORE_PATHS.uploads
          ? authorizedWith(ATTACHMENT_ID)
          : path === STORE_PATHS.complete
            ? completed("scanning")
            : undefined,
      GET: (path) =>
        path === STORE_PATHS.status
          ? { data: undefined, error: { error: {} }, response: { status: 403 } }
          : undefined,
    });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Scanning…")).toBeTruthy());
    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    const polls = api.GET.mock.calls.filter(([p]) => p === STORE_PATHS.status).length;
    expect(polls).toBeGreaterThan(2);
    expect(inList().getByText("Scanning…")).toBeTruthy();
  });
});

describe("WP 1.5 chip live region", () => {
  it("announces only the changed chip, not the whole list", async () => {
    const { view } = mountThread({
      POST: (path) =>
        path === STORE_PATHS.uploads
          ? authorizedWith(ATTACHMENT_ID)
          : path === STORE_PATHS.complete
            ? completed("available")
            : undefined,
    });
    const region = view.container.querySelector("output.sr-only");
    expect(region?.getAttribute("aria-atomic")).toBe("false");
    expect(region?.getAttribute("aria-relevant")).toBe("additions text");
    await attach([pdf()]);
    await waitFor(() => expect(region?.textContent).toContain("report.pdf: Ready"));
  });
});

describe("WP 1.5 upload queue", () => {
  const gated = () => {
    const releases = new Map<string, () => void>();
    const handlers = {
      POST: (path: string, init: Record<string, unknown>) => {
        if (path === STORE_PATHS.complete) return completed("available");
        if (path !== STORE_PATHS.uploads) return undefined;
        const name = (init.body as { fileName: string }).fileName;
        return new Promise((resolve) =>
          releases.set(name, () => resolve(authorizedWith(`id-${name}`))),
        );
      },
    };
    return { releases, handlers };
  };

  it("lets the next queued file proceed when a running one fails", async () => {
    const { handlers, releases } = gated();
    const { api } = mountThread({
      POST: (path, init) => {
        const name = (init.body as { fileName?: string } | undefined)?.fileName;
        if (path === STORE_PATHS.uploads && name === "a.pdf") {
          return envelope("UNSUPPORTED_MEDIA_TYPE", "no", 415);
        }
        return handlers.POST(path, init);
      },
    });
    await attach([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]);
    await waitFor(() => expect(uploadNames(api)).toEqual(["a.pdf", "b.pdf", "c.pdf"]));
    await waitFor(() => expect(inList().getByText("Failed")).toBeTruthy());
    await act(async () => releases.get("b.pdf")?.());
    await act(async () => releases.get("c.pdf")?.());
    await waitFor(() => expect(inList().getAllByText("Ready")).toHaveLength(2));
  });

  it("never starts a queued file that was removed before it ran", async () => {
    const { handlers, releases } = gated();
    const { api } = mountThread({ POST: handlers.POST });
    await attach([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]);
    await waitFor(() => expect(uploadNames(api)).toEqual(["a.pdf", "b.pdf"]));
    fireEvent.click(screen.getByRole("button", { name: "Remove c.pdf" }));
    await act(async () => releases.get("a.pdf")?.());
    await act(async () => releases.get("b.pdf")?.());
    await waitFor(() => expect(inList().getAllByText("Ready")).toHaveLength(2));
    expect(uploadNames(api)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("aborts a file that is still hashing when its chip is removed", async () => {
    let finishHashing!: () => void;
    const file = new File(["x"], "slow.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishHashing = () => resolve(new TextEncoder().encode("x").buffer as ArrayBuffer);
        }),
    });
    const { api } = mountThread();
    await attach([file]);
    await waitFor(() => expect(inList().getByText("Preparing…")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove slow.pdf" }));
    expect(chipList()).toBeNull();
    await act(async () => finishHashing());
    await flush();
    expect(calls(api, STORE_PATHS.uploads)).toHaveLength(0);
    expect(chipList()).toBeNull();
  });
});

describe("WP 1.5 thread identity changes", () => {
  it("keeps the draft and chips when the anchor message changes, and re-reads around it", async () => {
    const { api, view, tree } = mountThread({
      POST: (path) =>
        path === STORE_PATHS.uploads
          ? authorizedWith(ATTACHMENT_ID)
          : path === STORE_PATHS.complete
            ? completed("scanning")
            : undefined,
    });
    await attach([pdf()]);
    await waitFor(() => expect(inList().getByText("Scanning…")).toBeTruthy());
    setDraft("half written");
    view.rerender(tree("dm-1", { anchorMessageId: "m-anchor" }));
    await flush();
    expect(textbox().value).toBe("half written");
    expect(inList().getByText("Scanning…")).toBeTruthy();
    await waitFor(() =>
      expect(
        api.GET.mock.calls.some(
          ([p, init]) =>
            p === STORE_PATHS.messages &&
            (init as { params: { query: { anchorMessageId?: string } } }).params.query
              .anchorMessageId === "m-anchor",
        ),
      ).toBe(true),
    );
  });

  it("loads the new channel even when the old channel's latest read never replied", async () => {
    const { api, view, tree } = mountThread(
      {
        GET: (path, init) =>
          path === STORE_PATHS.messages &&
          (init as { params: { path: { id: string } } }).params.path.id === "dm-1"
            ? new Promise(() => {}) // the old channel's read stays in flight forever
            : undefined,
      },
      "dm-1",
    );
    await flush();
    view.rerender(tree("dm-2"));
    await waitFor(() =>
      expect(
        api.GET.mock.calls.some(
          ([p, init]) =>
            p === STORE_PATHS.messages &&
            (init as { params: { path: { id: string } } }).params.path.id === "dm-2",
        ),
      ).toBe(true),
    );
  });

  it("still delivers an in-flight send's reply after the anchor changes mid-send", async () => {
    let reply!: () => void;
    const { view, tree } = mountThread({
      POST: (path) =>
        path === STORE_PATHS.messages
          ? new Promise((resolve) => {
              reply = () =>
                resolve({
                  data: {
                    messageId: "m-9",
                    channelId: "dm-1",
                    createdAt: "2026-10-10T10:00:00.000Z",
                  },
                  error: undefined,
                  response: { status: 200 },
                });
            })
          : undefined,
    });
    await screen.findByTestId("attachment-input");
    setDraft("hello there");
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(textbox().disabled).toBe(true);
    view.rerender(tree("dm-1", { anchorMessageId: "m-anchor" }));
    await flush();
    expect(textbox().value).toBe("hello there");
    await act(async () => reply());
    expect(await screen.findByText("hello there", { selector: "p, div, span" })).toBeTruthy();
    expect(textbox().value).toBe("");
    expect(textbox().disabled).toBe(false);
  });

  it("drops uploads and aborts their requests when the channel becomes archived", async () => {
    const { api, view, tree } = mountThread({
      POST: (path) => (path === STORE_PATHS.uploads ? new Promise(() => {}) : undefined),
    });
    await attach([pdf()]);
    await waitFor(() => expect(calls(api, STORE_PATHS.uploads)).toHaveLength(1));
    const signal = calls(api, STORE_PATHS.uploads)[0]![1].signal as AbortSignal;
    view.rerender(
      tree("dm-1", { channel: { ...channel("dm-1"), archivedAt: "2026-10-11T00:00:00.000Z" } }),
    );
    await waitFor(() => expect(signal.aborted).toBe(true));
    expect(chipList()).toBeNull();
  });
});
