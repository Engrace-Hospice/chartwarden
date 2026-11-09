// #597 F-043: the step-up draft is restored once per mount (also under StrictMode) and only on the return from step-up (the
// history state StepUpCard navigates back with, or the caller's `returned`), expires, is wiped on sign-out, and survives blocked storage.
import {
  STEP_UP_DRAFT_TTL_MS,
  STEP_UP_RETURN_STATE,
  discardStepUpDrafts,
  isValid,
  peekStepUpMemoryDraft,
  stashStepUpDraft,
  stashStepUpMemoryDraft,
  useStepUpDraft,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "wx.admin.step-up-draft:k";
/** A mount on the return from a successful step-up: the history state StepUpCard navigates back with. */
const RETURNED = { pathname: "/", state: STEP_UP_RETURN_STATE };

function Probe({ returned }: { returned?: boolean }): JSX.Element {
  const draft = useStepUpDraft<{ a: number }>("k", returned);
  return <output>{draft ? `a=${draft.a}` : "none"}</output>;
}

function MemoryProbe({ returned }: { returned?: boolean }): JSX.Element {
  const draft = useStepUpMemoryDraft<{ a: number }>("m", returned);
  return <output>{draft ? `a=${draft.a}` : "none"}</output>;
}

function mount(ui: ReactElement, entry: string | typeof RETURNED = "/"): void {
  render(<MemoryRouter initialEntries={[entry]}>{ui}</MemoryRouter>);
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  discardStepUpDrafts();
  vi.restoreAllMocks();
});

describe("step-up draft", () => {
  it("restores what was stashed and removes it once mounted", () => {
    stashStepUpDraft("k", { a: 1 });
    mount(<Probe />, RETURNED);
    expect(screen.getByText("a=1")).toBeTruthy();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("still restores under StrictMode, which runs initializers twice", () => {
    stashStepUpDraft("k", { a: 2 });
    mount(
      <StrictMode>
        <Probe />
      </StrictMode>,
      RETURNED,
    );
    expect(screen.getByText("a=2")).toBeTruthy();
  });

  it("drops a draft older than the TTL", () => {
    stashStepUpDraft("k", { a: 3 }, Date.now() - STEP_UP_DRAFT_TTL_MS - 1);
    mount(<Probe />, RETURNED);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("a mount without the return state restores nothing and still consumes the draft", () => {
    stashStepUpDraft("k", { a: 4 });
    mount(<Probe />);
    expect(screen.getByText("none")).toBeTruthy();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    cleanup();
    mount(<Probe />, RETURNED);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("`returned` restores without the location marker, and still consumes the draft", () => {
    stashStepUpDraft("k", { a: 5 });
    mount(<Probe returned />);
    expect(screen.getByText("a=5")).toBeTruthy();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
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
    mount(<Probe />, RETURNED);
    expect(screen.getByText("none")).toBeTruthy();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => stashStepUpDraft("k", 1)).not.toThrow();
  });
});

describe("step-up memory draft", () => {
  it("restores on the return from step-up and drops the draft once mounted", () => {
    stashStepUpMemoryDraft("m", { a: 1 });
    mount(<MemoryProbe />, RETURNED);
    expect(screen.getByText("a=1")).toBeTruthy();
    expect(peekStepUpMemoryDraft("m")).toBeUndefined();
  });

  it("a mount without the return state restores nothing and still consumes the draft", () => {
    stashStepUpMemoryDraft("m", { a: 2 });
    mount(<MemoryProbe />);
    expect(screen.getByText("none")).toBeTruthy();
    expect(peekStepUpMemoryDraft("m")).toBeUndefined();
    cleanup();
    mount(<MemoryProbe />, RETURNED);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("`returned` restores without the location marker", () => {
    stashStepUpMemoryDraft("m", { a: 3 });
    mount(<MemoryProbe returned />);
    expect(screen.getByText("a=3")).toBeTruthy();
    expect(peekStepUpMemoryDraft("m")).toBeUndefined();
  });
});

describe("isValid", () => {
  it("is true only when no field has a message", () => {
    expect(isValid({})).toBe(true);
    expect(isValid({ a: undefined, b: "" })).toBe(true);
    expect(isValid({ a: "Enter a name." })).toBe(false);
  });
});
