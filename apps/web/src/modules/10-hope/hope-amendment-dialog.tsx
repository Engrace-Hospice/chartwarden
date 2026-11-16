// apps/web/src/modules/10-hope — the dialog that amends a signed record: it creates a correction draft, or a CMS
// inactivation draft, from a reason and the discipline the clinician records it as. On the kit Modal: focus in (on the
// reason), Tab trapped, Escape cancels. The scrim never dismisses: a typed reason must not be lost to a stray click. Escape
// (the kit's behaviour) does cancel with a reason typed and without asking: a confirm here would be one more thing to
// dismiss in a dialog whose only other exit is Cancel, so it is left as the kit has it.
//
// `busy` lasts while a request is outstanding. The screen bounds that (`withRequestTimeout`: a request nobody answers ends as
// "could not confirm" after `REQUEST_TIMEOUT_MS`), so the dialog cannot stay shut for good; a failure is shown here, in the
// dialog, with the typed reason kept, and takes focus (`useFocusOnNewError`) so Escape and Tab keep working.
//
// The discipline is the caller's own (the server refuses an attribution that is not one of the acting user's roles, 403
// M10_DISCIPLINE_NOT_PERMITTED): one is preselected, two or more make the clinician choose, none blocks the write.
import { Modal } from "@chartwarden/ui";
import { useState } from "react";
import type { CSSProperties, JSX } from "react";
import type { SfvAuthorDiscipline } from "./hope-api";
import { AuthorDisciplineField } from "./hope-author-discipline-field";
import {
  actionRow,
  dangerButton,
  fieldLabel,
  modalTitle,
  muted,
  primaryButton,
  secondaryButton,
  signDialogBody,
  signDialogError,
  textareaField,
} from "./hope-dialog-styles";
import { useFocusOnNewError } from "./use-focus-on-new-error";

export type AmendmentKind = "correction" | "inactivation";

interface AmendmentCopy {
  readonly title: (recordLabel: string) => string;
  readonly description: string;
  readonly submit: string;
  readonly submitting: string;
  readonly noneMessage: string;
  readonly submitStyle: CSSProperties;
}

const COPY: Record<AmendmentKind, AmendmentCopy> = {
  inactivation: {
    title: (recordLabel) => `Inactivate ${recordLabel}`,
    description:
      "This creates a CMS inactivation draft for the selected signed record. The original remains current until the inactivation draft is signed.",
    submit: "Create inactivation",
    submitting: "Creating...",
    noneMessage:
      "Your role cannot author an inactivation of this record. Ask a registered nurse, nurse practitioner or physician to create it.",
    submitStyle: dangerButton,
  },
  correction: {
    title: (recordLabel) => `Correct ${recordLabel}`,
    description:
      "This creates a correction draft from the selected signed record, to be reviewed and signed.",
    submit: "Create correction draft",
    submitting: "Creating...",
    noneMessage:
      "Your role cannot author a correction of this record. Ask a registered nurse, nurse practitioner or physician to create it.",
    submitStyle: primaryButton,
  },
};

export function AmendmentDialog(props: {
  kind: AmendmentKind;
  busy: boolean;
  /** Why the last attempt failed, PHI-free; shown in the dialog so the reason typed is not lost behind a message. */
  error: string | null;
  recordLabel: string;
  /** The caller's own disciplines for this write (`authorDisciplinesForRoles`). */
  disciplines: readonly SfvAuthorDiscipline[];
  onCancel: () => void;
  onSubmit: (reason: string, discipline: SfvAuthorDiscipline) => void;
}): JSX.Element {
  const copy = COPY[props.kind];
  const [reason, setReason] = useState("");
  const [discipline, setDiscipline] = useState<SfvAuthorDiscipline | "">(
    props.disciplines.length === 1 ? (props.disciplines[0] ?? "") : "",
  );
  const alertRef = useFocusOnNewError<HTMLParagraphElement>(props.error);
  const trimmed = reason.trim();
  return (
    <Modal
      open
      onClose={props.busy ? undefined : props.onCancel}
      dismissOnScrim={false}
      ariaLabel={copy.title(props.recordLabel)}
      width="27.5rem"
    >
      <div style={signDialogBody}>
        <h2 style={modalTitle}>{copy.title(props.recordLabel)}</h2>
        <p style={muted}>{copy.description}</p>
        <label style={fieldLabel}>
          Reason
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            maxLength={2000}
            style={textareaField}
          />
        </label>
        <div style={{ marginTop: "1rem" }}>
          <AuthorDisciplineField
            disciplines={props.disciplines}
            value={discipline}
            onChange={setDiscipline}
            disabled={props.busy}
            noneMessage={copy.noneMessage}
          />
        </div>
        {props.error ? (
          <p ref={alertRef} tabIndex={-1} role="alert" style={signDialogError}>
            {props.error}
          </p>
        ) : null}
        <div style={actionRow}>
          <button
            type="button"
            style={secondaryButton}
            disabled={props.busy}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            style={copy.submitStyle}
            disabled={props.busy || trimmed.length === 0 || discipline === ""}
            onClick={() => {
              if (discipline !== "") props.onSubmit(trimmed, discipline);
            }}
          >
            {props.busy ? copy.submitting : copy.submit}
          </button>
        </div>
      </div>
    </Modal>
  );
}
