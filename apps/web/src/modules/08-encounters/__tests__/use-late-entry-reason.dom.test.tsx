// @vitest-environment jsdom
// What the composer holds for the late-entry reason: when the box is up, what the finalize call carries, and that one note's reason never
// follows the author to another note.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WriteResult } from "../encounters-api";
import { LATE_ENTRY_REASON_MIN_CHARS, localCalendarDay } from "../late-entry-reason";
import { useLateEntryReason } from "../use-late-entry-reason";

const daysAgo = (days: number): string => {
  const day = new Date();
  day.setDate(day.getDate() - days);
  return localCalendarDay(day);
};
const LONG = "x".repeat(LATE_ENTRY_REASON_MIN_CHARS);
const failure = (code: string): WriteResult<never> => ({
  ok: false,
  status: 422,
  code,
  message: "refused",
  details: undefined,
});

type Props = { encounterId: string; serviceDate: string; editable: boolean };
const mount = (initial: Props) =>
  renderHook((props: Props) => useLateEntryReason(props), { initialProps: initial });

describe("useLateEntryReason", () => {
  it("is up for a late editable note, with the reason still outstanding", () => {
    const { result } = mount({ encounterId: "a", serviceDate: daysAgo(5), editable: true });

    expect(result.current.visible).toBe(true);
    expect(result.current.pending).toBe(true);
    expect(result.current.refusedAndShort).toBe(false);
    expect(result.current.estimate?.tier).toBe("significant_late_entry");
    expect(result.current.reasonForFinalize).toBeUndefined();
  });

  it("is not up for a note documented on time, or one that can no longer change", () => {
    expect(
      mount({ encounterId: "a", serviceDate: daysAgo(0), editable: true }).result.current.visible,
    ).toBe(false);
    expect(
      mount({ encounterId: "a", serviceDate: daysAgo(9), editable: false }).result.current.visible,
    ).toBe(false);
  });

  it("carries the trimmed reason only once it is long enough, and stops asking when it is", () => {
    const { result } = mount({ encounterId: "a", serviceDate: daysAgo(5), editable: true });

    act(() => result.current.setReason(LONG.slice(1)));
    expect(result.current.pending).toBe(true);
    expect(result.current.reasonForFinalize).toBeUndefined();

    act(() => result.current.setReason(`  ${LONG}  `));
    expect(result.current.pending).toBe(false);
    expect(result.current.reasonForFinalize).toBe(LONG);
    expect(result.current.visible).toBe(true);
  });

  it("brings the box up when the server refuses, whatever the device's day said, and moves focus each time", () => {
    const { result } = mount({ encounterId: "a", serviceDate: daysAgo(0), editable: true });
    expect(result.current.visible).toBe(false);

    let absorbed = false;
    act(() => {
      absorbed = result.current.absorbRefusal(failure("LATE_ENTRY_REASON_REQUIRED"));
    });
    expect(absorbed).toBe(true);
    expect(result.current.visible).toBe(true);
    expect(result.current.refusedAndShort).toBe(true);
    expect(result.current.focusRequests).toBe(1);

    act(() => {
      result.current.absorbRefusal(failure("LATE_ENTRY_REASON_REQUIRED"));
    });
    expect(result.current.focusRequests).toBe(2);

    act(() => result.current.setReason(LONG));
    expect(result.current.refusedAndShort).toBe(false);
    expect(result.current.visible).toBe(true);
  });

  it("leaves every other refusal alone", () => {
    const { result } = mount({ encounterId: "a", serviceDate: daysAgo(0), editable: true });

    let absorbed = true;
    act(() => {
      absorbed = result.current.absorbRefusal(failure("COMPLIANCE_GATE_FAILED"));
    });
    expect(absorbed).toBe(false);
    expect(result.current.visible).toBe(false);
  });

  it("starts another note empty and unrefused", () => {
    const { result, rerender } = mount({
      encounterId: "a",
      serviceDate: daysAgo(5),
      editable: true,
    });
    act(() => result.current.setReason(LONG));
    act(() => {
      result.current.absorbRefusal(failure("LATE_ENTRY_REASON_REQUIRED"));
    });

    rerender({ encounterId: "b", serviceDate: daysAgo(0), editable: true });

    expect(result.current.reason).toBe("");
    expect(result.current.visible).toBe(false);
    expect(result.current.focusRequests).toBe(0);

    // Nothing is kept for the first note either: its reason does not come back when the author returns to it.
    rerender({ encounterId: "a", serviceDate: daysAgo(5), editable: true });
    expect(result.current.reason).toBe("");
    expect(result.current.refusedAndShort).toBe(false);
  });

  it("counts a typed reason as unsent while the box is on screen, and nothing else", () => {
    const { result, rerender } = mount({
      encounterId: "a",
      serviceDate: daysAgo(5),
      editable: true,
    });
    expect(result.current.unsent).toBe(false);

    act(() => result.current.setReason("   "));
    expect(result.current.unsent).toBe(false);

    act(() => result.current.setReason("Family needed me"));
    expect(result.current.unsent).toBe(true);

    // The note can no longer change (finalized elsewhere): the box is gone and there is nothing left to lose.
    rerender({ encounterId: "a", serviceDate: daysAgo(5), editable: false });
    expect(result.current.unsent).toBe(false);
  });

  it("holds nothing as unsent once the reason is cleared", () => {
    const { result } = mount({ encounterId: "a", serviceDate: daysAgo(5), editable: true });
    act(() => result.current.setReason(LONG));
    expect(result.current.unsent).toBe(true);

    act(() => result.current.clear());

    expect(result.current.unsent).toBe(false);
  });

  it("lets go of the reason once the note is finalized", () => {
    const { result } = mount({ encounterId: "a", serviceDate: daysAgo(5), editable: true });
    act(() => result.current.setReason(LONG));

    act(() => result.current.clear());

    expect(result.current.reason).toBe("");
  });
});
