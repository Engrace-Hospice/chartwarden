// @vitest-environment jsdom
// The server's message for a field stays beside it only until the member edits that field; editing two fields in one event drops both, and
// a NEW refusal starts with nothing edited.
import type { OpsFailure } from "@chartwarden/ui";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useServerFieldErrors } from "./billing-field-errors";

const refusal = (fieldErrors: Record<string, string>): OpsFailure => ({
  kind: "validation",
  code: "X",
  status: 422,
  message: "bad",
  fieldErrors,
  details: [],
  current: null,
  blockedBy: null,
  correlationId: null,
});

describe("useServerFieldErrors", () => {
  it("drops a field's message when it is touched, and both when two are touched in one event", () => {
    const failure = refusal({ vendor: "v", mode: "m", secret: "s" });
    const { result } = renderHook(() => useServerFieldErrors(failure));
    expect(Object.keys(result.current.errors).sort()).toEqual(["mode", "secret", "vendor"]);
    act(() => {
      result.current.touch("vendor");
      result.current.touch("mode");
    });
    expect(result.current.errors).toEqual({ secret: "s" });
  });

  it("starts a new refusal with nothing edited", () => {
    const first = refusal({ secret: "s" });
    const { result, rerender } = renderHook(({ failure }) => useServerFieldErrors(failure), {
      initialProps: { failure: first as OpsFailure | null },
    });
    act(() => result.current.touch("secret"));
    expect(result.current.errors).toEqual({});
    rerender({ failure: refusal({ secret: "again" }) });
    expect(result.current.errors).toEqual({ secret: "again" });
  });

  it("has no errors without a refusal", () => {
    const { result } = renderHook(() => useServerFieldErrors(null));
    expect(result.current.errors).toEqual({});
  });
});
