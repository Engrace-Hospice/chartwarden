// useAttemptKey: the React face of createAttemptKey. One stable object per component, registered so the app can drop every held key when the
// session ends, and unregistered when the component unmounts.
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { clearIdempotencyKeys, createApiClient } from "../../api/client";
import { useIdempotencyKeeper } from "../idempotency";
import { clearHeldKeys } from "../idempotency-key";
import { type AttemptKey, useAttemptKey } from "../use-attempt-key";

const lost = async () => {
  throw new TypeError("Failed to fetch");
};

/** Run a request that gets no answer and return the key it was sent with. */
async function throwWith(attempt: AttemptKey, fingerprint: string): Promise<string> {
  let sent = "";
  await attempt
    .run(fingerprint, async (key) => {
      sent = key;
      return lost();
    })
    .catch(() => undefined);
  return sent;
}

describe("useAttemptKey", () => {
  it("keeps the key after no answer and reuses it for the identical request", async () => {
    const { result } = renderHook(() => useAttemptKey());
    const first = await throwWith(result.current, "a");
    const retry = await throwWith(result.current, "a");
    expect(retry).toBe(first);
  });

  it("is one stable object across renders (callers list it in their dependencies)", () => {
    const { result, rerender } = renderHook(() => useAttemptKey());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.run).toBe(first.run);
  });

  it("drops its held keys when the app clears them at the end of a session", async () => {
    const { result } = renderHook(() => useAttemptKey());
    const first = await throwWith(result.current, "a");

    clearHeldKeys();

    expect(await throwWith(result.current, "a")).not.toBe(first);
  });

  it("is cleared by clearIdempotencyKeys(client) too: one call ends a session's keys, the client's and the screens'", async () => {
    const { result } = renderHook(() => useAttemptKey());
    const client = createApiClient({ baseUrl: "http://localhost" });
    const first = await throwWith(result.current, "a");

    expect(clearIdempotencyKeys(client)).toBe(true);

    expect(await throwWith(result.current, "a")).not.toBe(first);
  });

  it("is not cleared once unmounted (nothing left to clear), and does not throw", async () => {
    const { result, unmount } = renderHook(() => useAttemptKey());
    const attempt = result.current;
    const first = await throwWith(attempt, "a");

    unmount();
    clearHeldKeys();

    expect(await throwWith(attempt, "a")).toBe(first);
  });
});

describe("useIdempotencyKeeper and the end of a session", () => {
  it("is cleared with the other held keys", () => {
    const { result } = renderHook(() => useIdempotencyKeeper());
    const first = result.current.keyFor("body");

    clearHeldKeys();

    expect(result.current.keyFor("body")).not.toBe(first);
  });
});
