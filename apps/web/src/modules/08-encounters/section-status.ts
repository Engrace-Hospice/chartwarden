// What the composer tells the author about ONE note section: the rail's state word, the header chip and the free-text hint. They are
// derived here, from the same three facts, so the places that describe a section cannot disagree with each other. Advice only: the
// server's gate (check 1 and the empty-detail refusal at finalize) decides, and `section.required` is the flag it reads.

export type SectionState = "Documented" | "Needs details" | "Required" | "Not started";

export interface SectionFacts {
  /** The template flag finalize reads: the note cannot be finalized with this section empty. */
  readonly required: boolean;
  /** The author's own statements or notes, a drafted text they confirmed, or a saved record documents the section. */
  readonly populated: boolean;
  /** A selected statement still has an empty detail: finalize refuses the note until it is filled in or the statement is removed. */
  readonly needsDetails: boolean;
}

/** The rail's word for the section: where it stands, not whether it may be skipped. */
export function sectionState({ required, populated, needsDetails }: SectionFacts): SectionState {
  if (needsDetails) return "Needs details";
  if (populated) return "Documented";
  return required ? "Required" : "Not started";
}

export interface SectionChip {
  readonly label: "Required" | "Optional" | "Needs details";
  /** The label names something that stops finalize (so it is drawn as a warning), rather than a section that may be skipped. */
  readonly blocksFinalize: boolean;
}

/**
 * The chip beside the section's heading. `Optional` is only said of a section that cannot stop finalize: an optional section holding
 * a half-filled statement does, so it says what stops it.
 */
export function sectionChip({ required, needsDetails }: SectionFacts): SectionChip {
  if (required) return { label: "Required", blocksFinalize: true };
  if (needsDetails) return { label: "Needs details", blocksFinalize: true };
  return { label: "Optional", blocksFinalize: false };
}

export interface FreeTextFacts extends SectionFacts {
  /** The section offers preset statements. */
  readonly hasStatements: boolean;
  /** A saved record (ADLs, nutrition, a wound assessed at this visit) states the section. */
  readonly documentedByRecord: boolean;
}

const STATEMENTS_NOTE =
  "Optional. Enter only information not already represented by the selected statements.";

/** The line under "Additional clinical notes": whether writing there is how the section gets documented, or an extra. */
export function notesHint(facts: FreeTextFacts): string {
  if (facts.hasStatements) {
    return facts.required && !facts.populated
      ? "Required. Select a statement above, or write this section here in your own words."
      : STATEMENTS_NOTE;
  }
  if (facts.documentedByRecord) {
    return "Optional. The saved record above documents this section; add notes only for what it does not cover.";
  }
  return facts.required
    ? "Required. This section has no preset statements; document it here in your own words."
    : "Optional. Leave it empty if there is nothing to record.";
}
