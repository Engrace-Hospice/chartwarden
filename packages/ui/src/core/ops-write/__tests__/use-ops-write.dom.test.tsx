// packages/ui/src/core/ops-write — useOpsWrite: one Idempotency-Key per attempt (kept across a request that got no answer, renewed by
// any answer), a refusal turned into an OpsFailure, a double submit dropped, the follow-up inside the busy window, and the screen's
// own copy for a server code.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OpsErrorCopy } from "../ops-error";
import { useOpsWrite } from "../use-ops-write";

const refused = (status: number, code: string, message: string) => ({
  error: { error: { code, message, correlationId: "c" } },
  response: { status },
});

describe("useOpsWrite", () => {
  it("a success returns the data; its follow-up runs inside the in-flight window (a submit then is dropped)", async () => {
    const { result } = renderHook(() => useOpsWrite());
    let calls = 0;
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run(
        "body",
        async () => {
          calls += 1;
          return { data: { id: "p1" }, response: { status: 200 } };
        },
        async () => {
          void result.current.run("body", async () => {
            calls += 1;
            return { data: {}, response: { status: 200 } };
          });
        },
      );
    });
    expect(outcome).toEqual({ ok: true, data: { id: "p1" } });
    expect(calls).toBe(1);
    expect(result.current.busy).toBe(false);
    expect(result.current.failure).toBeNull();
  });

  it("a refusal becomes an OpsFailure; an answer renews the key, no answer keeps it", async () => {
    const { result } = renderHook(() => useOpsWrite());
    const keys: string[] = [];
    await act(async () => {
      await result.current.run("same", async (key) => {
        keys.push(key);
        return refused(409, "PRICING_PLAN_CHANGED", "this plan changed since you read it");
      });
    });
    expect(result.current.failure).toMatchObject({
      kind: "conflict",
      code: "PRICING_PLAN_CHANGED",
      message: "this plan changed since you read it",
    });
    await act(async () => {
      await result.current.run("same", async (key) => {
        keys.push(key);
        throw new TypeError("network down");
      });
    });
    expect(result.current.failure?.kind).toBe("network");
    await act(async () => {
      await result.current.run("same", async (key) => {
        keys.push(key);
        return { data: {}, response: { status: 200 } };
      });
    });
    expect(keys[1]).not.toBe(keys[0]); // the 409 was an answer: a new attempt, a new key
    expect(keys[2]).toBe(keys[1]); // the dropped request got no answer: the retry replays it
  });

  it("an empty-body non-ok response is a failure, not a success, and a gateway page keeps the key for the retry", async () => {
    const { result } = renderHook(() => useOpsWrite());
    const keys: string[] = [];
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run("same", async (key) => {
        keys.push(key);
        // What openapi-fetch returns for a 502 with Content-Length 0: `error` is undefined.
        return { error: undefined, response: { ok: false, status: 502 } };
      });
    });
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "unavailable", status: 502 } });
    await act(async () => {
      await result.current.run("same", async (key) => {
        keys.push(key);
        return { data: {}, response: { ok: true, status: 200 } };
      });
    });
    expect(keys[1]).toBe(keys[0]); // nothing was cached under the key: the retry replays it
  });

  it("a second run while one is in flight is dropped", async () => {
    const { result } = renderHook(() => useOpsWrite());
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.run("body", async () => {
        calls += 1;
        await gate;
        return { data: {}, response: { status: 200 } };
      });
      void result.current.run("body", async () => {
        calls += 1;
        return { data: {}, response: { status: 200 } };
      });
    });
    await act(async () => {
      release();
      await first;
    });
    expect(calls).toBe(1);
  });

  it("the screen's copy (a module constant) names a server code in its own words; clear() drops the failure", async () => {
    const COPY: OpsErrorCopy = { PRICING_PLAN_CHANGED: "Someone changed this plan." };
    const { result } = renderHook(() => useOpsWrite(COPY));
    await act(async () => {
      await result.current.run("x", async () =>
        refused(409, "PRICING_PLAN_CHANGED", "server words"),
      );
    });
    expect(result.current.failure?.message).toBe("Someone changed this plan.");
    act(() => result.current.clear());
    await waitFor(() => expect(result.current.failure).toBeNull());
  });
});
