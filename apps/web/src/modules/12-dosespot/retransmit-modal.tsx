import { Button, InlineAlert, Modal, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/12-dosespot — the Retransmit confirmation (GAP-125; spec CHARTWARDEN_UI_DOSESPOT_TRANSMIT_QUEUE.md
// "Retry a transmission_failed order (creates a new medication_order with replaces_medication_order_id set — never an
// in-place retransmit)"). The server decides who may (prescribing.sign + the sign standing rule); a refusal is shown here
// as a user-facing sentence keyed on its error code (retransmitErrorMessage), never as the raw server string.
import { useState } from "react";
import type { JSX } from "react";
import { retransmitOrder } from "./medications-api";

/** User-facing copy for the retransmit refusals a signer can actually hit, keyed on the envelope's `code`. */
const RETRANSMIT_ERROR_COPY: Readonly<Record<string, string>> = {
  SIGNER_NOT_ORDERING_PHYSICIAN:
    "Only this order's prescriber or its named ordering physician can retransmit it. Ask them to retransmit, or sign in as them.",
  SIGNER_NOT_ELIGIBLE:
    "Your discipline can't sign medication orders, so you can't retransmit this one.",
};

/** Capitalise the first letter and end with a full stop, so a raw server message still reads as a sentence. */
function toSentence(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) return "The order could not be retransmitted.";
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** The message the modal shows for a failed retransmit: known codes get fixed copy, anything else is sentence-cased. */
export function retransmitErrorMessage(code: string | null, message: string): string {
  const known = code ? RETRANSMIT_ERROR_COPY[code] : undefined;
  return known ?? toSentence(message);
}

export interface RetransmitModalProps {
  readonly orderId: string;
  readonly onClose: () => void;
  readonly onCreated: (newOrderId: string) => void;
}

export function RetransmitModal({
  orderId,
  onClose,
  onCreated,
}: RetransmitModalProps): JSX.Element {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await retransmitOrder(client, orderId);
    setBusy(false);
    if (!res.ok) {
      setError(retransmitErrorMessage(res.code, res.message));
      return;
    }
    onCreated(res.value.newOrderId);
  }

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      ariaLabel="Retransmit medication order"
      width="30rem"
    >
      <div className="wx-modal-body">
        <h2>Retransmit medication order</h2>
        <p>
          DoseSpot did not accept this prescription. Retransmitting creates a replacement order that
          corrects this one; you then send it for signature and sign it, and it is transmitted
          again. This order is kept unchanged as history.
        </p>
        <p className="wx-source-line">
          Only the order's prescriber or the named ordering physician may retransmit it.
        </p>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <div className="wx-modal-actions">
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} disabled={busy} onClick={() => void submit()}>
            Create replacement
          </Button>
        </div>
      </div>
    </Modal>
  );
}
