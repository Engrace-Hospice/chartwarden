// The shared name cache: remounts and sibling hook instances share one request per id, concurrency is capped,
// and the cache is per api client.
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePatientNames } from "./patient-names";
import {
  NAME_LOOKUP_CONCURRENCY,
  NAME_LOOKUP_TIMEOUT_MS,
  NAME_RETRY_MS,
  resetResolvedNamesForTests,
} from "./resolved-names";

beforeEach(() => resetResolvedNamesForTests());
afterEach(() => vi.useRealTimers());

const idN = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ok = (last: string) => ({ data: { firstName: "Pat", lastName: last }, error: undefined });
const withClient =
  (client: ApiClient) =>
  ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
const clientOf = (get: unknown) => ({ GET: get }) as unknown as ApiClient;

describe("shared name cache", () => {
  it("two hook instances asking for the same id make one request", async () => {
    const get = vi.fn(async () => ok("Same"));
    const wrapper = withClient(clientOf(get));
    const a = renderHook(() => usePatientNames([idN(1)]), { wrapper });
    const b = renderHook(() => usePatientNames([idN(1)]), { wrapper });
    await waitFor(() => expect(a.result.current[idN(1)]?.name).toBe("Same, Pat"));
    await waitFor(() => expect(b.result.current[idN(1)]?.name).toBe("Same, Pat"));
    a.unmount();
    const c = renderHook(() => usePatientNames([idN(1)]), { wrapper });
    await waitFor(() => expect(c.result.current[idN(1)]?.name).toBe("Same, Pat"));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not share answers across api clients", async () => {
    const getA = vi.fn(async () => ok("Alpha"));
    const getB = vi.fn(async () => ok("Beta"));
    const a = renderHook(() => usePatientNames([idN(1)]), { wrapper: withClient(clientOf(getA)) });
    const b = renderHook(() => usePatientNames([idN(1)]), { wrapper: withClient(clientOf(getB)) });
    await waitFor(() => expect(a.result.current[idN(1)]?.name).toBe("Alpha, Pat"));
    await waitFor(() => expect(b.result.current[idN(1)]?.name).toBe("Beta, Pat"));
  });

  it("settles an unreadable patient to null, and retries after a thrown lookup", async () => {
    let calls = 0;
    const get = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("down");
      return { data: undefined, error: { error: { code: "NOT_FOUND" } } };
    });
    const wrapper = withClient(clientOf(get));
    const first = renderHook(() => usePatientNames([idN(1)]), { wrapper });
    await waitFor(() => expect(first.result.current[idN(1)]).toBeNull());
    first.unmount();
    const second = renderHook(() => usePatientNames([idN(1)]), { wrapper });
    await waitFor(() => expect(second.result.current[idN(1)]).toBeNull());
    expect(get).toHaveBeenCalledTimes(2); // the throw was not cached; the settled null is
    second.unmount();
    renderHook(() => usePatientNames([idN(1)]), { wrapper });
    await act(async () => undefined);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("never runs more than the concurrency cap, across hook instances", async () => {
    let live = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const get = vi.fn(
      () =>
        new Promise((res) => {
          live += 1;
          peak = Math.max(peak, live);
          releases.push(() => {
            live -= 1;
            res(ok("N"));
          });
        }),
    );
    const wrapper = withClient(clientOf(get));
    const ids = Array.from({ length: 14 }, (_, i) => idN(i));
    const a = renderHook(() => usePatientNames(ids.slice(0, 7)), { wrapper });
    renderHook(() => usePatientNames(ids.slice(7)), { wrapper });
    await act(async () => undefined);
    expect(live).toBe(NAME_LOOKUP_CONCURRENCY);
    while (releases.length > 0) await act(async () => releases.shift()?.());
    await waitFor(() => expect(Object.keys(a.result.current).length).toBe(7));
    expect(peak).toBe(NAME_LOOKUP_CONCURRENCY);
    expect(get).toHaveBeenCalledTimes(14);
  });

  it("drops names resolved under a previous api client", async () => {
    const getA = vi.fn(async () => ok("Alpha"));
    const getB = vi.fn(async () => ok("Beta"));
    let client = clientOf(getA);
    const { result, rerender } = renderHook(() => usePatientNames([idN(1)]), {
      wrapper: ({ children }: { children: ReactNode }) => withClient(client)({ children }),
    });
    await waitFor(() => expect(result.current[idN(1)]?.name).toBe("Alpha, Pat"));
    client = clientOf(getB);
    rerender();
    await waitFor(() => expect(result.current[idN(1)]?.name).toBe("Beta, Pat"));
  });

  it("times out a hung lookup, frees its slot and retries once", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const get = vi.fn((): Promise<unknown> => {
      calls += 1;
      return calls === 1 ? new Promise(() => undefined) : Promise.resolve(ok("Later"));
    });
    const { result } = renderHook(() => usePatientNames([idN(1)]), {
      wrapper: withClient(clientOf(get)),
    });
    await act(async () => vi.advanceTimersByTimeAsync(NAME_LOOKUP_TIMEOUT_MS));
    expect(result.current[idN(1)]).toBeNull(); // unavailable, not stuck loading
    await act(async () => vi.advanceTimersByTimeAsync(NAME_RETRY_MS));
    expect(result.current[idN(1)]?.name).toBe("Later, Pat");
    expect(get).toHaveBeenCalledTimes(2);
  });
});
