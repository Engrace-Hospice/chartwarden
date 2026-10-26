import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type AttemptKey, useAttemptKey } from "../use-attempt-key";

const echo = async (key: string) => key;

/** Run a request that throws and return the key it was sent with. */
async function throwWith(attempt: AttemptKey, fingerprint: string): Promise<string> {
  let sent = "";
  await attempt
    .run(fingerprint, async (key) => {
      sent = key;
      throw new TypeError("net");
    })
    .catch(() => undefined);
  return sent;
}

describe("useAttemptKey", () => {
  it("keeps the key after a throw and reuses it for the identical request", async () => {
    const { result } = renderHook(() => useAttemptKey());
    const first = await throwWith(result.current, "a");
    expect(await result.current.run("a", echo)).toBe(first);
  });

  it("retires the key after any resolved answer", async () => {
    const { result } = renderHook(() => useAttemptKey());
    const first = await result.current.run("a", echo);
    expect(await result.current.run("a", echo)).not.toBe(first);
  });

  it("mints a new key when the fingerprint changes", async () => {
    const { result } = renderHook(() => useAttemptKey());
    const first = await throwWith(result.current, "a");
    expect(await result.current.run("b", echo)).not.toBe(first);
  });

  it("keeps a thrown request's key across a different request in between", async () => {
    const { result } = renderHook(() => useAttemptKey());
    const first = await throwWith(result.current, "a");
    await result.current.run("b", echo);
    expect(await result.current.run("a", echo)).toBe(first);
  });
});
