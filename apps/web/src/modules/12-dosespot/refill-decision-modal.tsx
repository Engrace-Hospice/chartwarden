import {
  Button,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/12-dosespot — the §2.7 refill decision (#91).
//
// The Refill Inbox and its detail are a QUEUE and a DETAIL for a decision neither of them could make.
// A pharmacy's refill request sat in a list a prescriber could read and not answer, while the §2.7 SLA
// clock the inbox displays counted down against them.
//
// WHAT THE SERVER OWNS. The per-DEA-schedule refill cap (`scheduleIiMaxRefills` /
// `scheduleIiiToVMaxRefills` in the controlled-substance policy) is enforced server-side; an approval
// over the cap is refused with a 422 and the message names it. This modal does not read the policy to
// pre-check, because the cap that applies depends on the SOURCE ORDER's schedule and the server is
// the one holding it.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { approveRefill, denyRefill } from "./medications-api";

/** How the decision reaches the pharmacy. The server's own vocabulary. */
const CHANNELS = [
  ["dosespot", "DoseSpot (electronic)"],
  ["fax", "Fax"],
  ["phone", "Phone"],
] as const;

export interface RefillDecisionModalProps {
  readonly open: boolean;
  readonly decision: "approve" | "deny";
  readonly refillId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function RefillDecisionModal({
  open,
  decision,
  refillId,
  onClose,
  onDone,
}: RefillDecisionModalProps): JSX.Element | null {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refills, setRefills] = useState("1");
  const [reason, setReason] = useState("");
  const [channel, setChannel] = useState<string>("dosespot");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setRefills("1");
    setReason("");
    setNotes("");
    setChannel("dosespot");
  }, [open]);

  if (!open) return null;

  const approving = decision === "approve";
  const blocked = approving ? !(Number(refills) >= 0) : reason.trim().length === 0;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = approving
      ? await approveRefill(client, refillId, {
          refillsAuthorized: Number(refills),
          responseChannel: channel,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        } as Parameters<typeof approveRefill>[2])
      : await denyRefill(client, refillId, {
          denialReason: reason.trim(),
          responseChannel: channel,
        } as Parameters<typeof denyRefill>[2]);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={approving ? "Approve refill" : "Deny refill"}
      width="28rem"
      accent={approving ? "primary" : "alert"}
    >
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        <h2 style={title}>{approving ? "Approve refill" : "Deny refill"}</h2>

        {approving ? (
          <>
            <TextField
              label="Refills authorised"
              value={refills}
              onChange={(e) => setRefills(e.target.value)}
            />
            <p style={meta}>
              The per-schedule cap is enforced by the server against the source order's DEA schedule
              — an approval over it is refused and says so.
            </p>
          </>
        ) : (
          <TextAreaField
            label="Reason (sent to the pharmacy)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
        )}

        <SelectField
          label="Respond via"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          options={CHANNELS.map(([value, label]) => ({ value, label }))}
        />

        {approving ? (
          <TextAreaField
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone={approving ? "primary" : "danger"}
            onClick={() => void submit()}
            disabled={busy || blocked}
          >
            {busy ? "Working…" : approving ? "Approve" : "Deny"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const title = { margin: 0, fontSize: "1.05rem", fontWeight: 600 } as const;
const meta = { margin: 0, fontSize: "0.75rem", color: "var(--color-on-surface-variant)" } as const;
const errorText = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" } as const;
