// What the signer reads when a ceremony write (sign, cosign, release) is refused, by the server's code (M8 / ADR-0114). The sentences are
// the app's own, never the envelope's text, so each says what happened to the note and what to do next. Synthetic data only.
import { describe, expect, it } from "vitest";
import { writeRefusalMessage } from "../write-refusal";

const refusal = (over: Partial<Parameters<typeof writeRefusalMessage>[0]> = {}) =>
  writeRefusalMessage({
    status: 409,
    code: undefined,
    message: undefined,
    details: undefined,
    ...over,
  });

describe("409 DRAFT_OFF_AFTER_FINALIZE", () => {
  const text = refusal({
    code: "DRAFT_OFF_AFTER_FINALIZE",
    message: "switch the draft back on, then sign again",
  });

  it("says why the note cannot be signed and that nothing was changed", () => {
    expect(text).toContain("finalized with drafted text");
    expect(text).toContain("switched off");
    expect(text).toContain("still finalized");
  });

  it("names the next step: an administrator switches the draft on, then sign again", () => {
    expect(text).toContain("Ask an administrator");
    expect(text).toContain("Visit-note Draft");
    expect(text).toMatch(/then sign again\.?$/);
  });

  it("does not read as the stale-section refusal or a permission denial", () => {
    expect(text).not.toContain("need another look");
    expect(text).not.toContain("do not have permission");
  });
});

describe("the refusals that were already there", () => {
  it("names the stale drafted sections in words", () => {
    const text = refusal({
      code: "DRAFT_SECTION_STALE",
      details: [{ field: "vitals_review", code: "DRAFT_SECTION_UNRESOLVED", message: "x" }],
    });
    expect(text).toContain("Vitals review (not confirmed or deselected yet)");
  });

  it("asks the signer to choose a modality", () => {
    expect(refusal({ code: "MODALITY_CONFIRMATION_REQUIRED" })).toBe(
      "Choose how this visit was delivered, then sign again.",
    );
  });

  it("uses the server's own words for an invalid visit time, with a fallback", () => {
    expect(refusal({ code: "VISIT_TIME_INVALID", message: "End is before start." })).toBe(
      "End is before start.",
    );
    expect(refusal({ code: "VISIT_TIME_INVALID" })).toContain("sign again");
  });

  it("says the step-up expired on a 412", () => {
    expect(refusal({ status: 412, code: "STEP_UP_AUTH_REQUIRED" })).toBe(
      "Your step-up expired — try again.",
    );
  });

  it("says the draft could not be checked on COMPLIANCE_GATE_UNAVAILABLE", () => {
    expect(refusal({ status: 503, code: "COMPLIANCE_GATE_UNAVAILABLE" })).toBe(
      "The visit-note draft could not be checked right now. Try again in a moment.",
    );
  });

  it("says the encounter changed on STALE_VERSION", () => {
    expect(refusal({ code: "STALE_VERSION" })).toBe(
      "This encounter changed since you opened it — reload to retry.",
    );
  });

  it("says plainly that a 403 is a permission", () => {
    expect(refusal({ status: 403, code: "FORBIDDEN" })).toBe(
      "You do not have permission for this action.",
    );
  });

  it("falls back to a general sentence for any other code", () => {
    expect(refusal({ status: 500, code: "SOMETHING_ELSE" })).toBe(
      "The action could not be completed.",
    );
  });
});
