// apps/web/src/modules/10-hope — the dialog that signs a HOPE timepoint (R-05).
import { HOPE_SIGN_ATTESTATION_STATEMENT } from "@chartwarden/types";
import { Modal } from "@chartwarden/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { HopeAttestation } from "./hope-attestation";
import {
  actionRow,
  modalStats,
  modalTitle,
  muted,
  primaryButton,
  secondaryButton,
  sfvPendingText,
  sfvReadyText,
  signDialogBody,
  signDialogError,
} from "./hope-dialog-styles";

/** The part of the workspace's review model the dialog shows and gates on. */
interface SignReview {
  readonly validation: { readonly warningCount: number; readonly errorCount: number };
  readonly readiness: { readonly readyToSign: boolean };
}

export function SignDialog(props: {
  review: SignReview | null;
  title: string;
  signing: boolean;
  /** The server's refusal of the last attempt, shown here so a failed sign is never silent. */
  error: string | null;
  /** The attestation wording this page shows is out of date: another attempt would only be refused again. */
  wordingChanged: boolean;
  onCancel: () => void;
  onSign: () => void;
}): JSX.Element {
  // Mounted only while open, so every opening starts un-attested.
  const [attested, setAttested] = useState(false);
  const hintId = useId();
  // What stands between the signer and the signature, as text the (focus-less, when disabled) button points at.
  const blockers = [
    ...(props.wordingChanged ? ["reload the page to review the new attestation wording"] : []),
    ...(props.review?.readiness.readyToSign ? [] : ["resolve the blocking items in the review"]),
    ...(attested ? [] : ["tick the attestation"]),
  ];
  // The Sign button is disabled while signing, which drops focus; a refusal takes it, so Escape and Tab keep working.
  // An error already known when the dialog opens is announced by its role but does not take focus from the kit's first
  // focus (the attestation checkbox), the same as in the completion dialog.
  const alertRef = useRef<HTMLParagraphElement>(null);
  const errorAtOpen = useRef(props.error);
  useEffect(() => {
    if (props.error && props.error !== errorAtOpen.current) alertRef.current?.focus();
  }, [props.error]);
  return (
    // The kit Modal moves focus in, traps Tab, restores focus on close and closes on Escape. A signature in flight
    // passes no onClose (and Cancel is disabled), so the refusal that follows is always shown, never lost behind a
    // closed dialog; the scrim never dismisses.
    <Modal
      open
      onClose={props.signing ? undefined : props.onCancel}
      dismissOnScrim={false}
      ariaLabel={props.title}
      width="27.5rem"
    >
      <div style={signDialogBody}>
        <h2 style={modalTitle}>{props.title}</h2>
        <p style={muted}>Signing finalizes this HOPE record.</p>
        <div style={modalStats}>
          <span>Warnings: {props.review?.validation.warningCount ?? 0}</span>
          <span>Errors: {props.review?.validation.errorCount ?? 0}</span>
        </div>
        <HopeAttestation
          checked={attested}
          onChange={setAttested}
          statement={HOPE_SIGN_ATTESTATION_STATEMENT}
          disabled={props.signing}
        />
        {props.error ? (
          <p ref={alertRef} tabIndex={-1} role="alert" style={signDialogError}>
            {props.error}
          </p>
        ) : null}
        {blockers.length === 0 ? (
          <p id={hintId} style={{ ...muted, ...sfvReadyText }}>
            Ready to sign.
          </p>
        ) : (
          <p id={hintId} style={{ ...muted, ...sfvPendingText }}>
            To sign: {blockers.join(", ")}.
          </p>
        )}
        <div style={actionRow}>
          <button
            type="button"
            style={secondaryButton}
            disabled={props.signing}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            aria-describedby={hintId}
            style={primaryButton}
            disabled={props.signing || blockers.length > 0}
            onClick={props.onSign}
          >
            {props.signing ? "Signing..." : "Sign & complete"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
