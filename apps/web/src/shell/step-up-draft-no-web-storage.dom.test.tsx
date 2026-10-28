// #858 (CW-QA-0014): a step-up draft can carry clinical free text, so it must live in process memory only.
// The step-up redirect is a react-router navigation (same document), so memory survives the round trip.
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllDrafts } from "./ceremony-drafts";
import {
  discardStepUpDrafts,
  findStepUpDraftResourceId,
  markStepUpReturn,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  takeStepUpDraft,
} from "./step-up-redirect";

const OWNER = { userId: "u1", organizationId: "o1" };
const SECRET = "Patient reports chest pain, SSN 123-45-6789";
const key = stepUpDraftKey(OWNER, "addendum", "enc-1");

function webStorageDump(): string {
  return JSON.stringify([
    ...Object.entries({ ...window.sessionStorage }),
    ...Object.entries({ ...window.localStorage }),
  ]);
}

beforeEach(() => {
  clearAllDrafts();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("step-up drafts stay out of Web Storage", () => {
  it("never writes the free text to sessionStorage or localStorage", () => {
    stashStepUpDraft(key, { sections: { note: SECRET } });
    markStepUpReturn("/encounters/enc-1");
    expect(webStorageDump()).not.toContain("chest pain");
    expect(webStorageDump()).not.toContain("123-45-6789");
    expect(peekStepUpDraft<{ sections: { note: string } }>(key)?.sections.note).toBe(SECRET);
  });

  it("is consumed on take", () => {
    stashStepUpDraft(key, { note: SECRET });
    expect(takeStepUpDraft(key!)).toEqual({ note: SECRET });
    expect(takeStepUpDraft(key!)).toBeNull();
  });

  it("expires after the TTL", () => {
    const real = Date.now;
    stashStepUpDraft(key, { note: SECRET });
    Date.now = () => real() + 16 * 60_000;
    try {
      expect(peekStepUpDraft(key)).toBeNull();
    } finally {
      Date.now = real;
    }
  });

  it("is scoped to its owner: another user never sees it", () => {
    stashStepUpDraft(key, { note: SECRET });
    const other = stepUpDraftKey({ userId: "u2", organizationId: "o1" }, "addendum", "enc-1");
    expect(peekStepUpDraft(other)).toBeNull();
  });

  it("cancel (discard) clears every draft of the action", () => {
    stashStepUpDraft(key, { note: SECRET });
    discardStepUpDrafts(OWNER, "addendum");
    expect(findStepUpDraftResourceId(OWNER, "addendum")).toBeNull();
    expect(peekStepUpDraft(key)).toBeNull();
  });

  it("sign-out / screen lock (clearAllDrafts) clears every draft", () => {
    stashStepUpDraft(key, { note: SECRET });
    clearAllDrafts();
    expect(peekStepUpDraft(key)).toBeNull();
    expect(findStepUpDraftResourceId(OWNER, "addendum")).toBeNull();
  });
});
