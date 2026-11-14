// @vitest-environment jsdom
// One read: loading, the refusal as an `OpsFailure` worded by the CALLER's copy (the operator console and the tenant wizard speak
// differently), and a quiet reload that keeps the data on screen and says when it may be out of date.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLoad } from "./use-load";

const refusal = (code: string) => ({
  error: { error: { code, message: "server words", correlationId: "c-1" } },
  response: { status: 409 },
});

describe("useLoad", () => {
  it("words a refusal with the copy the caller passed", async () => {
    const copy = { VERSION_CONFLICT: "tenant words" };
    const { result } = renderHook(() =>
      useLoad(
        "k",
        async () => ({ ...refusal("VERSION_CONFLICT"), response: { status: 412 } }),
        copy,
      ),
    );
    await waitFor(() => expect(result.current.failure?.message).toBe("tenant words"));
  });

  it("falls back to the server's sentence when the caller's copy has none for the code", async () => {
    const { result } = renderHook(() => useLoad("k", async () => refusal("OTHER"), {}));
    await waitFor(() => expect(result.current.failure?.message).toBe("server words"));
  });

  it("keeps the data on screen and says it may be stale when a quiet reload fails", async () => {
    let calls = 0;
    const { result } = renderHook(() =>
      useLoad(
        "k",
        async () => {
          calls += 1;
          return calls === 1 ? { data: { n: 1 } } : refusal("X");
        },
        {},
      ),
    );
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    await act(async () => {
      await result.current.reload(true);
    });
    expect(result.current.data).toEqual({ n: 1 });
    expect(result.current.stale).toBe(true);
    expect(result.current.failure).toBeNull();
  });
});
