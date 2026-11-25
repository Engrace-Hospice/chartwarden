// apps/web/src/modules/08-encounters/compose — the edits the composer makes to the author's working draft: tick or untick a statement, pick
// one of a single-choice section, fill a statement's detail, type or append free text (moved out of encounter-compose.tsx unchanged).
// Not a hook: called each render, like the closures it replaces, so each edit sees the template and draft of the render that made it.
import type { Dispatch, SetStateAction } from "react";
import type { DraftSections, MenuEntry, TemplateSection, TemplateView } from "../encounters-api";
import { appendToFreeText } from "../next-visit/plan-entry-text";

export interface DraftEditors {
  readonly toggleEntry: (sectionId: string, entry: MenuEntry) => void;
  readonly chooseOne: (section: TemplateSection, code: string) => void;
  readonly setSlot: (sectionId: string, code: string, slot: string, value: string) => void;
  readonly setFreeText: (sectionId: string, value: string) => void;
  readonly addToFreeText: (sectionId: string, text: string) => void;
}

export function createDraftEditors(
  template: TemplateView | null,
  draft: DraftSections,
  setDraft: Dispatch<SetStateAction<DraftSections>>,
): DraftEditors {
  function toggleEntry(sectionId: string, entry: MenuEntry): void {
    // Statements sharing an exclusive group contradict each other and the server refuses two in one note,
    // so picking one replaces its sibling wherever in the note that sibling was recorded.
    const rivals = new Set(
      entry.exclusiveGroup === null
        ? []
        : (template?.sections ?? []).flatMap((s) =>
            s.entries
              .filter((e) => e.exclusiveGroup === entry.exclusiveGroup && e.code !== entry.code)
              .map((e) => e.code),
          ),
    );

    setDraft((prev) => {
      const current = prev[sectionId] ?? { entries: [], freeText: "" };
      if (current.entries.some((e) => e.code === entry.code)) {
        return {
          ...prev,
          [sectionId]: {
            ...current,
            entries: current.entries.filter((e) => e.code !== entry.code),
          },
        };
      }

      const cleared: DraftSections = Object.fromEntries(
        Object.entries(prev).map(([id, section]) => [
          id,
          { ...section, entries: section.entries.filter((e) => !rivals.has(e.code)) },
        ]),
      );
      const base = cleared[sectionId] ?? current;
      return {
        ...cleared,
        [sectionId]: { ...base, entries: [...base.entries, { code: entry.code, params: {} }] },
      };
    });
  }

  /** A single-choice section's select: pick one (replacing any other) or `""` to clear it. */
  function chooseOne(section: TemplateSection, code: string): void {
    const held = draft[section.sectionId]?.entries[0]?.code;
    if (code === held) return;
    // toggleEntry swaps a rival out and unticks a held one, which is exactly pick-and-clear.
    const entry = section.entries.find((e) => e.code === (code === "" ? held : code));
    if (entry !== undefined) toggleEntry(section.sectionId, entry);
  }

  function setSlot(sectionId: string, code: string, slot: string, value: string): void {
    setDraft((prev) => {
      const current = prev[sectionId] ?? { entries: [], freeText: "" };

      return {
        ...prev,
        [sectionId]: {
          ...current,
          entries: current.entries.map((e) =>
            e.code === code ? { ...e, params: { ...e.params, [slot]: value } } : e,
          ),
        },
      };
    });
  }

  function setFreeText(sectionId: string, value: string): void {
    setDraft((prev) => ({
      ...prev,
      [sectionId]: {
        entries: prev[sectionId]?.entries ?? [],
        freeText: value,
      },
    }));
  }

  /** Lines the author asked a section's panel to add: placed below what they already wrote, which is left as typed. */
  function addToFreeText(sectionId: string, text: string): void {
    setDraft((prev) => ({
      ...prev,
      [sectionId]: {
        entries: prev[sectionId]?.entries ?? [],
        freeText: appendToFreeText(prev[sectionId]?.freeText ?? "", text),
      },
    }));
  }

  return { toggleEntry, chooseOne, setSlot, setFreeText, addToFreeText };
}
