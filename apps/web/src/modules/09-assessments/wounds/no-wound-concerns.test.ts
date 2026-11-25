// The one sentence the Wounds panel's "No skin or wound concerns at this visit" button adds to the section's free text: how the
// note's text is read for it, and how exactly that sentence (and nothing the clinician typed) is taken out again. Synthetic text only.
import { describe, expect, it } from "vitest";
import {
  NO_WOUND_CONCERNS_SENTENCE as SENTENCE,
  noWoundConcernsState,
  withoutNoWoundConcerns,
} from "./no-wound-concerns";

describe("noWoundConcernsState", () => {
  it("is absent for empty text and for text that says nothing of the kind", () => {
    expect(noWoundConcernsState("")).toBe("absent");
    expect(noWoundConcernsState("Dressing supplies restocked.")).toBe("absent");
  });

  it("is stated when the exact sentence is anywhere in the text", () => {
    expect(noWoundConcernsState(SENTENCE)).toBe("stated");
    expect(noWoundConcernsState(`Skin warm and dry.\n${SENTENCE}\nFamily at bedside.`)).toBe(
      "stated",
    );
  });

  it("is reworded when the sentence was edited so it no longer matches, whatever the case or spacing", () => {
    expect(
      noWoundConcernsState(
        "No skin breakdown or wounds were identified at this visit, except heel",
      ),
    ).toBe("reworded");
    expect(noWoundConcernsState("no  skin breakdown\nor wounds seen")).toBe("reworded");
  });
});

describe("withoutNoWoundConcerns", () => {
  it("empties text that is only the sentence", () => {
    expect(withoutNoWoundConcerns(SENTENCE)).toBe("");
  });

  it("takes out the sentence and the line break it was added with, leaving the earlier words as typed", () => {
    expect(withoutNoWoundConcerns(`Skin warm and dry.\n${SENTENCE}`)).toBe("Skin warm and dry.");
    expect(withoutNoWoundConcerns(`${SENTENCE}\nSkin warm and dry.`)).toBe("Skin warm and dry.");
  });

  it("closes the gap when the clinician kept typing after the sentence", () => {
    expect(withoutNoWoundConcerns(`Skin warm.\n${SENTENCE}\nFamily at bedside.`)).toBe(
      "Skin warm.\nFamily at bedside.",
    );
  });

  it("does not leave a stray space when the clinician kept typing on the sentence's own line", () => {
    expect(withoutNoWoundConcerns(`Skin warm.\n${SENTENCE} Family at bedside.`)).toBe(
      "Skin warm.\nFamily at bedside.",
    );
  });

  it("takes out the sentence from the middle of a line without doubling the space", () => {
    expect(withoutNoWoundConcerns(`Skin warm. ${SENTENCE} Heels checked.`)).toBe(
      "Skin warm. Heels checked.",
    );
  });

  it("takes out every copy of the sentence", () => {
    expect(withoutNoWoundConcerns(`${SENTENCE}\nSkin warm.\n${SENTENCE}`)).toBe("Skin warm.");
  });

  it("leaves text without the exact sentence untouched, including a reworded one", () => {
    const reworded = "No skin breakdown or wounds were identified at this visit, except heel";
    expect(withoutNoWoundConcerns(reworded)).toBe(reworded);
    expect(withoutNoWoundConcerns("Skin warm.")).toBe("Skin warm.");
  });
});
