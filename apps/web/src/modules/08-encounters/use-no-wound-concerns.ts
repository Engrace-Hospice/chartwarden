// apps/web/src/modules/08-encounters — the composer's side of the wound panel's "No skin or wound concerns at this visit" statement.
//
// The statement is one fixed sentence in the Skin and Wounds section's free text, so it goes through the same draft as typing in the notes
// box: the rail, the unsaved-changes check, the save and the server-assembled preview all follow with nothing new. This reads the text for
// the sentence and applies the panel's two changes. Adding reuses the helper the Plan and Next Visit panel adds its fixed lines with, which
// places the line below what the clinician wrote and never repeats it.
import { type Dispatch, type SetStateAction, useCallback } from "react";
import {
  NO_WOUND_CONCERNS_SENTENCE,
  type NoWoundConcernsChange,
  type NoWoundConcernsState,
  noWoundConcernsState,
  withoutNoWoundConcerns,
} from "../09-assessments";
import type { DraftSections, TemplateSection } from "./encounters-api";
import { appendToFreeText } from "./next-visit/plan-entry-text";

export function useNoWoundConcerns(
  sections: readonly TemplateSection[] | undefined,
  draft: DraftSections,
  setDraft: Dispatch<SetStateAction<DraftSections>>,
): {
  readonly noConcernsState: NoWoundConcernsState;
  /** Stable across keystrokes, so the memoised recorded panels are not re-rendered by typing. */
  readonly onNoConcernsChange: (change: NoWoundConcernsChange) => void;
} {
  // A template without the wounds section (a telephonic note) never shows the panel: nothing to read and nothing to change.
  const sectionId = sections?.find((section) => section.recordedPanel === "wounds")?.sectionId;
  const noConcernsState = noWoundConcernsState(
    sectionId === undefined ? "" : (draft[sectionId]?.freeText ?? ""),
  );
  const onNoConcernsChange = useCallback(
    (change: NoWoundConcernsChange): void => {
      if (sectionId === undefined) return;
      setDraft((prev) => {
        const held = prev[sectionId]?.freeText ?? "";
        const freeText =
          change === "state"
            ? appendToFreeText(held, NO_WOUND_CONCERNS_SENTENCE)
            : withoutNoWoundConcerns(held);
        if (freeText === held) return prev;
        return { ...prev, [sectionId]: { entries: prev[sectionId]?.entries ?? [], freeText } };
      });
    },
    [sectionId, setDraft],
  );
  return { noConcernsState, onNoConcernsChange };
}
