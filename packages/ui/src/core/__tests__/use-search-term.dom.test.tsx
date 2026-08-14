// packages/ui/src/core/__tests__ — the in-memory search-needle store (GAP-080).
//
// The store exists so a patient name / MRN never has to travel through the URL to get from the
// shell's top-nav search box to M5's results screen. These cases pin the two properties that made a
// store the right shape rather than a one-shot hand-off: a term staged while the reader is ALREADY
// mounted must reach it, and reading must be idempotent (a read-and-clear consumed in an effect or
// a `useState` initializer is double-invoked under StrictMode and the second mount finds it gone).
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetSearchTermForTest,
  clearSearchTerm,
  setSearchTerm,
  useSearchTerm,
} from "../hooks/use-search-term";

afterEach(() => __resetSearchTermForTest());

describe("search-term store", () => {
  it("starts empty — a cold load of /search has no needle, by design", () => {
    const { result } = renderHook(() => useSearchTerm());
    expect(result.current).toBe("");
  });

  it("delivers a term staged BEFORE the reader mounts", () => {
    setSearchTerm("Doe, Jane");
    const { result } = renderHook(() => useSearchTerm());
    expect(result.current).toBe("Doe, Jane");
  });

  it("delivers a term staged WHILE the reader is mounted", () => {
    // Searching again from the top-nav bar without leaving the results screen. A one-shot hand-off
    // read at mount time would never see this.
    const { result } = renderHook(() => useSearchTerm());
    act(() => setSearchTerm("MRN-4417"));
    expect(result.current).toBe("MRN-4417");
  });

  it("is idempotent to read — two mounts see the same staged term", () => {
    setSearchTerm("Okafor");
    const a = renderHook(() => useSearchTerm());
    const b = renderHook(() => useSearchTerm());
    expect(a.result.current).toBe("Okafor");
    expect(b.result.current).toBe("Okafor");
  });

  it("survives StrictMode's double-invoked render/effect cycle", () => {
    setSearchTerm("Okafor");
    const { result } = renderHook(() => useSearchTerm(), { wrapper: StrictMode });
    expect(result.current).toBe("Okafor");
  });

  it("trims, and treats a whitespace-only term as no term", () => {
    const { result } = renderHook(() => useSearchTerm());
    act(() => setSearchTerm("  Ramirez  "));
    expect(result.current).toBe("Ramirez");
    act(() => setSearchTerm("   "));
    expect(result.current).toBe("");
  });

  it("clears", () => {
    setSearchTerm("Ramirez");
    const { result } = renderHook(() => useSearchTerm());
    act(() => clearSearchTerm());
    expect(result.current).toBe("");
  });

  it("unsubscribes on unmount — a staged term does not touch a torn-down reader", () => {
    const { result, unmount } = renderHook(() => useSearchTerm());
    unmount();
    expect(() => setSearchTerm("after-unmount")).not.toThrow();
    expect(result.current).toBe("");
  });
});
