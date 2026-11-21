// @vitest-environment jsdom
// Whether the late-entry reason field stays on screen: once a refused finalize asked for it, for THAT note only.
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GateAttempt } from "../refusal-model";
import { useLateEntryReasonShown } from "../use-late-entry-reason-shown";

const NONE: GateAttempt = { state: "none" };
const RUNNING: GateAttempt = { state: "running" };
// Only the fields the hook's question reads; a synthetic refusal that asks for a late-entry reason.
const ASKS = {
  state: "refused",
  refusal: {
    outcome: "blocked",
    moment: "finalize",
    blockers: [{ code: "LATE_ENTRY_REASON_REQUIRED" }],
  },
} as unknown as GateAttempt;

function mount(initial: { attempt: GateAttempt; note: string; reason?: string }) {
  return renderHook(
    (p: { attempt: GateAttempt; note: string; reason?: string }) =>
      useLateEntryReasonShown(p.attempt, p.reason ?? "", p.note),
    { initialProps: initial },
  );
}

describe("useLateEntryReasonShown", () => {
  it("is off until a refusal asks, and stays on through the next finalize (no remount)", () => {
    const { result, rerender } = mount({ attempt: NONE, note: "A" });
    expect(result.current).toBe(false);
    rerender({ attempt: ASKS, note: "A" });
    expect(result.current).toBe(true);
    rerender({ attempt: RUNNING, note: "A" });
    expect(result.current).toBe(true);
  });

  it("starts another note without it, and does not bring it back on returning to the first note", () => {
    const { result, rerender } = mount({ attempt: ASKS, note: "A" });
    expect(result.current).toBe(true);
    rerender({ attempt: NONE, note: "B" });
    expect(result.current).toBe(false);
    rerender({ attempt: NONE, note: "A" });
    expect(result.current).toBe(false);
  });

  it("shows a reason typed ahead of any request", () => {
    const { result } = mount({ attempt: NONE, note: "A", reason: "typed early" });
    expect(result.current).toBe(true);
  });
});
