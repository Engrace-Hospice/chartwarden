// @vitest-environment jsdom
// The Idempotency-Key lifecycle of useAckReassign: the server caches EVERY response (errors included) under the key, so the key
// survives only a thrown fetch (no response) and only while the body is unchanged.
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAckReassign } from "./use-ack-reassign";

const run = (perform: () => Promise<unknown>) => perform() as never;

function setup(post: ReturnType<typeof vi.fn>) {
  const client = {
    GET: vi.fn().mockResolvedValue({
      data: {
        candidates: [
          { user_id: "u-1", display_name: "Pat" },
          { user_id: "u-2", display_name: "Sam" },
        ],
      },
      response: { status: 200 },
    }),
    POST: post,
  } as unknown as ApiClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
  return renderHook(() => useAckReassign("party", "req-1", run as never), { wrapper });
}
const keyOf = (post: ReturnType<typeof vi.fn>, i: number) =>
  (post.mock.calls[i]?.[1] as { params: { header: Record<string, string> } }).params.header[
    "Idempotency-Key"
  ];

describe("useAckReassign Idempotency-Key", () => {
  it.each([422, 500])("is new on the retry after an HTTP %s", async (status) => {
    const post = vi.fn().mockResolvedValue({ error: {}, response: { status } });
    const { result } = setup(post);
    await waitFor(() => expect(result.current.candidates.status).toBe("ready"));
    act(() => result.current.setUserId("u-1"));
    await act(() => result.current.submit());
    await act(() => result.current.submit());
    expect(post).toHaveBeenCalledTimes(2);
    expect(keyOf(post, 1)).not.toBe(keyOf(post, 0));
  });

  it("is kept on the retry after a thrown fetch, and dropped when the choice changes", async () => {
    const post = vi.fn().mockRejectedValue(new TypeError("network"));
    const { result } = setup(post);
    await waitFor(() => expect(result.current.candidates.status).toBe("ready"));
    act(() => result.current.setUserId("u-1"));
    await act(() => result.current.submit());
    await act(() => result.current.submit());
    expect(keyOf(post, 1)).toBe(keyOf(post, 0));
    act(() => result.current.setUserId("u-2"));
    await act(() => result.current.submit());
    expect(keyOf(post, 2)).not.toBe(keyOf(post, 1));
  });
});
