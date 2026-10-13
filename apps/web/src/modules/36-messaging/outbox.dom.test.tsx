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
    expect(screen.getByText("Message not sent", { selector: "output" })).toBeTruthy();
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
  it("re-sends with the same ids, removes the row and shows the server message without touching the new draft", async () => {
    const { api } = mountScripted(OFFLINE, ok("m-9"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");
    type("next thought");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    const [first, second] = sentBodies(api);
    expect(header(second![1], "Idempotency-Key")).toBe(header(first![1], "Idempotency-Key"));
    expect(second![1].body.clientMessageId).toBe(first![1].body.clientMessageId);
    expect(second![1].body.body).toBe("hello team");
    expect(document.querySelector('[data-message-id="m-9"]')?.textContent).toContain("hello team");
    expect(box().value).toBe("next thought");
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
  it("retries every queued message oldest first when the browser comes back online", async () => {
    const { api } = mountScripted(OFFLINE, OFFLINE, ok("m-1"), ok("m-2"));
    await screen.findByRole("textbox", { name: "Message" });
    await send("first");
    await waitFor(() => expect(screen.getAllByText("Not sent")).toHaveLength(1));
    await send("second");
    await waitFor(() => expect(screen.getAllByText("Not sent")).toHaveLength(2));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(sentBodies(api).map(([, init]) => init.body.body)).toEqual([
      "first",
      "second",
      "first",
      "second",
    ]);
  });

  it("drops the outbox when the channel changes", async () => {
    const { view, tree } = mountScripted(OFFLINE);
    await screen.findByRole("textbox", { name: "Message" });
    await send("hello team");
    await screen.findByText("Not sent");

    view.rerender(tree("dm-2"));

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(screen.queryByText("hello team")).toBeNull();
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
