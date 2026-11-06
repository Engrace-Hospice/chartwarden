// @vitest-environment jsdom
// useLoad: a quiet refresh that fails keeps what is on screen, but says so (the data may be out of date) until a refresh succeeds.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLoad } from "./use-load";

type Reply = { data?: { n: number }; error?: unknown; response?: { status: number } };

function setup(replies: (Reply | "throw")[]) {
  let i = 0;
  const hook = renderHook(() =>
    useLoad<{ n: number }>("k", async () => {
      const next = replies[Math.min(i++, replies.length - 1)] as Reply | "throw";
      if (next === "throw") throw new TypeError("offline");
      return next;
    }),
  );
  return hook;
}
const FAIL = {
  error: { error: { code: "INTERNAL_ERROR", message: "x" } },
  response: { status: 500 },
};

describe("useLoad", () => {
  it("a quiet refresh that fails keeps the data and marks it stale; the next success clears the mark", async () => {
    const hook = setup([{ data: { n: 1 } }, FAIL, { data: { n: 2 } }]);
    await waitFor(() => expect(hook.result.current.data).toEqual({ n: 1 }));
    expect(hook.result.current.stale).toBe(false);
    await act(async () => hook.result.current.reload(true));
    expect(hook.result.current.data).toEqual({ n: 1 });
    expect(hook.result.current.stale).toBe(true);
    expect(hook.result.current.failure).toBeNull();
    await act(async () => hook.result.current.reload(true));
    expect(hook.result.current.data).toEqual({ n: 2 });
    expect(hook.result.current.stale).toBe(false);
  });

  it("a quiet refresh that throws (offline) is stale too", async () => {
    const hook = setup([{ data: { n: 1 } }, "throw"]);
    await waitFor(() => expect(hook.result.current.data).toEqual({ n: 1 }));
    await act(async () => hook.result.current.reload(true));
    expect(hook.result.current.stale).toBe(true);
  });

  it("a foreground failure is a failure, not stale", async () => {
    const hook = setup([FAIL]);
    await waitFor(() => expect(hook.result.current.failure).not.toBeNull());
    expect(hook.result.current.stale).toBe(false);
  });
});
