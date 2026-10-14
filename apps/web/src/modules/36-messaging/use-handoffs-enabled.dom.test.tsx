// M36 WP 3.5: the Handoffs gate reads the list route's `enabled` once per client and fails closed on any failure.
import { renderHook, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useHandoffsEnabled } from "./use-handoffs-enabled";

function gate(GET: unknown) {
  const client = { GET } as unknown as ApiClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
  return renderHook(() => useHandoffsEnabled(), { wrapper });
}

describe("useHandoffsEnabled", () => {
  it("is on only when the list route says enabled", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { enabled: true, handoffs: [] } });
    const { result } = gate(GET);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is off when the tenant flag is off", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { enabled: false, handoffs: [] } });
    const { result } = gate(GET);
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it.each([
    ["an error body", vi.fn().mockResolvedValue({ error: {}, response: { status: 500 } })],
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBe(false);
  });

  it("does not cache a failure, so a later mount tries again", async () => {
    const GET = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ data: { enabled: true, handoffs: [] } });
    const client = { GET } as unknown as ApiClient;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiClientProvider client={client}>{children}</ApiClientProvider>
    );
    const first = renderHook(() => useHandoffsEnabled(), { wrapper });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = renderHook(() => useHandoffsEnabled(), { wrapper });
    await waitFor(() => expect(second.result.current).toBe(true));
  });
});
