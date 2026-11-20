// apps/web/src/modules/08-encounters/review — the composer's progress wording, relabelled so it says what the author has DONE ("entered"),
// never what the server will accept ("documented", "complete", "ready"). The composer's own count knows only the template's required
// sections and half-filled statements; it cannot see required vitals, required scales, the care-plan review or the drafted sections the
// gate also decides, so a green "complete" would be a false claim. Pure.

/** A section's label in the composer's section list and in the review summary. */
export function sectionEntryLabel(section: {
  readonly hasEntry: boolean;
  readonly needsDetails: boolean;
  readonly required: boolean;
}): "Entered" | "Needs details" | "Required, no entry" | "No entry" {
  if (section.needsDetails) return "Needs details";
  if (section.hasEntry) return "Entered";
  return section.required ? "Required, no entry" : "No entry";
}

export function entryProgressTitle(entered: number, total: number): string {
  return `${entered} of ${total} ${total === 1 ? "section has" : "sections have"} an entry`;
}

export const ENTRY_PROGRESS_EYEBROW = "Entry progress";
export const REQUIRED_NO_ENTRY_LABEL = "required with no entry";

export function attentionTitle(count: number): string {
  return `${count} ${count === 1 ? "section needs" : "sections need"} attention`;
}

export function attentionText(headings: readonly string[]): string {
  return `Add an entry or finish the details in ${headings.join(", ")}. The server runs its own checks when you finalize and may name more to fix.`;
}

/** The card shown when every required section has an entry: it says so about entries only, and that the server still decides. */
export const ENTERED_CARD = {
  title: "Every required section has an entry",
  text: "This counts only what you have entered. When you finalize, the server also checks vitals, scales and the care-plan review where they apply, and decides whether the note can be finalized.",
} as const;
