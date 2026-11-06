// @vitest-environment jsdom
// useOpsWrite: how a platform write runs. One Idempotency-Key per attempt: the key survives a request that got NO answer (the network
// dropped it, so a retry replays) and is renewed by ANY answer, because the server caches a refusal under the key and a retry on it
// would be handed the refusal again (a 403 STEP_UP_REQUIRED would never clear). A refusal becomes an OpsFailure the screen switches on.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOpsWrite } from "./use-ops-write";

type Result = { data?: { id: string }; error?: unknown; response?: { status: number } };

function setup() {
  const keys: string[] = [];
  const hook = renderHook(() => useOpsWrite());
  const attempt = (fingerprint: string, result: Result | "throw") =>
    act(async () =>
      hook.result.current.run(fingerprint, async (key) => {
        keys.push(key);
        if (result === "throw") throw new TypeError("network down");
        return result;
      }),
    );
  return { hook, keys, attempt };
}

describe("useOpsWrite", () => {
  it("returns the data on success and clears any earlier failure", async () => {
    const { hook, attempt } = setup();
    await attempt("a", {
      error: { error: { code: "X", message: "no" } },
      response: { status: 409 },
    });
    expect(hook.result.current.failure?.kind).toBe("conflict");
    const ok = await attempt("a", { data: { id: "1" }, response: { status: 200 } });
    expect(ok).toEqual({ ok: true, data: { id: "1" } });
    expect(hook.result.current.failure).toBeNull();
    expect(hook.result.current.busy).toBe(false);
  });

  it("turns a refusal into a failure the screen can switch on, with the caller's copy", async () => {
    const { hook, attempt } = setup();
    const out = await attempt("a", {
      error: { error: { code: "GO_LIVE_SAME_PERSON", message: "server words" } },
      response: { status: 409 },
    });
    expect(out.ok).toBe(false);
    expect(hook.result.current.failure?.code).toBe("GO_LIVE_SAME_PERSON");
    expect(hook.result.current.failure?.message).toMatch(/different operator/i);
  });

  it("retries on the SAME key after a request that got no answer", async () => {
    const { hook, keys, attempt } = setup();
    await attempt("body-1", "throw");
    expect(hook.result.current.failure?.kind).toBe("network");
    await attempt("body-1", { data: { id: "1" }, response: { status: 200 } });
    expect(keys[1]).toBe(keys[0]);
  });

  it("starts on a NEW key after the server has answered, even with the same body (the refusal is cached under the old one)", async () => {
    const { keys, attempt } = setup();
    await attempt("body-1", {
      error: { error: { code: "STEP_UP_REQUIRED", message: "x" } },
      response: { status: 403 },
    });
    await attempt("body-1", { data: { id: "1" }, response: { status: 200 } });
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("starts on a new key when the body changes", async () => {
    const { keys, attempt } = setup();
    await attempt("body-1", "throw");
    await attempt("body-2", { data: { id: "1" }, response: { status: 200 } });
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("can be cleared by the screen", async () => {
    const { hook, attempt } = setup();
    await attempt("a", {
      error: { error: { code: "X", message: "no" } },
      response: { status: 422 },
    });
    act(() => hook.result.current.clear());
    expect(hook.result.current.failure).toBeNull();
  });
});
