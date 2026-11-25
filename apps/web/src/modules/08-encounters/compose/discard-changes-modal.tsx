// apps/web/src/modules/08-encounters/compose — the "Leave without saving?" dialog the composer shows when a navigation is blocked (moved out
// of encounter-compose.tsx unchanged).
import { Button, Modal } from "@chartwarden/ui";
import type { JSX } from "react";
import {
  discardActions,
  discardDialog,
  discardText,
  discardTitle,
} from "../encounter-compose-styles";

export interface DiscardChangesModalProps {
  readonly open: boolean;
  /** A save is in flight: the note cannot be left until it ends. */
  readonly busy: boolean;
  /** Nothing but a typed late-entry reason would be lost: the note itself is saved. */
  readonly lateReasonOnly?: boolean;
  readonly onKeepEditing: () => void;
  readonly onDiscard: () => void;
}

export function DiscardChangesModal({
  open,
  busy,
  lateReasonOnly = false,
  onKeepEditing,
  onDiscard,
}: DiscardChangesModalProps): JSX.Element {
  return (
    <Modal open={open} role="alertdialog" ariaLabel="Leave without saving?" dismissOnScrim={false}>
      <div style={discardDialog}>
        <h2 style={discardTitle}>Leave without saving?</h2>
        <p style={discardText}>
          {busy
            ? "Your visit note is being saved. Wait for the operation to finish before leaving."
            : lateReasonOnly
              ? "Your late-entry reason has not been sent. Keep editing or discard it before leaving."
              : "Your visit-note changes have not been saved. Keep editing or discard them before leaving."}
        </p>
        <footer style={discardActions}>
          <Button tone="tertiary" onClick={onKeepEditing}>
            Keep editing
          </Button>
          {!busy ? <Button onClick={onDiscard}>Discard changes</Button> : null}
        </footer>
      </div>
    </Modal>
  );
}
