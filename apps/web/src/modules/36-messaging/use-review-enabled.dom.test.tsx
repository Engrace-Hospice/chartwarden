// M36 WP 3.8: the Review tab gate reads the list route's `enabled` once per client; every other answer hides the tab.
import { renderHook, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useReviewEnabled } from "./use-review-enabled";

function gate(GET: unknown) {
  const client = { GET } as unknown as ApiClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
  return renderHook(() => useReviewEnabled(), { wrapper });
}

describe("useReviewEnabled", () => {
  it("is on only when the list route says enabled", async () => {
    const { result } = gate(vi.fn().mockResolvedValue({ data: { enabled: true, items: [] } }));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is off when the tenant flag is off", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { enabled: false, items: [] } });
    const { result } = gate(GET);
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it.each([
    ["a 401", vi.fn().mockResolvedValue({ error: {}, response: { status: 401 } })],
    ["a 403", vi.fn().mockResolvedValue({ error: {}, response: { status: 403 } })],
    ["a 404", vi.fn().mockResolvedValue({ error: {}, response: { status: 404 } })],
    ["no result at all", vi.fn().mockResolvedValue(undefined)],
    ["a rejected request", vi.fn().mockRejectedValue(new Error("down"))],
    [
      "a client that throws",
      vi.fn(() => {
        throw new Error("boom");
      }),
    ],
  ])("fails closed on %s", async (_name, GET) => {
    const { result } = gate(GET);
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("reads the list route, not a feature flag", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { enabled: true, items: [] } });
    gate(GET);
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(GET.mock.calls[0]?.[0]).toBe("/api/v1/messaging/review-items");
  });
});
