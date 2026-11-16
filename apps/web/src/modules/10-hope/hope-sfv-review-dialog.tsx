// apps/web/src/modules/10-hope — the read-only look at a completed Symptom Follow-Up Visit: the date it was completed and
// what was answered. On the kit Modal, like the completion dialog it mirrors: focus in, Tab trapped, Escape closes.
import { Modal, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import {
  secondaryButton,
  sfvAnswerCard,
  sfvAnswerCardHeader,
  sfvAnswerNumber,
  sfvAnswersGrid,
  sfvCloseButton,
  sfvDetailsGrid,
  sfvDialogFrame,
  sfvField,
  sfvFieldLabel,
  sfvFooterActions,
  sfvModalBody,
  sfvModalDescription,
  sfvModalEyebrow,
  sfvModalFooter,
  sfvModalHeader,
  sfvModalHeaderText,
  sfvModalTitle,
  sfvQuestionContent,
  sfvQuestionText,
  sfvReadonlyAnswer,
  sfvSection,
  sfvSectionDescription,
  sfvSectionHeader,
  sfvSectionTitle,
} from "./hope-dialog-styles";
import { formatDate } from "./hope-format";
import { CmsCode } from "./hope-workspace-ui";

/** The part of a workspace item the review reads. */
interface ReviewItem {
  readonly itemCode: string;
  readonly label: string;
  readonly value: unknown;
  readonly options: ReadonlyArray<{ readonly valueCode: string; readonly label: string }>;
}

export function ReviewSfvDialog(props: {
  items: readonly ReviewItem[];
  onClose: () => void;
}): JSX.Element {
  const { items, onClose } = props;
  const completedDate = items.find((item) => item.itemCode === "J2052B")?.value;
  const questions = items.filter((item) => /^J2053[A-H]$/.test(item.itemCode));

  return (
    // Nothing here can be lost, so the backdrop closes it as well as Escape.
    <Modal open onClose={onClose} ariaLabel="SFV details" width="51.25rem">
      <div style={sfvDialogFrame}>
        <header style={sfvModalHeader}>
          <div style={sfvModalHeaderText}>
            <div style={sfvModalEyebrow}>Symptom Follow-Up Visit</div>
            <h2 style={sfvModalTitle}>SFV details</h2>
            <p style={sfvModalDescription}>Review the completed symptom follow-up visit.</p>
          </div>
          <button type="button" aria-label="Close" style={sfvCloseButton} onClick={onClose}>
            ×
          </button>
        </header>

        <section style={sfvModalBody} aria-label="Visit details and recorded answers">
          <section style={sfvSection}>
            <div style={sfvSectionHeader}>
              <div>
                <h3 style={sfvSectionTitle}>Visit details</h3>
                <p style={sfvSectionDescription}>Recorded information for this completed SFV.</p>
              </div>
              <StatusPill label="Completed" tone="success" />
            </div>
            <div style={sfvDetailsGrid}>
              <div style={sfvField}>
                <span style={sfvFieldLabel}>SFV date</span>
                <div style={sfvReadonlyAnswer}>
                  {completedDate ? formatDate(String(completedDate)) : "—"}
                </div>
              </div>
              <div style={sfvField}>
                <span style={sfvFieldLabel}>Status</span>
                <div style={sfvReadonlyAnswer}>Completed</div>
              </div>
            </div>
          </section>

          <section style={sfvSection}>
            <div style={sfvSectionHeader}>
              <div>
                <h3 style={sfvSectionTitle}>Symptom impact reassessment</h3>
                <p style={sfvSectionDescription}>Responses recorded during the follow-up visit.</p>
              </div>
            </div>
            <div style={sfvAnswersGrid}>
              {questions.map((item, index) => {
                const value = String(item.value ?? "");
                const option = item.options.find((row) => row.valueCode === value);
                return (
                  <div key={item.itemCode} style={sfvAnswerCard}>
                    <div style={sfvAnswerCardHeader}>
                      <span style={sfvAnswerNumber}>{index + 1}</span>
                      <div style={sfvQuestionContent}>
                        <strong style={sfvQuestionText}>{item.label}</strong>
                      </div>
                      <CmsCode code={item.itemCode} />
                    </div>
                    <div style={sfvReadonlyAnswer}>{option?.label || value || "—"}</div>
                  </div>
                );
              })}
            </div>
          </section>
        </section>

        <footer style={sfvModalFooter}>
          <div />
          <div style={sfvFooterActions}>
            <button type="button" style={secondaryButton} onClick={onClose}>
              Close
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
