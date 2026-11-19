import type { DraftSectionView } from "./draft-api";
// apps/web/src/modules/08-encounters — the words and rules of amending a signed note through an addendum (ADR-0114 VN-D30, S1 PR E3).
// No I/O. The server decides every state and every refusal; this words them with the next step, and says which drafted sections hold the
// Sign button back (it tells the signer first, so the button is not a dead end; the server still judges the sign).
import {
  type DraftIssue,
  type DraftLoad,
  type SectionNote,
  describeIssues,
  draftIssuesFrom,
  needsReview,
} from "./draft-model";
import { humanizeSection } from "./sign-draft-notice";

/** The API's limit on sections named by one addendum. */
export const MAX_AMENDED_SECTIONS = 12;

const PART2_NOT_ENTITLED =
  "A section you chose holds 42 CFR Part 2 information that your access does not include, so it cannot be amended by you. Nothing was changed. Ask a colleague whose access includes it to amend that section; a free addendum can still add what you need.";

/**
 * What opening an amending addendum says when the server refuses it, or null for a refusal whose own words should show. A 404 is the
 * answer for a tenant with the visit-note draft off (the same answer as an absent note, so it is worded as the likelier cause).
 */
export function amendCreateRefusal(
  status: number | null | undefined,
  code: string | null | undefined,
): string | null {
  if (status === 404) {
    return "Sections of this note cannot be amended right now: the visit-note draft is switched off for your organization. Open a free addendum instead, or ask an administrator to switch the visit-note draft on (Admin, Visit-note Draft).";
  }
  if (code === "UNKNOWN_TEMPLATE_SECTION") {
    return "One of the sections you chose is not part of the signed note. Reload the page, choose the sections again, then open the addendum.";
  }
  if (code === "AMENDMENT_PART2_NOT_ENTITLED") return PART2_NOT_ENTITLED;
  return null;
}

export interface AddendumRefusal {
  readonly status: number | null | undefined;
  readonly code: string | null | undefined;
  /** The envelope's own text, shown verbatim for a code this feature gives no sentence of its own. */
  readonly message: string;
  readonly details?: unknown;
}

/** The sign refusals that mean "a named section is not resolved against the draft as it stands now": the draft is read again. */
export const isSectionRefusal = (code: string | null | undefined): boolean =>
  code === "DRAFT_SECTION_STALE" || code === "DRAFT_SECTION_UNRESOLVED";

/** What a refused addendum sign says (an amending addendum adds the draft's own refusals to the free addendum's). */
export function addendumRefusalMessage({ code, message, details }: AddendumRefusal): string {
  switch (code) {
    case "DRAFT_SECTION_UNRESOLVED":
    case "DRAFT_SECTION_STALE": {
      const issues = draftIssuesFrom(details);
      const named = issues.length > 0 ? `: ${describeIssues(issues, humanizeSection)}` : "";
      return `Some amended sections need another look before this addendum can be signed${named}. Review them above, then sign again.`;
    }
    case "DRAFT_OFF_AFTER_FINALIZE":
      return "The visit-note draft is switched off for your organization now, so the sections this addendum amends cannot be signed. Nothing was changed: the addendum is still waiting. Ask an administrator to switch the visit-note draft back on (Admin, Visit-note Draft), then sign again.";
    case "COMPLIANCE_GATE_UNAVAILABLE":
      return "The addendum could not be checked right now: a record it depends on did not answer. Nothing was changed. Try again in a moment.";
    case "NO_ELIGIBLE_COSIGNER":
      return "This note needed a cosigner, so its amendment does too, and no eligible cosigner was found (the patient's RN case manager cannot cosign their own amendment). Nothing was changed. Ask a supervisor to assign a case manager, then sign again.";
    case "AMENDMENT_PART2_NOT_ENTITLED":
      return PART2_NOT_ENTITLED;
    default:
      return message;
  }
}

const reasonOf = (section: DraftSectionView): DraftIssue => ({
  sectionId: section.sectionId,
  reason: section.state === "unresolved" ? "unresolved" : "stale",
});

/**
 * Why Sign waits for an amending addendum, or null when it need not. While the amended sections are being read, or could not be, it
 * waits (an unknown draft is not a resolved one); an unresolved or changed section is named. A draft this viewer cannot read ("off") is
 * left to the server, which answers the sign with its own refusal.
 */
export function signBlockReason(load: DraftLoad): string | null {
  switch (load.status) {
    case "loading":
      return "Checking the amended sections…";
    case "unavailable":
      return "Signing waits until the amended sections can be read.";
    case "off":
      return null;
    case "ready": {
      const waiting = load.draft.sections.filter(needsReview).map(reasonOf);
      return waiting.length === 0
        ? null
        : `Confirm or deselect the amended sections first: ${describeIssues(waiting, humanizeSection)}.`;
    }
  }
}

/** What a named section does when the addendum signs; null while it is still unresolved (it will block the sign). */
export function amendedSectionOutcome(state: DraftSectionView["state"]): string | null {
  switch (state) {
    case "confirmed":
      return "This section will be amended with the text you confirmed.";
    case "deselected":
      return "Deselected: this amends nothing, and the section stays as it was signed.";
    case "not_drafted":
      return "Nothing in the record to redraft this section from: this amends nothing, and the section stays as it was signed.";
    default:
      return null;
  }
}

/**
 * The line a resolved named section carries: what it will do at sign. Shown as the section's own status line, so it is announced when a
 * choice is made and is still there after a reload. Null for an unresolved or changed section, and for one with nothing drafted (the
 * section's own words cover that).
 */
export function amendedSectionNote(state: DraftSectionView["state"]): SectionNote | null {
  if (state !== "confirmed" && state !== "deselected") return null;
  const text = amendedSectionOutcome(state);
  return text === null ? null : { tone: state === "confirmed" ? "success" : "info", text };
}

/**
 * What the signer reads once an AMENDING addendum is signed: how many sections it changed and that a cosignature was requested. Null for a
 * free addendum (the sign response has neither field), whose sign says nothing more than it ever did.
 */
export function signedAmendmentMessage(signed: {
  readonly amendedSectionIds?: readonly string[];
  readonly cosignatureRequestId?: string | null;
}): string | null {
  if (signed.amendedSectionIds === undefined) return null;
  const count = signed.amendedSectionIds.length;
  const amended =
    count === 0
      ? "No section was amended."
      : `${count} ${count === 1 ? "section" : "sections"} amended.`;
  const cosign = signed.cosignatureRequestId
    ? " A cosignature was requested for this amendment."
    : "";
  return `Addendum signed. ${amended}${cosign}`;
}
