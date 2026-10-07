import { Button, InlineAlert, Modal, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/12-dosespot — the Retransmit confirmation (GAP-125; spec WARDENX_UI_DOSESPOT_TRANSMIT_QUEUE.md
// "Retry a transmission_failed order (creates a new medication_order with replaces_medication_order_id set — never an
// in-place retransmit)"). The server decides who may (prescribing.sign + the sign standing rule); a refusal is shown here
// verbatim from the error envelope.
import { useState } from "react";
import type { JSX } from "react";
import { retransmitOrder } from "./medications-api";

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
      setError(res.message);
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
