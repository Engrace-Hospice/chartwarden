// apps/web/src/modules/10-hope — the fixed parts of the SFV completion dialog: header, visit details, the status
// area between the scrolling body and the footer (a refusal, or the discard question), the footer and the close
// control. Presentational: the dialog owns the state and passes it in.
import { t } from "@chartwarden/ui";
import type { JSX, RefObject } from "react";
import { useEffect, useId, useRef } from "react";
import { AuthorDisciplineField } from "./hope-author-discipline-field";
import {
  primaryButton,
  secondaryButton,
  sfvCloseCorner,
  sfvConfirmBox,
  sfvDetailsGrid,
  sfvDisabledButton,
  sfvErrorBox,
  sfvField,
  sfvFieldLabel,
  sfvFooterActions,
  sfvFooterStatus,
  sfvInput,
  sfvModalDescription,
  sfvModalEyebrow,
  sfvModalFooter,
  sfvModalHeaderText,
  sfvModalHeaderWithClose,
  sfvModalTitle,
  sfvPendingText,
  sfvPermissionErrorBox,
  sfvReadyText,
  sfvSection,
  sfvSectionDescription,
  sfvSectionHeader,
  sfvSectionTitle,
  sfvStatusSlot,
  srOnly,
} from "./hope-dialog-styles";
import type { SfvError } from "./hope-sfv-errors";
import type { SfvForm } from "./hope-sfv-form";

export function SfvDialogHeader(): JSX.Element {
  return (
    <header style={sfvModalHeaderWithClose}>
      <div style={sfvModalHeaderText}>
        <div style={sfvModalEyebrow}>Symptom Follow-Up Visit</div>
        <h2 style={sfvModalTitle}>Complete SFV</h2>
        <p style={sfvModalDescription}>
          Record the visit details and complete the symptom impact reassessment.
        </p>
      </div>
    </header>
  );
}

/** Closes the dialog. Last in the DOM so the first focus lands on a field, not on a control one keypress would use. */
export function SfvCloseControl(props: {
  disabled: boolean;
  onClose: (trigger: HTMLElement) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Close"
      style={sfvCloseCorner}
      disabled={props.disabled}
      onClick={(event) => props.onClose(event.currentTarget)}
    >
      ×
    </button>
  );
}

export function SfvVisitDetails(props: { form: SfvForm; saving: boolean }): JSX.Element {
  const { form, saving } = props;
  return (
    <section style={sfvSection}>
      <div style={sfvSectionHeader}>
        <div>
          <h3 style={sfvSectionTitle}>Visit details</h3>
          <p style={sfvSectionDescription}>
            Confirm when the SFV was completed and by which discipline.
          </p>
        </div>
      </div>

      <div style={sfvDetailsGrid}>
        <label style={sfvField}>
          <span style={sfvFieldLabel}>SFV date</span>
          <input
            type="date"
            value={form.date}
            style={sfvInput}
            disabled={saving}
            onChange={(event) => form.setDate(event.target.value)}
          />
        </label>
        <DisciplineField form={form} saving={saving} />
      </div>
    </section>
  );
}

function DisciplineField({ form, saving }: { form: SfvForm; saving: boolean }): JSX.Element {
  return (
    <AuthorDisciplineField
      disciplines={form.authorRoles}
      value={form.discipline}
      onChange={form.setDiscipline}
      disabled={saving}
      noneMessage="Your role cannot author a symptom follow-up visit. Ask a registered nurse, nurse practitioner or licensed practical or vocational nurse to complete it."
    />
  );
}

/** A refusal, or the answer to "close with entered answers?". Both sit above the footer, never in the scrolling body. */
export function SfvDialogStatus(props: {
  error: SfvError | null;
  /** The error appeared after the dialog opened (a failed submit), so it takes focus; one known at open does not. */
  errorTakesFocus: boolean;
  confirmingDiscard: boolean;
  /** Where focus goes back to when nothing had it as the question opened (a mouse click in Safari focuses nothing). */
  closeTrigger: RefObject<HTMLElement | null>;
  onKeepEditing: () => void;
  onDiscard: () => void;
}): JSX.Element {
  return (
    <>
      {props.error ? <SfvErrorAlert error={props.error} takeFocus={props.errorTakesFocus} /> : null}
      {props.confirmingDiscard ? (
        <SfvDiscardConfirm
          closeTrigger={props.closeTrigger}
          onKeepEditing={props.onKeepEditing}
          onDiscard={props.onDiscard}
        />
      ) : null}
    </>
  );
}

/**
 * A failed submit takes focus (the button that was pressed is disabled while saving, so focus would otherwise fall to the
 * page). An error already known when the dialog opens does not: the role announces it, and the kit's own first focus
 * stands, the same as in the Sign dialog.
 */
function SfvErrorAlert({ error, takeFocus }: { error: SfvError; takeFocus: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (takeFocus) ref.current?.focus();
  }, [takeFocus]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      style={{
        ...sfvErrorBox,
        ...sfvStatusSlot,
        ...(error.warning ? sfvPermissionErrorBox : null),
      }}
    >
      <strong style={{ color: error.warning ? t.warning : t.error }}>{error.title}</strong>
      <span>{error.message}</span>
    </div>
  );
}

const DISCARD_QUESTION = "Discard the answers you entered?";

function SfvDiscardConfirm(props: {
  closeTrigger: RefObject<HTMLElement | null>;
  onKeepEditing: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const keepRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const { closeTrigger } = props;
  useEffect(() => {
    const before = document.activeElement;
    keepRef.current?.focus();
    // Keep editing puts focus back where it was (Discard closes the dialog, which restores its own). When nothing
    // had focus (Safari does not focus a button a mouse clicks), it goes back to the control that asked to close.
    return () => {
      const target =
        before instanceof HTMLElement && before !== document.body ? before : closeTrigger.current;
      if (target?.isConnected) target.focus();
    };
  }, [closeTrigger]);
  return (
    <section aria-label={DISCARD_QUESTION} style={sfvConfirmBox}>
      <strong>{DISCARD_QUESTION}</strong>
      <span id={hintId} style={srOnly}>
        Closing now loses what you entered; Keep editing returns to the form.
      </span>
      <span style={sfvFooterActions}>
        <button
          type="button"
          ref={keepRef}
          aria-describedby={hintId}
          style={secondaryButton}
          onClick={props.onKeepEditing}
        >
          Keep editing
        </button>
        <button type="button" style={secondaryButton} onClick={props.onDiscard}>
          Discard
        </button>
      </span>
    </section>
  );
}

export function SfvDialogFooter(props: {
  /** What is still missing (or rules another attempt out). Empty: Complete SFV is enabled. */
  blockers: readonly string[];
  saving: boolean;
  onCancel: (trigger: HTMLElement) => void;
  onSubmit: () => void;
}): JSX.Element {
  const { blockers, saving } = props;
  const ready = blockers.length === 0;
  const hintId = useId();
  return (
    <footer style={sfvModalFooter}>
      {/* A disabled button cannot be focused, so what it is waiting for is plain text the button points at. */}
      <div id={hintId} style={sfvFooterStatus}>
        {ready ? (
          <span style={sfvReadyText}>Ready to complete.</span>
        ) : (
          <span style={sfvPendingText}>To complete: {blockers.join(", ")}.</span>
        )}
      </div>

      <div style={sfvFooterActions}>
        <button
          type="button"
          style={secondaryButton}
          disabled={saving}
          onClick={(event) => props.onCancel(event.currentTarget)}
        >
          Cancel
        </button>
        <button
          type="button"
          aria-describedby={hintId}
          style={{ ...primaryButton, ...(!ready ? sfvDisabledButton : null) }}
          disabled={saving || !ready}
          onClick={props.onSubmit}
        >
          {saving ? "Completing..." : "Complete SFV"}
        </button>
      </div>
    </footer>
  );
}
