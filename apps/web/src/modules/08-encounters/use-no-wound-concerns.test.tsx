// @vitest-environment jsdom
// The composer's side of the wound panel's "No skin or wound concerns at this visit" statement: it reads the Skin and Wounds section's
// free text for the sentence and applies the panel's two changes to the draft, through the helper the Plan and Next Visit panel
// already uses to add a fixed line without repeating it. Synthetic text only.
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { NO_WOUND_CONCERNS_SENTENCE as SENTENCE } from "../09-assessments";
import type { DraftSections, TemplateSection } from "./encounters-api";
import { useNoWoundConcerns } from "./use-no-wound-concerns";

const section = (sectionId: string, recordedPanel: TemplateSection["recordedPanel"] = null) =>
  ({
    sectionId,
    heading: sectionId,
    required: false,
    allowedCategories: [],
    entries: [],
    recordedPanel,
  }) as unknown as TemplateSection;

const WITH_WOUNDS = [section("assessment"), section("skin_wounds", "wounds"), section("plan")];
const TELEPHONIC = [section("assessment"), section("plan")];

function mount(sections: readonly TemplateSection[], initial: DraftSections = {}) {
  return renderHook(() => {
    const [draft, setDraft] = useState<DraftSections>(initial);
    return { draft, setDraft, ...useNoWoundConcerns(sections, draft, setDraft) };
  });
}
const woundsText = (draft: DraftSections): string | undefined => draft.skin_wounds?.freeText;

describe("useNoWoundConcerns", () => {
  it("reads the wounds section's free text, and no other section's, for the sentence", () => {
    const { result } = mount(WITH_WOUNDS, {
      skin_wounds: { entries: [], freeText: `Skin warm.\n${SENTENCE}` },
    });
    expect(result.current.noConcernsState).toBe("stated");

    const other = mount(WITH_WOUNDS, { plan: { entries: [], freeText: SENTENCE } });
    expect(other.result.current.noConcernsState).toBe("absent");
  });

  it("adds the sentence below what the clinician typed, once however often it is asked", () => {
    const { result } = mount(WITH_WOUNDS, {
      skin_wounds: { entries: [], freeText: "Skin warm and dry." },
    });

    act(() => result.current.onNoConcernsChange("state"));
    act(() => result.current.onNoConcernsChange("state"));

    expect(woundsText(result.current.draft)).toBe(`Skin warm and dry.\n${SENTENCE}`);
    expect(result.current.noConcernsState).toBe("stated");
  });

  it("makes the section's draft when there was none, and leaves other sections alone", () => {
    const { result } = mount(WITH_WOUNDS, {
      plan: { entries: [], freeText: "Next visit Friday." },
    });

    act(() => result.current.onNoConcernsChange("state"));

    expect(result.current.draft).toEqual({
      plan: { entries: [], freeText: "Next visit Friday." },
      skin_wounds: { entries: [], freeText: SENTENCE },
    });
  });

  it("undoes exactly the sentence", () => {
    const { result } = mount(WITH_WOUNDS, {
      skin_wounds: { entries: [], freeText: "Skin warm and dry." },
    });
    act(() => result.current.onNoConcernsChange("state"));

    act(() => result.current.onNoConcernsChange("undo"));

    expect(woundsText(result.current.draft)).toBe("Skin warm and dry.");
    expect(result.current.noConcernsState).toBe("absent");
  });

  it("undoing twice is harmless", () => {
    const { result } = mount(WITH_WOUNDS, { skin_wounds: { entries: [], freeText: SENTENCE } });

    act(() => result.current.onNoConcernsChange("undo"));
    act(() => result.current.onNoConcernsChange("undo"));

    expect(woundsText(result.current.draft)).toBe("");
  });

  it("keeps one callback across keystrokes, so the memoised panels are not re-rendered by typing", () => {
    const { result } = mount(WITH_WOUNDS);
    const first = result.current.onNoConcernsChange;

    act(() =>
      result.current.setDraft({ skin_wounds: { entries: [], freeText: "Skin warm and dry." } }),
    );

    expect(result.current.onNoConcernsChange).toBe(first);
  });

  it("does nothing for a template with no wounds section", () => {
    const { result } = mount(TELEPHONIC, { plan: { entries: [], freeText: "Call back Friday." } });

    act(() => result.current.onNoConcernsChange("state"));

    expect(result.current.noConcernsState).toBe("absent");
    expect(result.current.draft).toEqual({
      plan: { entries: [], freeText: "Call back Friday." },
    });
  });
});
