// A confirmation or signing ceremony as a focus-trapped modal (DESIGN.md §7.4): the kit `Modal` with the title, the
// fields, Cancel and the save action. The same props as `FormDrawer`, so a screen picks the one the act needs: a plain
// record form is a drawer beside its list; an attestation, a sign-off, an irreversible transition or an audited read
// is this modal, which blocks the page until it is answered. While a write is in flight it cannot be dismissed
// (Cancel, Escape): closing it would orphan the request and its outcome. The scrim never dismisses it, so a click
// outside cannot discard what was typed. The modal blocks the page itself, so nothing goes inert.
import { Button, InlineAlert, Modal } from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";

export function FormModal({
  title,
  busy,
  onClose,
  save,
  error,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  /** The primary action; the modal adds Cancel before it. */
  save: ReactNode;
  /** A failed write's refusal, announced in the modal beside the actions. */
  error?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      dismissOnScrim={false}
      ariaLabel={title}
      width="34rem"
    >
      <div className="wx-modal-body">
        <h2>{title}</h2>
        {children}
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <div className="wx-modal-actions">
          <Button tone="secondary" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {save}
        </div>
      </div>
    </Modal>
  );
}
