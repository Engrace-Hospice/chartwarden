// usePatientNames: names are never stranded by StrictMode's mount/unmount/mount, by a change of ids mid-fetch, or by a
// failed lookup (retried on a later render).
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiClient } from "@wardenx/ui";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PATIENT_NAME_BACKOFF_MS,
  PATIENT_NAME_CONCURRENCY,
  PATIENT_NAME_MAX_ATTEMPTS,
  usePatientNames,
} from "../use-patient-names";

afterEach(() => vi.useRealTimers());

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const name = (last: string) => ({
  data: { firstName: "Pat", lastName: last },
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const failure = () => ({
  data: undefined,
  error: { error: { code: "X" } },
  response: new Response(null, { status: 500 }),
});
const api = (get: ReturnType<typeof vi.fn>) => ({ GET: get }) as unknown as ApiClient;

describe("usePatientNames", () => {
  it("loads every name under StrictMode (effect run, cleanup, run again)", async () => {
    const get = vi.fn(async (_p: string, a: { params: { path: { id: string } } }) =>
      name(`Name-${a.params.path.id.slice(0, 1)}`),
    );
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => usePatientNames(api(get), [A, B]), { wrapper });
    await waitFor(() => expect(Object.keys(result.current).sort()).toEqual([A, B]));
    expect(result.current[A]?.lastName).toBe("Name-a");
  });

  it("still applies a fetch that was in flight when the ids changed", async () => {
    let release: (v: unknown) => void = () => undefined;
    const get = vi.fn((_p: string, a: { params: { path: { id: string } } }) =>
      a.params.path.id === A
        ? new Promise((res) => {
            release = res;
          })
        : Promise.resolve(name("Bee")),
    );
    const { result, rerender } = renderHook(({ ids }) => usePatientNames(api(get), ids), {
      initialProps: { ids: [A] },
    });
    rerender({ ids: [B] });
    await waitFor(() => expect(result.current[B]?.lastName).toBe("Bee"));
    await act(async () => release(name("Ay")));
    await waitFor(() => expect(result.current[A]?.lastName).toBe("Ay"));
  });

  it("retries a failed lookup on a timer with backoff, with no re-render needed", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const get = vi.fn(async () => (++calls === 1 ? failure() : name("Retry")));
    const { result } = renderHook(() => usePatientNames(api(get), [A]));
    await act(async () => undefined);
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current[A]).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PATIENT_NAME_BACKOFF_MS);
    });
    expect(result.current[A]?.lastName).toBe("Retry");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_ATTEMPTS even when every lookup fails and nothing re-renders", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => failure());
    const { rerender } = renderHook(() => usePatientNames(api(get), [A]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(get).toHaveBeenCalledTimes(PATIENT_NAME_MAX_ATTEMPTS);
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(get).toHaveBeenCalledTimes(PATIENT_NAME_MAX_ATTEMPTS);
  });

  it("does not burn its attempts on quick re-renders", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => failure());
    const { rerender } = renderHook(() => usePatientNames(api(get), [A]));
    for (let i = 0; i < 6; i++) {
      rerender();
      await act(async () => undefined);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("never runs more than the concurrency cap, however many renders ask", async () => {
    const ids = Array.from(
      { length: 10 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
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
            res(name("N"));
          });
        }),
    );
    const { result, rerender } = renderHook(() => usePatientNames(api(get), ids));
    rerender();
    rerender();
    await act(async () => undefined);
    expect(live).toBe(PATIENT_NAME_CONCURRENCY);
    while (releases.length > 0) {
      await act(async () => releases.shift()?.());
    }
    await waitFor(() => expect(Object.keys(result.current).length).toBe(10));
    expect(peak).toBe(PATIENT_NAME_CONCURRENCY);
    expect(get).toHaveBeenCalledTimes(10);
  });

  it("stops on unmount: queued ids are never fetched and nothing is applied", async () => {
    const ids = Array.from(
      { length: 10 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const releases: (() => void)[] = [];
    const get = vi.fn(() => new Promise((res) => releases.push(() => res(name("N")))));
    const view = renderHook(() => usePatientNames(api(get), ids));
    await act(async () => undefined);
    expect(get).toHaveBeenCalledTimes(PATIENT_NAME_CONCURRENCY);
    view.unmount();
    await act(async () => {
      for (const r of releases) r();
    });
    expect(get).toHaveBeenCalledTimes(PATIENT_NAME_CONCURRENCY);
  });
});
