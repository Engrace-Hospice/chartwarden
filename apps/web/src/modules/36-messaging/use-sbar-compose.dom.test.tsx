import type { SbarSections } from "@chartwarden/types";
// M36 WP 3.3: restoring a server draft into the SBAR form never throws away an urgency the user already picked.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSbarCompose } from "./use-sbar-compose";

const SERVER: SbarSections = {
  urgencyHint: "important",
  sections: { situation: "s", background: "b", assessment: "a", recommendation: "r" },
};

describe("useSbarCompose.restore", () => {
  it("keeps an urgency picked before the read returned when the sections are still blank", () => {
    const { result } = renderHook(() => useSbarCompose("discipline"));
    act(() => result.current.setValues({ ...result.current.values, urgency: "urgent" }));
    act(() => result.current.restore(SERVER, true));
    expect(result.current.values.urgency).toBe("urgent");
    expect(result.current.values.sections).toEqual(SERVER.sections);
  });

  it("a conflict resolution takes the chosen side's urgency over a picked one", () => {
    const { result } = renderHook(() => useSbarCompose("discipline"));
    act(() => result.current.setValues({ ...result.current.values, urgency: "urgent" }));
    act(() => result.current.restore(SERVER));
    expect(result.current.values.urgency).toBe("important");
  });

  it("takes the server urgency when none was picked", () => {
    const { result } = renderHook(() => useSbarCompose("discipline"));
    act(() => result.current.restore(SERVER));
    expect(result.current.values.urgency).toBe("important");
  });

  it("restoring nothing over a blank form leaves a picked urgency alone", () => {
    const { result } = renderHook(() => useSbarCompose("discipline"));
    act(() => result.current.setValues({ ...result.current.values, urgency: "urgent" }));
    act(() => result.current.restore(null, true));
    expect(result.current.values.urgency).toBe("urgent");
  });

  it("restoring nothing over typed sections clears them", () => {
    const { result } = renderHook(() => useSbarCompose("discipline"));
    act(() => result.current.restore(SERVER));
    act(() => result.current.restore(null));
    expect(result.current.values.sections.situation).toBe("");
  });
});
