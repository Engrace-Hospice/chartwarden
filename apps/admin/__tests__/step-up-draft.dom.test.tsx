import { STEP_UP_DRAFT_TTL_MS, isValid, stashStepUpDraft, takeStepUpDraft } from "@chartwarden/ui";
// #597 F-043: the step-up draft is taken once, expires, and survives blocked storage.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("step-up draft", () => {
  it("returns what was stashed, once", () => {
    stashStepUpDraft("k", { a: 1 }, 1000);
    expect(takeStepUpDraft("k", 2000)).toEqual({ a: 1 });
    expect(takeStepUpDraft("k", 2000)).toBeUndefined();
  });

  it("drops a draft older than the TTL", () => {
    stashStepUpDraft("k", "x", 0);
    expect(takeStepUpDraft("k", STEP_UP_DRAFT_TTL_MS + 1)).toBeUndefined();
    expect(sessionStorage.length).toBe(0);
  });

  it("ignores malformed storage and keeps working when storage throws", () => {
    sessionStorage.setItem("wx.admin.step-up-draft:k", "{not json");
    expect(takeStepUpDraft("k")).toBeUndefined();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => stashStepUpDraft("k", 1)).not.toThrow();
  });
});

describe("isValid", () => {
  it("is true only when no field has a message", () => {
    expect(isValid({})).toBe(true);
    expect(isValid({ a: undefined, b: "" })).toBe(true);
    expect(isValid({ a: "Enter a name." })).toBe(false);
  });
});
