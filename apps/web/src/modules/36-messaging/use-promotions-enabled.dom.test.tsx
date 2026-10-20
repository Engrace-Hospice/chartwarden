// The chart-promotion index read must respect the server's `limit` cap (100): a larger value is a 422 and the
// index (and every per-message status chip) never loads.
import { renderHook, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { usePromotionsEnabled } from "./use-promotions-enabled";

const SERVER_MAX_LIMIT = 100;

describe("usePromotionsEnabled", () => {
  it("asks for no more than the server's maximum page size", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { enabled: true, promotions: [] } });
    const client = { GET } as unknown as ApiClient;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiClientProvider client={client}>{children}</ApiClientProvider>
    );
    const { result } = renderHook(() => usePromotionsEnabled(), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
    const query = GET.mock.calls[0]?.[1]?.params?.query as { limit: number };
    expect(query.limit).toBeLessThanOrEqual(SERVER_MAX_LIMIT);
  });
});
