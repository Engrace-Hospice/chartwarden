// ADR-0058 design review condition 12 (F5) - the tenant notice a workspace admin must acknowledge before global search is
// switched ON. ONE place: the settings GET returns this version and text for the UI to show, and the enable PUT must send the
// same version back. Change the text => bump NOTICE_VERSION, so every earlier acknowledgement goes stale.
export const NOTICE_VERSION = "2026-10-13.1";

export const NOTICE_TEXT =
  "Turning on global search makes the whole message history of this organisation discoverable by content, not only new " +
  "messages: every message that a member may already read, past and future, becomes findable by a word inside it. Search " +
  "never shows a message the searcher cannot read, but a person with search access can more quickly find content in the " +
  "channels they belong to, and every search is audited. Message content is not logged. By switching search on you confirm " +
  "that you have informed your workforce members and that this fits your organisation's privacy and retention policy.";

export interface GlobalSearchNotice {
  readonly version: string;
  readonly text: string;
}

export const CURRENT_NOTICE: GlobalSearchNotice = { version: NOTICE_VERSION, text: NOTICE_TEXT };
