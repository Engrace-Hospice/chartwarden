// Workflow 09, WP1 (R18) — a screen that re-renders on every keystroke (the composer) must not parse its `?from=` again each time.
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { useForwardReturn, useReturnTarget } from "./use-return-target";

const wrap = (path: string) =>
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
  };

describe("useReturnTarget", () => {
  const path = `/x?from=${encodeURIComponent("/me/visits?status=completed")}`;

  it("returns the same target on every render of the same address", () => {
    const { result, rerender } = renderHook(() => useReturnTarget(), { wrapper: wrap(path) });
    const first = result.current;
    rerender();
    rerender();
    expect(first?.href).toBe("/me/visits?status=completed");
    expect(result.current).toBe(first);
  });

  it("returns the same forwarding function on every render, and forwards the origin with it", () => {
    const { result, rerender } = renderHook(() => useForwardReturn(), { wrapper: wrap(path) });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first("/patients/p-1/encounters/e-1")).toBe(
      `/patients/p-1/encounters/e-1?from=${encodeURIComponent("/me/visits?status=completed")}`,
    );
  });

  it("forwards nothing when the address carries no origin", () => {
    const { result } = renderHook(() => useForwardReturn(), { wrapper: wrap("/x") });
    expect(result.current("/patients/p-1/encounters/e-1")).toBe("/patients/p-1/encounters/e-1");
  });
});
