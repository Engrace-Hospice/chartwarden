import {
  Button,
  InlineAlert,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  stepUpPath,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/12-dosespot — an administrator resolves an order HELD for an unconfirmed DoseSpot outcome (review of slice 4, MEDIUM-1).
// POST /api/v1/medication-orders/:id/resolve-held-transmission (`prescribing.clinic.admin` + a fresh step-up). The administrator checks the
// prescriber's DoseSpot account and says SENT (entering DoseSpot's prescription id) or NOT SENT (the prescriber retransmits). Nothing is
// sent by this action. The server decides everything; a refusal is shown as a sentence keyed on its code. A missing fresh step-up goes to the
// step-up ceremony and back (the typed text is not kept: it can name a patient).
import { useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { resolveHeldTransmission } from "./medications-api";

const MIN_REASON = 10;

const ERROR_COPY: Readonly<Record<string, string>> = {
  DOSESPOT_TRANSMISSION_NOT_HELD:
    "This order is no longer held (someone may have resolved it already). Reload the page.",
  DOSESPOT_PRESCRIPTION_ID_REQUIRED: "Enter the DoseSpot prescription id you found.",
  DOSESPOT_PRESCRIPTION_ID_UNEXPECTED: "A prescription id belongs to an order that was sent.",
};

const OUTCOMES = [
  ["not_sent", "It was NOT sent: the prescription is not in DoseSpot"],
  ["sent", "It WAS sent: the prescription is in DoseSpot"],
] as const;

export interface HeldTransmissionModalProps {
  readonly orderId: string;
  readonly onClose: () => void;
  readonly onResolved: () => void;
}

export function HeldTransmissionModal({
  orderId,
  onClose,
  onResolved,
}: HeldTransmissionModalProps): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [outcome, setOutcome] = useState<"sent" | "not_sent">("not_sent");
  const [prescriptionId, setPrescriptionId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sent = outcome === "sent";
  const blocked = reason.trim().length < MIN_REASON || (sent && prescriptionId.trim() === "");

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await resolveHeldTransmission(client, orderId, {
      outcome,
      reason: reason.trim(),
      ...(sent ? { dosespotPrescriptionId: prescriptionId.trim() } : {}),
    });
    setBusy(false);
    if (res.ok) {
      onResolved();
      return;
    }
    if (res.code === "STEP_UP_REQUIRED") {
      navigate(stepUpPath(`${location.pathname}${location.search}`));
      return;
    }
    setError((res.code ? ERROR_COPY[res.code] : undefined) ?? res.message);
  }

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      ariaLabel="Resolve held transmission"
      width="32rem"
    >
      <div className="wx-modal-body">
        <h2>Resolve held transmission</h2>
        <p>
          DoseSpot accepted this prescription request but its answer could not be read, so it may
          already exist there. Check the prescriber's DoseSpot account, then say which it was.
          Nothing is sent by this action.
        </p>
        <SelectField
          label="What you found"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as "sent" | "not_sent")}
          options={OUTCOMES.map(([value, label]) => ({ value, label }))}
        />
        {sent ? (
          <TextField
            label="DoseSpot prescription id"
            value={prescriptionId}
            onChange={(e) => setPrescriptionId(e.target.value)}
          />
        ) : (
          <p className="wx-source-line">
            The order becomes a failed transmission; the prescriber then retransmits it (a
            replacement order they sign). It is not put back on the queue.
          </p>
        )}
        <TextAreaField
          label="What you checked (at least 10 characters; do not enter patient details)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
        />
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <div className="wx-modal-actions">
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} disabled={busy || blocked} onClick={() => void submit()}>
            Resolve
          </Button>
        </div>
      </div>
    </Modal>
  );
}
