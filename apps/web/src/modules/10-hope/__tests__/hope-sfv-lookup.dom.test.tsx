// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSfvOfSignedRecord } from "../hope-sfv-lookup";

type Reply = { data?: unknown; error?: unknown; response?: Response };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const row = (triggeringAssessmentId: string, status: string, completingAssessmentId?: string) => ({
  id: `sfv-${triggeringAssessmentId}`,
  triggeringAssessmentId,
  status,
  completingAssessmentId: completingAssessmentId ?? null,
});
const queue = (...rows: unknown[]): Reply => ({ data: { sfvs: rows } });

function clientWith(get: (...args: unknown[]) => Promise<Reply>): ApiClient {
  return { GET: vi.fn(get) } as unknown as ApiClient;
}

function renderLookup(client: ApiClient, initial: { id: string; enabled?: boolean; key?: number }) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
  return renderHook(
    (props: { id: string; enabled: boolean; key: number }) =>
      useSfvOfSignedRecord(props.id, props.enabled, props.key),
    {
      wrapper,
      initialProps: { id: initial.id, enabled: initial.enabled ?? true, key: initial.key ?? 0 },
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSfvOfSignedRecord", () => {
  it("asks nothing, and reports idle, while it is not enabled", () => {
    const client = clientWith(async () => queue());
    const { result } = renderLookup(client, { id: "a", enabled: false });
    expect(result.current.lookup).toEqual({ state: "idle" });
    expect(client.GET).not.toHaveBeenCalled();
  });

  it("asks the server for this record's follow-up only, and never reads the unfiltered worklist", async () => {
    const client = clientWith(async () => queue(row("a", "open")));
    const { result, rerender } = renderLookup(client, { id: "a" });
    await waitFor(() => expect(result.current.lookup).toMatchObject({ state: "found" }));
    rerender({ id: "b", enabled: true, key: 0 });
    await waitFor(() => expect(client.GET).toHaveBeenCalledTimes(2));

    const calls = vi.mocked(client.GET as unknown as (...args: unknown[]) => unknown).mock.calls;
    // Each read carries an abort signal: a lookup nobody answers is bounded (it ends as `failed`, not `loading` for good).
    expect(calls).toEqual([
      [
        "/api/v1/hope/sfv",
        { params: { query: { triggeringAssessmentId: "a" } }, signal: expect.any(AbortSignal) },
      ],
      [
        "/api/v1/hope/sfv",
        { params: { query: { triggeringAssessmentId: "b" } }, signal: expect.any(AbortSignal) },
      ],
    ]);
  });

  it("finds this record's follow-up by its triggering assessment, with the assessment that completed it", async () => {
    const client = clientWith(async () =>
      queue(row("other", "open"), row("a", "completed", "rfa-04-1")),
    );
    const { result } = renderLookup(client, { id: "a" });
    expect(result.current.lookup).toEqual({ state: "loading" });
    await waitFor(() =>
      expect(result.current.lookup).toEqual({
        state: "found",
        status: "completed",
        completingAssessmentId: "rfa-04-1",
      }),
    );
  });

  it("ignores a response that arrives after the record changed", async () => {
    const first = deferred<Reply>();
    const second = deferred<Reply>();
    const replies = [first, second];
    const client = clientWith(
      () => (replies.shift() as ReturnType<typeof deferred<Reply>>).promise,
    );
    const { result, rerender } = renderLookup(client, { id: "a" });
    rerender({ id: "b", enabled: true, key: 0 });

    await act(async () => {
      second.resolve(queue(row("b", "open")));
    });
    await waitFor(() =>
      expect(result.current.lookup).toMatchObject({ state: "found", status: "open" }),
    );
    await act(async () => {
      first.resolve(queue(row("a", "completed")));
    });
    expect(result.current.lookup).toMatchObject({ state: "found", status: "open" });
  });

  it("ignores a response that arrives after the reload key moved on", async () => {
    const stale = deferred<Reply>();
    const fresh = deferred<Reply>();
    const replies = [stale, fresh];
    const client = clientWith(
      () => (replies.shift() as ReturnType<typeof deferred<Reply>>).promise,
    );
    const { result, rerender } = renderLookup(client, { id: "a", key: 0 });
    rerender({ id: "a", enabled: true, key: 1 });

    await act(async () => {
      fresh.resolve(queue(row("a", "completed")));
    });
    await waitFor(() =>
      expect(result.current.lookup).toMatchObject({ state: "found", status: "completed" }),
    );
    await act(async () => {
      stale.resolve(queue(row("a", "open")));
    });
    expect(result.current.lookup).toMatchObject({ state: "found", status: "completed" });
  });

  // There is deliberately no "screen goes away while the request is in flight" test: React 18 emits no warning for a state update
  // on an unmounted component and the update is a no-op, so a console.error spy passes with or without the `current` guard
  // (checked: with the guard deleted from a copy of the hook, that test still passed). Unmount and a changed record or key run
  // the same cleanup (`current = false`), and the two stale-reply tests above are the ones that fail without it.

  it("reports failed for an error answer and for a request that rejects, and retry asks again", async () => {
    const get = vi
      .fn<(...args: unknown[]) => Promise<Reply>>()
      .mockResolvedValueOnce({ error: { error: { message: "down" } } })
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(queue(row("a", "open")));
    const client = clientWith(get);
    const { result } = renderLookup(client, { id: "a" });

    await waitFor(() => expect(result.current.lookup).toEqual({ state: "failed" }));
    act(() => result.current.retry());
    expect(result.current.lookup).toEqual({ state: "loading" });
    await waitFor(() => expect(result.current.lookup).toEqual({ state: "failed" }));
    act(() => result.current.retry());
    await waitFor(() =>
      expect(result.current.lookup).toMatchObject({ state: "found", status: "open" }),
    );
    expect(get).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a gateway reply with no body at all", { response: new Response(null, { status: 502 }) }],
    [
      "a non-OK reply with an empty error body",
      { error: "", response: new Response(null, { status: 503 }) },
    ],
    ["a reply with no data and no error", {}],
  ])(
    "reports failed, never none, for %s: an unreadable queue does not say the follow-up cannot be completed",
    async (_name, reply) => {
      const { result } = renderLookup(
        clientWith(async () => reply),
        { id: "a" },
      );
      await waitFor(() => expect(result.current.lookup).toEqual({ state: "failed" }));
    },
  );

  it.each([
    ["no row for this record", queue(row("other", "open"))],
    ["a status it does not know", queue(row("a", "reopened"))],
    ["a malformed answer", { data: { unexpected: true } }],
  ])("reports none for %s", async (_name, reply) => {
    const { result } = renderLookup(
      clientWith(async () => reply),
      { id: "a" },
    );
    await waitFor(() => expect(result.current.lookup).toEqual({ state: "none" }));
  });
});
