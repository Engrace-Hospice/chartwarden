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
import type { DraftSections } from "./encounters-api";
import { humanizeSection } from "./sign-draft-notice";
import { shortStamp } from "./signed-note-model";

/**
 * What names one addendum among its siblings, in a landmark's name and a section's heading: its place in the list, then when it was opened.
 * The date alone is not enough (two opened in the same minute read the same), and neither is the place alone (it moves when one is added).
 */
export function addendumName(position: number, total: number, createdAt: string): string {
  return `addendum ${position} of ${total}, opened ${shortStamp(createdAt)}`;
}

/** The API's limit on sections named by one addendum. */
export const MAX_AMENDED_SECTIONS = 12;

// The server answers this code for ANY named section whenever the note holds Part 2 text the signer cannot be told of, whatever the section
// (the answer does not depend on it). The sentence therefore says nothing about a section, nor about what the note holds: it is keyed on the
// code alone, and a viewer without disclosure learns nothing from it.
const SECTIONS_NOT_CHOOSABLE =
  "You cannot choose sections to amend on this note. Nothing was changed. Add an addendum without choosing sections, or ask the note's author.";

/**
 * The role keys the server treats as a supervisor (`SUPERVISOR_ROLE_KEYS` of 08-encounters, the same set as the note-closure grants).
 * A copy: the web may not import the backend's, and a test pins it to the platform's own constant.
 */
export const SUPERVISOR_ROLE_KEYS = [
  "clinical_supervisor",
  "director_of_nursing",
  "don",
  "clinical_lead",
] as const;

/**
 * Whether the viewer may choose the sections an addendum amends: only the signed note's author or a supervisor may (403 otherwise, before
 * anything is written). False only when the session positively shows the viewer is neither; a session that cannot say who the viewer is
 * (no membership or no roles, or the note's author not known) leaves it to the server, whose refusal is worded (`amendCreateRefusal`).
 */
export function mayNameSections(
  viewer: { readonly membershipId?: string; readonly roles?: readonly string[] } | null,
  noteAuthorMembershipId: string | null | undefined,
): boolean {
  const membershipId = viewer?.membershipId;
  const roles = viewer?.roles;
  if (membershipId === undefined || roles === undefined || !noteAuthorMembershipId) return true;
  return (
    membershipId === noteAuthorMembershipId ||
    roles.some((role) => (SUPERVISOR_ROLE_KEYS as readonly string[]).includes(role))
  );
}

/**
 * What opening an amending addendum says when the server refuses it, or null for a refusal whose own words should show. A 404 is the
 * answer for a tenant with the visit-note draft off (the same answer as an absent note, so it is worded as the likelier cause). A 403
 * FORBIDDEN is the rule that only the note's author or a supervisor may choose sections (any other 403, a step-up or a note-closure block,
 * has its own code and its own words).
 */
export function amendCreateRefusal(
  status: number | null | undefined,
  code: string | null | undefined,
): string | null {
  if (status === 403 && code === "FORBIDDEN") {
    return "Only the author of this note or a supervisor can choose sections to amend. Nothing was changed. Open the addendum without choosing sections, or ask the author or a supervisor to amend them.";
  }
  if (status === 404) {
    return "Sections of this note cannot be amended right now: the visit-note draft is switched off for your organization. Open a free addendum instead, or ask an administrator to switch the visit-note draft on (Admin, Visit-note Draft).";
  }
  if (code === "UNKNOWN_TEMPLATE_SECTION") {
    return "One of the sections you chose is not part of the signed note. Reload the page, choose the sections again, then open the addendum.";
  }
  if (code === "AMENDMENT_PART2_NOT_ENTITLED") return SECTIONS_NOT_CHOOSABLE;
  return null;
}

export interface AddendumRefusal {
  readonly status: number | null | undefined;
  readonly code: string | null | undefined;
  /** The envelope's own text, shown verbatim for a code this feature gives no sentence of its own. */
  readonly message: string;
  readonly details?: unknown;
  /** Which step of the addendum was refused, when the caller knows: the words of a refused compliance gate say what to do next at that step. */
  readonly step?: "finalize" | "sign";
  /** Whether the addendum names sections of the note to amend: a free addendum is never told about sections. Absent reads as free. */
  readonly amends?: boolean;
}

/** The sign refusals that mean "a named section is not resolved against the draft as it stands now": the draft is read again. */
export const isSectionRefusal = (code: string | null | undefined): boolean =>
  code === "DRAFT_SECTION_STALE" || code === "DRAFT_SECTION_UNRESOLVED";

// An addendum is judged by one rule only: it must have something in it (a finding, a note, or a confirmed amended section). The note's own
// required sections are not its business, and the server's top-level sentence for a refused gate names the ENCOUNTER, so it is never shown. A
// free addendum can only hold a finding or a note; one that amends is also told about a redrafted section, "if one is offered" (a section
// whose sources are gone has none to confirm, and at sign nothing can be added any more).
const ADDENDUM_EMPTY_WORDS = {
  finalize: {
    free: "This addendum has nothing in it yet. Add a finding or a note, then finalize it.",
    amending:
      "This addendum has nothing in it yet. Add a finding or a note, or confirm a redrafted section if one is offered, then finalize it.",
  },
  sign: {
    free: "This addendum has nothing in it, so it cannot be signed. Open a new addendum with a finding or a note.",
    amending:
      "This addendum has nothing in it now: no section is left to amend, and it has no finding or note. Confirm a redrafted section if one is offered, then sign it. If none is, open a new addendum with a finding or a note.",
  },
} as const;
const GATE_REFUSED_UNSPECIFIED =
  "This addendum did not pass the compliance check. Nothing was changed. Review it, then try again.";

/** The remediation a refused gate lists (`{ code, message }` each), with anything that is not that shape left out. */
function gateRemediationOf(details: unknown): readonly { code: string; message: string }[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((detail): { code: string; message: string }[] =>
    detail !== null &&
    typeof detail === "object" &&
    typeof (detail as { code?: unknown }).code === "string" &&
    typeof (detail as { message?: unknown }).message === "string"
      ? [
          {
            code: (detail as { code: string }).code,
            message: (detail as { message: string }).message,
          },
        ]
      : [],
  );
}

/** What a refused compliance gate says: the app's words for a remediation it knows, else the server's own detail, never the top-level sentence. */
function gateRefusalMessage(
  details: unknown,
  step: AddendumRefusal["step"],
  amends: boolean,
): string {
  const remediation = gateRemediationOf(details);
  if (remediation.some((r) => r.code === "ADDENDUM_EMPTY")) {
    return ADDENDUM_EMPTY_WORDS[step === "sign" ? "sign" : "finalize"][
      amends ? "amending" : "free"
    ];
  }
  return remediation.length > 0
    ? remediation.map((r) => r.message).join(" ")
    : GATE_REFUSED_UNSPECIFIED;
}

/** What a refused addendum step says (an amending addendum adds the draft's own refusals to the free addendum's). */
export function addendumRefusalMessage({
  code,
  message,
  details,
  step,
  amends = false,
}: AddendumRefusal): string {
  switch (code) {
    case "COMPLIANCE_GATE_FAILED":
      return gateRefusalMessage(details, step, amends);
    case "DRAFT_SECTION_UNRESOLVED":
    case "DRAFT_SECTION_STALE": {
      const issues = draftIssuesFrom(details);
      const named = issues.length > 0 ? `: ${describeIssues(issues, humanizeSection)}` : "";
      return `Some amended sections need another look before this addendum can be signed${named}. Review them above, then sign again.`;
    }
    case "DRAFT_OFF_AFTER_FINALIZE":
      return step === "finalize"
        ? "The visit-note draft is switched off for your organization now, so the sections this addendum amends cannot be confirmed. Nothing was changed: the addendum is still a draft. Ask an administrator to switch the visit-note draft back on (Admin, Visit-note Draft), then finalize again."
        : "The visit-note draft is switched off for your organization now, so the sections this addendum amends cannot be signed. Nothing was changed: the addendum is still waiting. Ask an administrator to switch the visit-note draft back on (Admin, Visit-note Draft), then sign again.";
    case "COMPLIANCE_GATE_UNAVAILABLE":
      return "The addendum could not be checked right now: a record it depends on did not answer. Nothing was changed. Try again in a moment.";
    case "NO_ELIGIBLE_COSIGNER":
      return "This note needed a cosigner, so its amendment does too, and no eligible cosigner was found: the patient's RN case manager cannot cosign a note or an amendment they wrote themselves. Nothing was changed. Ask a supervisor to assign an RN case manager who wrote neither the note nor this amendment, then sign again.";
    case "AMENDMENT_PART2_NOT_ENTITLED":
      return SECTIONS_NOT_CHOOSABLE;
    case "STEP_UP_AUTH_REQUIRED":
      return "Signing needs a fresh re-authentication, and yours is out of date. Nothing was changed: the addendum is still waiting. Re-authenticate, then sign again.";
    default:
      return message;
  }
}

/**
 * What the addendum editor says is still missing before Finalize, or null when nothing is: the addendum's one rule (it must have something in
 * it), not the note's required sections. `amendment` is null for a free addendum; for an amending one it is how many of its named sections
 * the author has confirmed (null while its own draft has not been read: an unknown count is not an empty one, so nothing is said). A hint:
 * the server judges (`ADDENDUM_EMPTY`).
 */
export function addendumContentHint(
  draft: DraftSections,
  amendment: { readonly confirmed: number | null } | null,
): string | null {
  const written = Object.values(draft).some(
    (section) => section.entries.length > 0 || section.freeText.trim().length > 0,
  );
  if (written) return null;
  if (amendment === null) return "Nothing here yet. Before finalizing, add a finding or a note.";
  if (amendment.confirmed === null || amendment.confirmed > 0) return null;
  return "Nothing here yet. Before finalizing, add a finding or a note, or confirm a redrafted section if one is offered.";
}

const reasonOf = (section: DraftSectionView): DraftIssue => ({
  sectionId: section.sectionId,
  reason: section.state === "unresolved" ? "unresolved" : "stale",
});

/**
 * Why Sign waits for an amending addendum, or null when it need not. While the amended sections are being read, or could not be, it
 * waits (an unknown draft is not a resolved one); an unresolved or changed section is named. A draft this viewer cannot read ("off") is
 * left to the server, which answers the sign with its own refusal; one that is the author's alone ("notAuthor") holds Sign back, for the
 * author alone may sign.
 */
export function signBlockReason(load: DraftLoad): string | null {
  switch (load.status) {
    case "loading":
      return "Checking the amended sections…";
    case "unavailable":
      return "Signing waits until the amended sections can be read.";
    case "off":
      return null;
    case "notAuthor":
      return "Only the author of this addendum can review its sections and sign it.";
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
