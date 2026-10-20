// Sign-out / screen lock forget every draft, including the sessionStorage step-up stash.
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllDrafts } from "./ceremony-drafts";
import {
  markStepUpReturn,
  peekStepUpDraft,
  peekStepUpReturn,
  stashStepUpDraft,
} from "./step-up-redirect";

beforeEach(() => window.sessionStorage.clear());

describe("clearAllDrafts", () => {
  it("also drops stashed step-up drafts and the return marker", () => {
    stashStepUpDraft("o|u|act|new", { reason: "free text" });
    markStepUpReturn("/x");
    clearAllDrafts();
    expect(peekStepUpDraft("o|u|act|new")).toBeNull();
    expect(peekStepUpReturn("/x")).toBe(false);
  });
});
