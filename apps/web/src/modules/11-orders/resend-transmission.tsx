import { Button, InlineAlert, Modal, Panel, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/11-orders — the order detail's "Resend transmission" action (M11 F-182). A lab order whose HL7
// request was REFUSED before any message was built (`orm_refused:*` / `dispatch_refused:*`) never reaches the Held
// Transmissions list — nothing was sent, so there is nothing for the lab to have — and the remedy is: fix the missing
// fact (the patient's sex, the physician's NPI, the lab interface…), then re-run the producer. This is that re-run.
// It is OFFERED only when the server's `allowedActions.resend_transmission` says so (a resendable state AND
// `orders.transmission.recover`); the route decides again on the POST, and its refusal is shown as the server wrote it.
import { useState } from "react";
import type { JSX } from "react";
import {
  type ResendOutcome,
  resendOutcomeMessage,
  resendTransmission,
  transmissionFailureLabel,
} from "./resend-transmission-api";

export interface ResendTransmissionProps {
  readonly orderId: string;
  /** The server's failure token; `null` when the reader may not see it. */
  readonly failureReason: string | null;
  /** A resend the server accepted (either outcome). The detail keeps the message and re-reads the order. */
  readonly onResent: (outcome: ResendOutcome) => void;
}

/** The "Lab transmission" action group inside the order detail's "Available actions" panel. */
export function ResendTransmission({
  orderId,
  failureReason,
  onResent,
}: ResendTransmissionProps): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title="Lab transmission"
      icon="send"
      description={
        failureReason ? transmissionFailureLabel(failureReason) : "The lab request was not sent."
      }
      action={
        <Button tone="secondary" size="sm" onClick={() => setOpen(true)}>
          Resend transmission
        </Button>
      }
    >
      <p className="wx-source-line">
        Fix the missing information first, then resend the request to the lab interface.
      </p>
      {open ? (
        <ResendTransmissionModal
          orderId={orderId}
          onClose={() => setOpen(false)}
          onResent={(outcome) => {
            setOpen(false);
            onResent(outcome);
          }}
        />
      ) : null}
    </Panel>
  );
}

/** The outcome banner the detail shows after a resend — it outlives the action group, which a re-read may remove. */
export function ResendResult({ outcome }: { readonly outcome: ResendOutcome }): JSX.Element {
  const message = resendOutcomeMessage(outcome);
  return <InlineAlert tone={message.tone}>{message.text}</InlineAlert>;
}

interface ResendTransmissionModalProps {
  readonly orderId: string;
  readonly onClose: () => void;
  readonly onResent: (outcome: ResendOutcome) => void;
}

function ResendTransmissionModal({
  orderId,
  onClose,
  onResent,
}: ResendTransmissionModalProps): JSX.Element {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await resendTransmission(client, orderId);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onResent(res.value);
  }

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      ariaLabel="Resend lab transmission"
      width="30rem"
    >
      <div className="wx-modal-body">
        <h2>Resend lab transmission</h2>
        <p>
          The lab request for this signed order was refused before anything was sent, so the lab has
          no copy of it. Resending re-checks the order's facts and, if they are now complete, sends
          the request once.
        </p>
        <p className="wx-source-line">
          If the information is still missing, nothing is sent and the order stays failed.
        </p>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <div className="wx-modal-actions">
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} disabled={busy} onClick={() => void submit()}>
            Resend now
          </Button>
        </div>
      </div>
    </Modal>
  );
}
