// usePatientNames: names are never stranded by StrictMode's mount/unmount/mount, by a change of ids mid-fetch, or by a
// failed lookup (retried on a later render).
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiClient } from "@wardenx/ui";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { usePatientNames } from "../use-patient-names";

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

  it("retries a failed lookup on a later render, and never fetches a settled id twice", async () => {
    let calls = 0;
    const get = vi.fn(async () => (++calls === 1 ? failure() : name("Retry")));
    const { result, rerender } = renderHook(() => usePatientNames(api(get), [A]));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(result.current[A]).toBeUndefined();
    rerender();
    await waitFor(() => expect(result.current[A]?.lastName).toBe("Retry"));
    rerender();
    await act(async () => undefined);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
