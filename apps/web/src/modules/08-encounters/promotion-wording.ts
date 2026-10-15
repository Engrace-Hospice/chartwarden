// M8 WP 3.7 - the words of the "Proposed from a secure message" section. PROVISIONAL pending clinical-lead review.
import type { PromotionRejectReason } from "./addenda-api";

export const SECTION_TITLE = "Proposed from a secure message";
export const SECTION_NOTICE =
  "A colleague suggested this message may belong in the chart. It is shown here for your review only. Nothing enters the record until you write and sign your own addendum.";
export const SNAPSHOT_LABEL = "Message as proposed (read-only)";
export const EDITED_SINCE_WARNING =
  "The sender edited this message after it was proposed. The text above is the version that was proposed.";
export const NO_TEXT_AVAILABLE = "The message text is not available to show here.";
export const LOAD_FAILED = "Proposed messages could not be loaded.";
export const NOT_AVAILABLE = "This proposal is no longer available.";
export const CREATE_CONFLICT =
  "The addendum could not be created; it may already exist. Refresh and try again.";
export const DRAFT_CREATED = "Draft addendum created from the proposal.";
export const DECLINED = "Proposal declined.";
export const REASON_LABEL = "Why is this addendum needed? (your own words, at least 20 characters)";
export const REASON_TOO_SHORT = "Write at least 20 characters in your own words.";
export const GENERIC_FAILURE = "That did not work. Nothing was changed. Try again.";
export const PROPOSER_TEXT = "A care-team member";
export const MIN_REASON_LENGTH = 20;

export const REJECT_LABELS: Readonly<Record<PromotionRejectReason, string>> = {
  not_clinically_relevant: "Not clinically relevant",
  already_documented: "Already documented",
  duplicate: "Duplicate",
  wrong_patient: "Wrong patient",
  other: "Other",
};
