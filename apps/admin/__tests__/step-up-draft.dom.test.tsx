// #597 F-043: the step-up draft is restored once per mount (also under StrictMode), expires, is wiped on sign-out, and
// survives blocked storage.
import {
  STEP_UP_DRAFT_TTL_MS,
  discardStepUpDrafts,
  isValid,
  stashStepUpDraft,
  useStepUpDraft,
} from "@chartwarden/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "wx.admin.step-up-draft:k";

function Probe(): JSX.Element {
  const draft = useStepUpDraft<{ a: number }>("k");
  return <output>{draft ? `a=${draft.a}` : "none"}</output>;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("step-up draft", () => {
  it("restores what was stashed and removes it once mounted", () => {
    stashStepUpDraft("k", { a: 1 });
    render(<Probe />);
    expect(screen.getByText("a=1")).toBeTruthy();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("still restores under StrictMode, which runs initializers twice", () => {
    stashStepUpDraft("k", { a: 2 });
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    expect(screen.getByText("a=2")).toBeTruthy();
  });

  it("drops a draft older than the TTL", () => {
    stashStepUpDraft("k", { a: 3 }, Date.now() - STEP_UP_DRAFT_TTL_MS - 1);
    render(<Probe />);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("wipes every stashed draft on sign-out", () => {
    stashStepUpDraft("k", { a: 1 });
    stashStepUpDraft("other", { a: 2 });
    sessionStorage.setItem("unrelated", "keep");
    discardStepUpDrafts();
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
  });

  it("ignores malformed storage and keeps working when storage throws", () => {
    sessionStorage.setItem(STORAGE_KEY, "{not json");
    render(<Probe />);
    expect(screen.getByText("none")).toBeTruthy();
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
