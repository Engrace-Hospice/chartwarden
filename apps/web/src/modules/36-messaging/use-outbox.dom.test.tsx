/**
 * useOutbox on its own (the thread-level behaviour is in outbox.dom.test.tsx): late replies, the answered-status
 * rules, the request timeout, an unexpected throw, the beforeunload guard and the per-channel drain.
 */
import { act, renderHook } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { type ReactNode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendBody } from "./message-send-body";
import type { QueuedSend } from "./use-message-sender";
import type { SentMessage } from "./use-message-sender";
import { useOutbox } from "./use-outbox";

const REQUEST_TIMEOUT_MS = 30_000;
type Reply = unknown;

const queued = (id: string, text = "hi"): QueuedSend => ({
  body: { clientMessageId: id, body: text } as unknown as SendBody,
  idempotencyKey: `key-${id}`,
  sent: {
    messageId: id,
    createdAt: "2026-10-10T09:00:00.000Z",
    body: text,
    references: [],
    attachments: [],
  },
});
const ok = (messageId: string) => ({
  data: { messageId, channelId: "ch", createdAt: "2026-10-10T10:00:00.000Z" },
  error: undefined,
  response: { status: 200 },
});
const answered = (status: number) => ({
  data: undefined,
  error: { message: `status ${status}` },
  response: { status },
});
const deferred = () => {
  let resolve!: (value: Reply) => void;
  const promise = new Promise<Reply>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** The lifted outbox as the open thread sees it: bound to one channel, with that channel's rows. */
function useScopedOutbox({
  channelId,
  onDelivered,
}: { channelId: string; onDelivered: (sent: SentMessage) => void }) {
  const outbox = useOutbox();
  const { bindThread } = outbox;
  useEffect(() => bindThread(channelId, onDelivered), [bindThread, channelId, onDelivered]);
  return {
    ...outbox,
    items: outbox.itemsFor(channelId),
    enqueue: (queuedSend: QueuedSend) => outbox.enqueue(channelId, queuedSend),
    hasQueued: () => outbox.hasQueued(channelId),
  };
}

function mount(replies: (() => Promise<Reply>)[], channelId = "A") {
  const post = vi.fn((_path: string, _init: Record<string, any>) => {
    const next = replies.shift();
    return next ? next() : Promise.resolve(ok("default"));
  });
  const onDelivered = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={{ POST: post } as unknown as ApiClient}>
      {children}
    </ApiClientProvider>
  );
  const hook = renderHook(
    ({ id }: { id: string }) => useScopedOutbox({ channelId: id, onDelivered }),
    {
      wrapper,
      initialProps: { id: channelId },
    },
  );
  return { ...hook, post, onDelivered };
}
const reply = (value: Reply) => () => Promise.resolve(value);
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a reply that lands after the owner moved on", () => {
  it("is dropped after unmount: nothing is merged", async () => {
    const gate = deferred();
    const { result, unmount, onDelivered } = mount([() => gate.promise]);
    act(() => result.current.enqueue(queued("m1")));
    let attempt!: Promise<unknown>;
    act(() => {
      attempt = result.current.retry("m1");
    });
    unmount();

    await act(async () => {
      gate.resolve(ok("srv-1"));
      await attempt;
    });

    expect(onDelivered).not.toHaveBeenCalled();
  });

  it("clears the item but does not merge it when the channel changed meanwhile", async () => {
    const gate = deferred();
    const { result, rerender, onDelivered } = mount([() => gate.promise]);
    act(() => result.current.enqueue(queued("m1")));
    let attempt!: Promise<unknown>;
    act(() => {
      attempt = result.current.retry("m1");
    });
    rerender({ id: "B" });

    await act(async () => {
      gate.resolve(ok("srv-1"));
      await attempt;
    });

    expect(onDelivered).not.toHaveBeenCalled();
    rerender({ id: "A" });
    expect(result.current.items).toHaveLength(0);
  });
});

describe("answered statuses", () => {
  it.each([403, 404, 422])(
    "%i is permanent: Retry is withdrawn and the key rotates",
    async (status) => {
      const { result } = mount([reply(answered(status))]);
      act(() => result.current.enqueue(queued("m1")));

      await act(async () => {
        await result.current.retry("m1");
      });

      const [item] = result.current.items;
      expect(item?.permanent).toBe(true);
      expect(item?.idempotencyKey).not.toBe("key-m1");
      expect(item?.localId).toBe("m1");
    },
  );

  it.each([409, 500, 503])("%i is retryable and the key rotates", async (status) => {
    const { result } = mount([reply(answered(status))]);
    act(() => result.current.enqueue(queued("m1")));

    await act(async () => {
      await result.current.retry("m1");
    });

    const [item] = result.current.items;
    expect(item?.permanent).toBeFalsy();
    expect(item?.status).toBe("not_sent");
    expect(item?.error).toBeTruthy();
    expect(item?.idempotencyKey).not.toBe("key-m1");
  });

  it("keeps the key when no response arrived", async () => {
    const { result } = mount([offline]);
    act(() => result.current.enqueue(queued("m1")));

    await act(async () => {
      await result.current.retry("m1");
    });

    expect(result.current.items[0]?.idempotencyKey).toBe("key-m1");
    expect(result.current.items[0]?.status).toBe("not_sent");
  });
});

describe("a request that never answers or throws unexpectedly", () => {
  it("times out after the request timeout, stays Not sent and reuses the key", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { result, post } = mount([]);
    post.mockImplementation((_path, init) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    act(() => result.current.enqueue(queued("m1")));
    let attempt!: Promise<unknown>;
    act(() => {
      attempt = result.current.retry("m1");
    });
    expect(result.current.items[0]?.status).toBe("sending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await attempt;
    });

    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.items[0]?.status).toBe("not_sent");
    expect(result.current.items[0]?.idempotencyKey).toBe("key-m1");
  });

  it("never leaves a row stuck in sending when something unexpected throws", async () => {
    const { result } = mount([reply(answered(500))]);
    act(() => result.current.enqueue(queued("m1")));
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("no entropy");
    });

    await act(async () => {
      await result.current.retry("m1");
    });

    expect(result.current.items[0]?.status).toBe("not_sent");
  });

  it("lets Discard remove a row that is sending, and still merges the message if it was delivered", async () => {
    const gate = deferred();
    const { result, onDelivered } = mount([() => gate.promise]);
    act(() => result.current.enqueue(queued("m1")));
    let attempt!: Promise<unknown>;
    act(() => {
      attempt = result.current.retry("m1");
    });

    act(() => result.current.discard("m1"));
    expect(result.current.items).toHaveLength(0);
    await act(async () => {
      gate.resolve(ok("srv-1"));
      await attempt;
    });

    expect(onDelivered).toHaveBeenCalledTimes(1);
  });
});

describe("leaving the page", () => {
  it("warns on beforeunload only while an item is queued", () => {
    const { result } = mount([]);
    const fire = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire()).toBe(false);

    act(() => result.current.enqueue(queued("m1")));
    expect(fire()).toBe(true);

    act(() => result.current.discard("m1"));
    expect(fire()).toBe(false);
  });

  it("still warns while another channel's message is queued", () => {
    const { result, rerender } = mount([]);
    act(() => result.current.enqueue(queued("m1")));
    rerender({ id: "B" });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("the online drain", () => {
  it("delivers another channel's item to its own channel without merging it", async () => {
    const { result, rerender, post, onDelivered } = mount([reply(ok("srv-A"))]);
    act(() => result.current.enqueue(queued("m1")));
    rerender({ id: "B" });

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1].params.path.id).toBe("A");
    expect(onDelivered).not.toHaveBeenCalled();
    rerender({ id: "A" });
    expect(result.current.items).toHaveLength(0);
  });

  it("stops a channel at an answered error but still drains other channels", async () => {
    const { result, rerender, post } = mount([reply(answered(500)), reply(ok("srv-B"))]);
    act(() => result.current.enqueue(queued("a1")));
    act(() => result.current.enqueue(queued("a2")));
    rerender({ id: "B" });
    act(() => result.current.enqueue(queued("b1")));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    const sentIds = post.mock.calls.map(([, init]) => init.body.clientMessageId);
    expect(sentIds).toEqual(["a1", "b1"]);
  });

  it("does not send twice when a manual retry overlaps the drain", async () => {
    const gate = deferred();
    const { result, post } = mount([() => gate.promise]);
    act(() => result.current.enqueue(queued("m1")));

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await act(async () => {
      await result.current.retry("m1");
    });

    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(ok("srv-1"));
    });
  });

  it("reports whether a retryable item waits in the channel", () => {
    const { result } = mount([]);
    expect(result.current.hasQueued()).toBe(false);
    act(() => result.current.enqueue(queued("m1")));
    expect(result.current.hasQueued()).toBe(true);
  });
});

describe("the drain's reach", () => {
  it("does not POST after unmount: a drain in flight stops before the next channel", async () => {
    const gate = deferred();
    const { result, rerender, unmount, post } = mount([() => gate.promise, reply(ok("srv-B"))]);
    act(() => result.current.enqueue(queued("a1")));
    rerender({ id: "B" });
    act(() => result.current.enqueue(queued("b1")));
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(post).toHaveBeenCalledTimes(1);
    unmount();

    await act(async () => {
      gate.resolve(ok("srv-A"));
    });

    expect(post).toHaveBeenCalledTimes(1);
  });

  it("sends an item queued while the drain was already running", async () => {
    const gate = deferred();
    const { result, post } = mount([() => gate.promise, reply(ok("srv-2"))]);
    act(() => result.current.enqueue(queued("m1")));
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    act(() => result.current.enqueue(queued("m2")));

    await act(async () => {
      gate.resolve(ok("srv-1"));
    });

    expect(post.mock.calls.map(([, init]) => init.body.clientMessageId)).toEqual(["m1", "m2"]);
    expect(result.current.items).toHaveLength(0);
  });

  it("does not drop a drain requested while one is running", async () => {
    const gate = deferred();
    const { result, post } = mount([() => gate.promise, reply(ok("srv-2"))]);
    act(() => result.current.enqueue(queued("m1")));
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    act(() => result.current.enqueue(queued("m2")));
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await act(async () => {
      gate.resolve(ok("srv-1"));
    });

    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe("a drain requested while another runs", () => {
  it("is not lost: a second pass sends what the scoped drain did not look at", async () => {
    const gate = deferred();
    const { result, rerender, post } = mount([
      reply(answered(500)),
      () => gate.promise,
      reply(ok("srv-B")),
    ]);
    act(() => result.current.enqueue(queued("a1")));
    act(() => result.current.enqueue(queued("a2")));
    await act(async () => {
      await result.current.retry("a1");
    });
    act(() => result.current.discard("a1"));
    expect(post).toHaveBeenCalledTimes(2);
    rerender({ id: "B" });
    act(() => result.current.enqueue(queued("b1")));
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await act(async () => {
      gate.resolve(ok("srv-A"));
    });

    expect(post.mock.calls.map(([, init]) => init.body.clientMessageId)).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
  });
});

describe("the lifted owner", () => {
  it("removes a delivered item without merging it when no thread is bound to its channel", async () => {
    const post = vi.fn(() => Promise.resolve(ok("srv-1")));
    const { result } = renderHook(() => useOutbox(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ApiClientProvider client={{ POST: post } as unknown as ApiClient}>
          {children}
        </ApiClientProvider>
      ),
    });
    act(() => result.current.enqueue("A", queued("m1")));

    await act(async () => {
      await result.current.retry("m1");
    });

    expect(result.current.itemsFor("A")).toHaveLength(0);
    expect(result.current.deliveredFor("A")).toBe(1);
  });

  it("finishes an in-flight send after the bound thread unbinds, merging nothing", async () => {
    const gate = deferred();
    const { result, rerender, onDelivered } = mount([() => gate.promise]);
    act(() => result.current.enqueue(queued("m1")));
    let attempt!: Promise<unknown>;
    act(() => {
      attempt = result.current.retry("m1");
    });
    rerender({ id: "B" });

    await act(async () => {
      gate.resolve(ok("srv-1"));
      await attempt;
    });

    expect(onDelivered).not.toHaveBeenCalled();
    expect(result.current.itemsFor("A")).toHaveLength(0);
  });
});
