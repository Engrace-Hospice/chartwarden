// apps/web/src/modules/08-encounters/review — WF09 WP3: the review panel, the blocker panel and the pure models behind them.
export { BlockerPanel } from "./blocker-panel";
export type { BlockerPanelProps } from "./blocker-panel";
export { GATE_REGISTER, checksInGroup } from "./gate-register";
export type { CheckGroup, CheckKind, GateCheckId, RegisterCheck } from "./gate-register";
export {
  LateEntryReasonField,
  focusLateEntryReason,
  lateEntryReasonToSend,
} from "./late-entry-reason-field";
export type { HeadingOf, NoteTarget, ScaleKey, VitalKey } from "./note-target";
export { VISIT_REASON_SECTION_ID } from "./note-target";
export { panelAttemptFor } from "./panel-attempt";
export {
  ENTERED_CARD,
  ENTRY_PROGRESS_EYEBROW,
  REQUIRED_NO_ENTRY_LABEL,
  attentionText,
  attentionTitle,
  entryProgressTitle,
  sectionEntryLabel,
} from "./progress-wording";
export {
  asksForLateEntryReason,
  connectionLostAttempt,
  panelWordsRefusal,
  parseRefusal,
  refusalMovedStatus,
  refusedAttempt,
  remedyFor,
  responseRefusal,
} from "./refusal-model";
export type { Blocker, GateAttempt, Moment, Refusal } from "./refusal-model";
export {
  FOCUS_PARAM,
  composeHrefFor,
  externalPathFor,
  parseFocusParam,
  recordRemedyLabel,
} from "./remedy-route";
export { ReviewPanel } from "./review-panel";
export type { ReviewPanelProps } from "./review-panel";
export { buildNoteSummary } from "./review-summary";
export type { NoteSummary, SummaryInput } from "./review-summary";
export { useAnchorFocus } from "./use-anchor-focus";
export { useLatestCallback } from "./use-latest-callback";
export { useStableValue } from "./use-stable-value";
