/**
 * M36 offline outbox (06-ux-design §4 "Offline"): a channel message whose POST got no response is held as a visible
 * "Not sent" row (React state only, never the browser's storage) and re-sent with the same ids until the server confirms.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_ID,
  STORE_PATHS,
  attach,
  authorizedWith,
  calls,
  completed,
  mountThread,
  pdf,
  sendButton,
} from "./attachments-test-support";
import { OfflineBanner } from "./offline-banner";
import type { AttachmentUploads } from "./use-attachment-upload";
import { useMessageSender } from "./use-message-sender";

const MESSAGES = STORE_PATHS.messages;
const OFFLINE = "offline" as const;
type Step = typeof OFFLINE | Record<string, unknown>;

const ok = (messageId: string) => ({
  data: { messageId, channelId: "dm-1", createdAt: "2026-10-10T10:00:00.000Z" },
  error: undefined,
  response: { status: 200 },
});
const answered = (status: number, message: string) => ({
  data: undefined,
  error: { message },
  response: { status },
});

/** Message POSTs answer from the script in order: OFFLINE rejects (no response), anything else is the reply. */
function mountScripted(...steps: Step[]) {
  const queue = [...steps];
  return mountThread({
    GET: (path) =>
      path === "/api/v1/messaging/channels/{id}/mention-non-members"
        ? {
            data: {
              people: [
                { entityId: "22222222-2222-4222-8222-222222222222", displayName: "Zed Newcomer" },
              ],
              canAdd: false,
            },
            error: undefined,
          }
        : undefined,
    POST: (path) => {
      if (path !== MESSAGES) return undefined;
      const step = queue.shift();
      return step === OFFLINE ? Promise.reject(new TypeError("Failed to fetch")) : step;
    },
  });
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const send = async (value: string) => {
  type(value);
  await act(async () => {
    fireEvent.click(sendButton());
  });
};
const header = (init: Record<string, any>, name: string) => init.params.header[name];
const sentBodies = (api: Parameters<typeof calls>[0]) => calls(api, MESSAGES);

afterEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

describe("queueing a message that got no response", () => {
  it("shows a Not sent row, clears the draft, shows no error and keeps the composer enabled", async () => {
    mountScripted(OFFLINE);
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");

    expect(await screen.findByText("Not sent")).toBeTruthy();
    expect(screen.getByText("hello team")).toBeTruthy();
    expect(box().value).toBe("");
    expect(box().disabled).toBe(false);
    expect(screen.queryByText(/Your draft has been preserved/)).toBeNull();
    expect(screen.getByText("Message not sent (1 waiting)", { selector: "output" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry sending message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard message" })).toBeTruthy();
  });

  it("keeps the old preserved-draft error for a send with attachments", async () => {
    const { api } = mountThread({
      POST: (path) =>
        path === STORE_PATHS.uploads
          ? authorizedWith(ATTACHMENT_ID)
          : path === STORE_PATHS.complete
            ? completed("available")
            : path === MESSAGES
              ? Promise.reject(new TypeError("Failed to fetch"))
              : undefined,
    });
    await attach([pdf()]);
    await waitFor(() => expect(screen.getByText("Ready")).toBeTruthy());
    type("with file");
    await act(async () => {
      fireEvent.click(sendButton());
    });

    expect(await screen.findByText(/Your draft has been preserved/)).toBeTruthy();
    expect(screen.queryByText("Not sent")).toBeNull();
    expect(box().value).toBe("with file");
    expect(sentBodies(api)).toHaveLength(1);
  });

  it("keeps the old preserved-draft error when the owner passes no onQueued (thread panel)", async () => {
    const api = {
      POST: vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    } as unknown as ApiClient;
    const uploads = {
      sendableIds: [],
      blocksSend: false,
      chips: [],
      reset: vi.fn(),
      recheck: vi.fn(),
    } as unknown as AttachmentUploads;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiClientProvider client={api}>{children}</ApiClientProvider>
    );
    const { result } = renderHook(
      () =>
        useMessageSender({
          channelId: "dm-1",
          parentMessageId: "root-1",
          archived: false,
          draft: "reply text",
          draftReferences: [],
          uploads,
          generationRef: { current: 0 },
          onSent: vi.fn(),
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.send();
    });
    expect(result.current.sendError).toMatch(/Your draft has been preserved/);
  });
});

describe("retrying a queued message", () => {
  it("re-sends with the same ids, removes the row and shows the server message", async () => {
    const { api } = mountScripted(OFFLINE, ok("m-9"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    const [first, second] = sentBodies(api);
    expect(header(second![1], "Idempotency-Key")).toBe(header(first![1], "Idempotency-Key"));
    expect(second![1].body.clientMessageId).toBe(first![1].body.clientMessageId);
    expect(second![1].body.body).toBe("hello team");
    expect(document.querySelector('[data-message-id="m-9"]')?.textContent).toContain("hello team");
  });

  it("does not touch a new draft that equals the queued text when the retry succeeds", async () => {
    mountScripted(OFFLINE, ok("m-9"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");
    type("hello team");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(box().value).toBe("hello team");
  });

  it("does not close an in-progress @mention when the retry succeeds", async () => {
    mountScripted(OFFLINE, ok("m-9"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");
    fireEvent.change(box(), { target: { value: "@Zed", selectionStart: 4 } });
    await screen.findByRole("option", { name: /Zed Newcomer/ });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(box().value).toBe("@Zed");
    expect(screen.getByRole("option", { name: /Zed Newcomer/ })).toBeTruthy();
  });

  it("stays queued when the retry gets no response either", async () => {
    const { api } = mountScripted(OFFLINE, OFFLINE);
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    expect(await screen.findByText("Not sent")).toBeTruthy();
    expect(sentBodies(api)).toHaveLength(2);
    expect(
      (screen.getByRole("button", { name: "Retry sending message" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows a permanent answered error and lets the user discard the message", async () => {
    mountScripted(OFFLINE, answered(403, "You can no longer post here"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    expect(await screen.findByText("You can no longer post here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry sending message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard message" }));
    expect(screen.queryByText("Not sent")).toBeNull();
    expect(screen.queryByText("hello team")).toBeNull();
  });

  it("keeps Retry after a 409 (the original may still commit), shows the error and rotates the key", async () => {
    const { api } = mountScripted(OFFLINE, answered(409, "Request in progress"), ok("m-4"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    expect(await screen.findByText("Request in progress")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    const [first, , third] = sentBodies(api);
    expect(header(third![1], "Idempotency-Key")).not.toBe(header(first![1], "Idempotency-Key"));
    expect(third![1].body.clientMessageId).toBe(first![1].body.clientMessageId);
  });

  it("rotates the Idempotency-Key after an answered 5xx but keeps the clientMessageId and the Retry button", async () => {
    const { api } = mountScripted(OFFLINE, answered(500, "Server hiccup"), ok("m-3"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });
    await screen.findByText("Server hiccup");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    const [first, second, third] = sentBodies(api);
    expect(header(second![1], "Idempotency-Key")).toBe(header(first![1], "Idempotency-Key"));
    expect(header(third![1], "Idempotency-Key")).not.toBe(header(second![1], "Idempotency-Key"));
    expect(third![1].body.clientMessageId).toBe(first![1].body.clientMessageId);
  });
});

describe("reconnecting and leaving", () => {
  it("queues a new message behind a waiting one without posting it, then drains oldest first", async () => {
    const { api } = mountScripted(OFFLINE, ok("m-1"), ok("m-2"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("first");
    await waitFor(() => expect(screen.getAllByText("Not sent")).toHaveLength(1));
    await send("second");
    await waitFor(() => expect(screen.getAllByText("Not sent")).toHaveLength(2));
    expect(sentBodies(api)).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(sentBodies(api).map(([, init]) => init.body.body)).toEqual(["first", "first", "second"]);
  });

  it("stops the online drain at an answered error so later messages do not overtake it", async () => {
    const { api } = mountScripted(OFFLINE, answered(500, "Server hiccup"), ok("m-2"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("first");
    await screen.findByText("Not sent");
    await send("second");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await screen.findByText("Server hiccup");
    expect(sentBodies(api).map(([, init]) => init.body.body)).toEqual(["first", "first"]);
    expect(screen.getAllByText("Not sent")).toHaveLength(2);
  });

  it("sends once when a manual Retry lands while the online drain is already sending", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { api } = mountScripted(OFFLINE, gate as unknown as Step);
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    const retry = await screen.findByRole("button", { name: "Retry sending message" });
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(retry);
    });

    expect(sentBodies(api)).toHaveLength(2);
    await act(async () => {
      release(ok("m-5"));
    });
    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
  });

  it("keeps a queued message per channel: switching away hides it and switching back shows it again", async () => {
    const { view, tree } = mountScripted(OFFLINE);
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");

    view.rerender(tree("dm-2"));
    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(screen.queryByText("hello team")).toBeNull();

    view.rerender(tree("dm-1"));
    expect(await screen.findByText("Not sent")).toBeTruthy();
    expect(screen.getByText("hello team")).toBeTruthy();
  });

  it("delivers another channel's queued message on online without merging it into the open channel", async () => {
    const { api, view, tree } = mountScripted(OFFLINE, ok("m-A"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");
    view.rerender(tree("dm-2"));
    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(sentBodies(api)).toHaveLength(2));
    expect(sentBodies(api)[1]![1].params.path.id).toBe("dm-1");
    expect(document.querySelector('[data-message-id="m-A"]')).toBeNull();
    expect(screen.queryByText("hello team")).toBeNull();
    view.rerender(tree("dm-1"));
    await screen.findByRole("textbox", { name: "Message" });
    expect(screen.queryByText("Not sent")).toBeNull();
  });
});

describe("focus, announcements and names", () => {
  const rowAction = (index: number, name: RegExp) =>
    screen.getAllByRole("button", { name })[index] as HTMLButtonElement;

  it("moves focus to the next row's first action, then the previous, then the composer when rows are discarded", async () => {
    mountScripted(OFFLINE);
    await screen.findByRole("textbox", { name: "Message" });
    await send("one");
    await screen.findByText("Not sent");
    await send("two");
    await send("three");
    await waitFor(() => expect(screen.getAllByText("Not sent")).toHaveLength(3));

    rowAction(0, /^Discard message/).focus();
    fireEvent.click(rowAction(0, /^Discard message/));
    expect(document.activeElement).toBe(rowAction(0, /^Retry sending message/));
    expect(screen.queryByText("one")).toBeNull();

    rowAction(1, /^Discard message/).focus();
    fireEvent.click(rowAction(1, /^Discard message/));
    expect(document.activeElement).toBe(rowAction(0, /^Retry sending message/));
    expect(screen.queryByText("three")).toBeNull();

    rowAction(0, /^Discard message/).focus();
    fireEvent.click(rowAction(0, /^Discard message/));
    expect(document.activeElement).toBe(box());
  });

  it("moves focus to the composer when the focused row is delivered", async () => {
    mountScripted(OFFLINE, ok("m-9"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");

    const retry = screen.getByRole("button", { name: "Retry sending message" });
    retry.focus();
    await act(async () => {
      fireEvent.click(retry);
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(document.activeElement).toBe(box());
  });

  it("announces each queue event with a different text and clears it when the queue empties", async () => {
    mountScripted(OFFLINE);
    await screen.findByRole("textbox", { name: "Message" });
    const live = () => document.querySelector('output[aria-live="polite"]')?.textContent;

    await send("one");
    await screen.findByText("Not sent");
    const first = live();
    await send("two");
    await waitFor(() => expect(screen.getAllByText("Not sent")).toHaveLength(2));
    const second = live();

    expect(first).toBe("Message not sent (1 waiting)");
    expect(second).toBe("Message not sent (2 waiting)");
    fireEvent.click(rowAction(0, /^Discard message/));
    fireEvent.click(rowAction(0, /^Discard message/));
    expect(live()).toBe("");
  });

  it("names each action by its position when several messages wait", async () => {
    mountScripted(OFFLINE);
    await screen.findByRole("textbox", { name: "Message" });
    await send("one");
    await screen.findByText("Not sent");
    await send("two");
    await waitFor(() => expect(screen.getAllByText("Not sent")).toHaveLength(2));

    expect(screen.getByRole("button", { name: "Retry sending message 2 of 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard message 1 of 2" })).toBeTruthy();
  });
});

describe("the first send", () => {
  it("treats a hung connection as no response after the timeout and hands the message to the outbox", async () => {
    vi.useFakeTimers();
    try {
      const api = {
        POST: vi.fn(
          (_path: string, init: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(new DOMException("x", "AbortError")),
              );
            }),
        ),
      } as unknown as ApiClient;
      const uploads = {
        sendableIds: [],
        blocksSend: false,
        chips: [],
        reset: vi.fn(),
        recheck: vi.fn(),
      } as unknown as AttachmentUploads;
      const onQueued = vi.fn();
      const wrapper = ({ children }: { children: ReactNode }) => (
        <ApiClientProvider client={api}>{children}</ApiClientProvider>
      );
      const { result } = renderHook(
        () =>
          useMessageSender({
            channelId: "dm-1",
            archived: false,
            draft: "hello",
            draftReferences: [],
            uploads,
            generationRef: { current: 0 },
            onSent: vi.fn(),
            onQueued,
          }),
        { wrapper },
      );
      act(() => {
        void result.current.send();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(onQueued).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("followers, focus claims and transitions", () => {
  it("sends the followers queued behind a head when a manual Retry delivers it, with no online event", async () => {
    const { api } = mountScripted(OFFLINE, answered(500, "Server hiccup"), ok("m-a"), ok("m-b"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("first");
    await screen.findByText("Not sent");
    await send("second");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await screen.findByText("Server hiccup");

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Retry sending message/ })[0]!);
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(sentBodies(api).map(([, init]) => init.body.body)).toEqual([
      "first",
      "first",
      "first",
      "second",
    ]);
  });

  it("sends the followers when a head that failed is discarded", async () => {
    const { api } = mountScripted(OFFLINE, answered(500, "Server hiccup"), ok("m-b"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("first");
    await screen.findByText("Not sent");
    await send("second");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await screen.findByText("Server hiccup");

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Discard message/ })[0]!);
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(sentBodies(api).map(([, init]) => init.body.body)).toEqual(["first", "first", "second"]);
  });

  it("does not pull focus to the composer when the user clicked away before the row was delivered", async () => {
    mountScripted(OFFLINE, ok("m-9"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");
    const retry = screen.getByRole("button", { name: "Retry sending message" });
    retry.focus();
    retry.blur();
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(document.activeElement).not.toBe(box());
  });

  it("announces a failed retry (each time differently), a refusal with its reason, and a delivery", async () => {
    mountScripted(
      OFFLINE,
      answered(500, "Server hiccup"),
      answered(500, "Server hiccup"),
      answered(403, "You can no longer post here"),
    );
    await screen.findByRole("textbox", { name: "Message" });
    const live = () => document.querySelector('output[aria-live="polite"]')?.textContent;
    const retry = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
      });
    };
    await send("hello team");
    await screen.findByText("Not sent");

    await retry();
    const first = live();
    await retry();
    const second = live();
    await retry();

    expect(first).toBe("Retry failed for message 1 of 1, attempt 1: Server hiccup");
    expect(second).toBe("Retry failed for message 1 of 1, attempt 2: Server hiccup");
    expect(live()).toBe("Message not sent: You can no longer post here");
  });

  it("announces a delivery", async () => {
    mountScripted(OFFLINE, ok("m-9"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    await waitFor(() =>
      expect(
        [...document.querySelectorAll('output[aria-live="polite"]')].map(
          (node) => node.textContent,
        ),
      ).toContain("Message sent"),
    );
  });
});

describe("offline banner", () => {
  it("appears on the offline event, goes quiet on online, and the composer stays enabled", async () => {
    mountScripted();
    render(<OfflineBanner />);
    await screen.findByRole("textbox", { name: "Message" });
    expect(screen.queryByText(/You're offline/)).toBeNull();

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(
      screen.getByText("You're offline — messages will be sent when you reconnect"),
    ).toBeTruthy();
    expect(box().disabled).toBe(false);

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(/You're offline/)).toBeNull();
  });
});
