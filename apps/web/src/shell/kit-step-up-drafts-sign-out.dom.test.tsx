import {
  peekStepUpDraft as peekKitDraft,
  peekStepUpMemoryDraft,
  stashStepUpDraft as stashKitDraft,
  stashStepUpMemoryDraft,
} from "@chartwarden/ui";
// @vitest-environment jsdom
// The shared kit (packages/ui) keeps its own step-up draft stores: a memory map and a sessionStorage entry. Sign-out and the idle screen
// lock call `clearAllDrafts`, which must forget those too, or the next person on the same tab within the draft's 15 minutes is handed
// what the last one typed (an evidence note, a skip reason, a go-live note).
import { describe, expect, it } from "vitest";
import { clearAllDrafts } from "./ceremony-drafts";

describe("clearAllDrafts and the kit's step-up draft stores", () => {
  it("forgets a draft stashed through the kit's memory store", () => {
    stashStepUpMemoryDraft("wizard:test:note", { note: "free text" });
    expect(peekStepUpMemoryDraft("wizard:test:note")).toEqual({ note: "free text" });
    clearAllDrafts();
    expect(peekStepUpMemoryDraft("wizard:test:note")).toBeUndefined();
  });

  it("forgets a draft stashed through the kit's sessionStorage store", () => {
    stashKitDraft("wizard:test:profile", { displayName: "x" });
    expect(peekKitDraft("wizard:test:profile")).toEqual({ displayName: "x" });
    clearAllDrafts();
    expect(peekKitDraft("wizard:test:profile")).toBeUndefined();
  });
});
