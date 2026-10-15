// M14 WP 3.7 - the words of the "Proposed from secure messages" section. PROVISIONAL pending clinical-lead review.
import type { PromotionRejectReason } from "./idg-api";

export const SECTION_TITLE = "Proposed from secure messages";
export const SECTION_NOTICE =
  "Care-team members suggested these patients for discussion. No message text is shown. Adding one puts a pointer on the agenda; it records no decision.";
export const LOAD_FAILED = "Proposed items could not be loaded.";
export const NOT_AVAILABLE = "This proposal is no longer available.";
export const GENERIC_FAILURE = "That did not work. Nothing was changed. Try again.";
export const PROPOSER_TEXT = "A care-team member";
export const ADDED_TEXT = "Added to the agenda.";
export const DECLINED_TEXT = "Proposal declined.";

export const REJECT_LABELS: Readonly<Record<PromotionRejectReason, string>> = {
  not_clinically_relevant: "Not clinically relevant",
  already_documented: "Already documented",
  duplicate: "Duplicate",
  wrong_patient: "Wrong patient",
  other: "Other",
};
