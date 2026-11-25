// apps/web/src/modules/08-encounters/compose — what the composer tells the author about the note as a whole, above the workspace: the
// documentation progress bar, the save-state line, the save/finalize notice, the "preview not refreshed" notice, and the
// required-documentation card (moved out of encounter-compose.tsx unchanged).
import { Button } from "@chartwarden/ui";
import type { JSX } from "react";
import type { UiFeedback } from "../compose-feedback";
import {
  attentionCard,
  attentionMark,
  attentionText,
  attentionTitle,
  completionPercent,
  eyebrow,
  noticeBox,
  noticeError,
  noticeSuccess,
  noticeTitle,
  progressFill,
  progressTrack,
  readyCard,
  readyMark,
  readyText,
  readyTitle,
  summaryBar,
  summaryDivider,
  summaryMain,
  summaryStat,
  summaryStatLabel,
  summaryStatValue,
  summaryStats,
  summaryTitle,
  summaryTitleRow,
} from "../encounter-compose-styles";
import { LATE_ENTRY_READY_TEXT } from "../late-entry-reason";
import type { ComposeCompletion, ComposeOperation } from "./compose-model";

export interface ComposeProgressSummaryProps {
  readonly completion: ComposeCompletion;
  /** The statements selected in the open section, plus one when it has free text. */
  readonly itemsInCurrentSection: number;
}

export function ComposeProgressSummary({
  completion,
  itemsInCurrentSection,
}: ComposeProgressSummaryProps): JSX.Element {
  return (
    <section
      className="wx-encounter-compose-summary"
      style={summaryBar}
      aria-label="Visit note progress"
    >
      <div style={summaryMain}>
        <div style={summaryTitleRow}>
          <div>
            <div style={eyebrow}>Documentation progress</div>
            <div style={summaryTitle}>
              {completion.completed} of {completion.total} sections documented
            </div>
          </div>

          <strong style={completionPercent}>{completion.percent}%</strong>
        </div>

        <div style={progressTrack} aria-hidden>
          <span
            style={{
              ...progressFill,
              width: `${completion.percent}%`,
            }}
          />
        </div>
      </div>

      <div className="wx-encounter-compose-summary-stats" style={summaryStats}>
        <div className="wx-encounter-compose-summary-stat" style={summaryStat}>
          <span style={summaryStatValue}>{completion.requiredRemaining}</span>
          <span style={summaryStatLabel}>required remaining</span>
        </div>

        <div style={summaryDivider} />

        <div className="wx-encounter-compose-summary-stat" style={summaryStat}>
          <span style={summaryStatValue}>{itemsInCurrentSection}</span>
          <span style={summaryStatLabel}>items in current section</span>
        </div>
      </div>
    </section>
  );
}

export interface SaveStateLineProps {
  readonly operation: ComposeOperation | null;
  readonly savingPanelCount: number;
  readonly selectionsDirty: boolean;
  readonly panelsDirty: boolean;
  /** A late-entry reason is typed that no save has sent (only Finalize sends it): "All changes saved" would say too much. */
  readonly lateReasonUnsent?: boolean;
}

export function SaveStateLine({
  operation,
  savingPanelCount,
  selectionsDirty,
  panelsDirty,
  lateReasonUnsent = false,
}: SaveStateLineProps): JSX.Element {
  return (
    <output className="wx-encounter-save-state" aria-live="polite">
      {operation === "saving"
        ? "Saving changes…"
        : operation === "finalizing"
          ? "Saving and finalizing…"
          : savingPanelCount > 0
            ? "Saving a section…"
            : selectionsDirty
              ? "Unsaved changes"
              : panelsDirty
                ? "Unsaved entries in a section. Use that section's own Save button."
                : lateReasonUnsent
                  ? "Late-entry reason not sent yet"
                  : "All changes saved"}
    </output>
  );
}

export interface FeedbackNoticeProps {
  readonly feedback: UiFeedback | null;
  readonly onOpenCarePlan: () => void;
}

export function FeedbackNotice({
  feedback,
  onOpenCarePlan,
}: FeedbackNoticeProps): JSX.Element | null {
  if (!feedback) return null;
  return (
    <output
      style={{
        ...noticeBox,
        ...(feedback.tone === "success" ? noticeSuccess : noticeError),
      }}
    >
      {feedback.title === "" ? null : <strong style={noticeTitle}>{feedback.title}</strong>}
      <span>{feedback.message}</span>
      {feedback.field === "carePlan" ? (
        <Button tone="tertiary" onClick={onOpenCarePlan}>
          Open care plan
        </Button>
      ) : null}
    </output>
  );
}

export function PreviewStaleNotice({ stale }: { readonly stale: boolean }): JSX.Element | null {
  if (!stale) return null;
  return (
    <output style={{ ...noticeBox, ...noticeError }}>
      <strong style={noticeTitle}>Note preview not refreshed</strong>
      <span>
        Your change was saved, but the note could not be read again, so the preview may be out of
        date. Use Save &amp; refresh preview to read it.
      </span>
    </output>
  );
}

export interface RequiredDocumentationCardProps {
  /** The headings of the sections that still need attention before finalization. */
  readonly unmet: readonly string[];
  readonly lateEntryPending: boolean;
}

export function RequiredDocumentationCard({
  unmet,
  lateEntryPending,
}: RequiredDocumentationCardProps): JSX.Element {
  if (unmet.length > 0) {
    return (
      <section style={attentionCard} aria-label="Required documentation">
        <div style={attentionMark} aria-hidden>
          !
        </div>

        <div style={{ minWidth: 0 }}>
          <strong style={attentionTitle}>
            {unmet.length} {unmet.length === 1 ? "section needs" : "sections need"} attention
          </strong>
          <p style={attentionText}>
            Complete {unmet.join(", ")} before finalization. The server still performs the
            authoritative finalization check.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section style={readyCard}>
      <span style={readyMark} aria-hidden>
        ✓
      </span>
      <div>
        <strong style={readyTitle}>Required documentation is complete</strong>
        <p style={readyText}>
          {lateEntryPending
            ? LATE_ENTRY_READY_TEXT
            : "You can still review the assembled note before finalizing."}
        </p>
      </div>
    </section>
  );
}
