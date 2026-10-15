// M36 WP 3.8: the list read. The newest request wins (a slow older answer never overwrites it), a refusal reads as denied,
// and a state switch never shows the other state's rows.
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { REVIEW_FIXTURE } from "./review-test-fixture";
import { type ReviewStateFilter, useReviewItems } from "./use-review-items";

function setup(GET: unknown, initial: ReviewStateFilter = "open") {
  const client = { GET } as unknown as ApiClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
  return renderHook(({ state }) => useReviewItems(state), {
    wrapper,
    initialProps: { state: initial },
  });
}

describe("useReviewItems", () => {
  it("keeps the newest answer when an older request resolves last", async () => {
    let resolveOld: (v: unknown) => void = () => {};
    const old = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const GET = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce({
        data: { enabled: true, items: [{ ...REVIEW_FIXTURE, id: "new" }] },
      });
    const { result } = setup(GET);
    act(() => result.current.reload());
    await waitFor(() => {
      const view = result.current.view;
      expect(view.status === "ready" && view.items[0]?.id).toBe("new");
    });
    await act(async () => {
      resolveOld({ data: { enabled: true, items: [{ ...REVIEW_FIXTURE, id: "old" }] } });
      await Promise.resolve();
    });
    const view = result.current.view;
    expect(view.status === "ready" && view.items[0]?.id).toBe("new");
  });

  it.each([401, 403, 404])("reads a %s as denied", async (status) => {
    const { result } = setup(vi.fn().mockResolvedValue({ error: {}, response: { status } }));
    await waitFor(() => expect(result.current.view.status).toBe("denied"));
  });

  it("reads other failures as an error", async () => {
    const { result } = setup(vi.fn().mockRejectedValue(new Error("down")));
    await waitFor(() => expect(result.current.view.status).toBe("error"));
  });

  it("shows loading, not the other state's rows, after a state switch", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { enabled: true, items: [REVIEW_FIXTURE] } });
    const { result, rerender } = setup(GET);
    await waitFor(() => expect(result.current.view.status).toBe("ready"));
    GET.mockReturnValue(new Promise(() => {}));
    rerender({ state: "resolved" });
    expect(result.current.view.status).toBe("loading");
  });
});
