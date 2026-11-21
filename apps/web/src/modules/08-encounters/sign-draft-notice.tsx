// apps/web/src/modules/08-encounters — what the signer reads beside the Sign button when drafted sections of the note are still
// unresolved (ADR-0114 VN-D7): which ones, why, and the way to resolve them. The server decides whether the note may sign (409
// DRAFT_SECTION_STALE otherwise); this tells the signer first, so the button is not a dead end.
import { InlineAlert } from "@chartwarden/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import type { DraftSectionView } from "./draft-api";
import { STATE_LABEL } from "./draft-model";

/** The id the Sign button's `aria-describedby` points at. */
export const SIGN_DRAFT_NOTICE_ID = "sign-draft-notice";

/** Section ids whose words read wrong ("Pps", "F2f attestation"): the template's own headings for them. */
const SECTION_NAME: ReadonlyMap<string, string> = new Map([
  ["pps", "Palliative Performance Status"],
  ["esas", "Symptom Assessment (ESAS)"],
  ["recert_summary", "Recertification Summary"],
  ["f2f_attestation", "Face-to-Face Attestation"],
  // S2b (RN admission visit): the template's own headings
  ["med_reconciliation", "Medication Reconciliation"],
  ["advance_directive", "Advance Directive Acknowledgment"],
  ["caregiver_overview", "Caregiver Overview"],
  ["baseline_symptoms", "Baseline Symptoms"],
]);

/** The read page has no template, so a section reads as its id in words ("vitals_review" -> "Vitals review"). */
export function humanizeSection(sectionId: string): string {
  const named = SECTION_NAME.get(sectionId);
  if (named !== undefined) return named;
  const words = sectionId.replace(/_/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export interface SignDraftNoticeProps {
  readonly sections: readonly DraftSectionView[];
  /** The composer's route for this note, where a drafted section is confirmed or deselected. */
  readonly composePath: string;
}

export function SignDraftNotice({ sections, composePath }: SignDraftNoticeProps): JSX.Element {
  return (
    <section id={SIGN_DRAFT_NOTICE_ID} className="wx-draft-summary" aria-label="Drafted sections">
      <InlineAlert tone="warning" live={false}>
        {sections.length === 1
          ? "1 drafted section still needs your review before this note can be signed."
          : `${sections.length} drafted sections still need your review before this note can be signed.`}
      </InlineAlert>
      <ul className="wx-draft-todo">
        {sections.map((section) => (
          <li key={section.sectionId}>
            <span>{humanizeSection(section.sectionId)}</span>
            <span className="wx-row-sub">{STATE_LABEL[section.state]}</span>
          </li>
        ))}
      </ul>
      <Link to={composePath}>Review them in the note editor</Link>
    </section>
  );
}
